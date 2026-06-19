# Unified Step-Confirmation Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the redundant interview `ask_user` confirmation with a single, richer step-confirmation card that summarizes what was decided, tucks scores into an expandable dropdown, and offers Continue + Revise.

**Architecture:** The `{block, scoring, finishedAt}` completion stash already persisted at confirmation pause is read at projection time (mirroring `enrichStepResult`) to build a structured `confirmationSummary` — no DB migration for the card data. The Revise flow posts an orchestrator chat message carrying a `pendingRevision` marker (a new nullable column on `orchestrator_messages`); the composer reroutes the user's next message to a deterministic revise endpoint that relays feedback to the still-alive step agent.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), better-sqlite3, Fastify (`@orca/daemon`), React + Vitest + Testing Library (`@orca/desktop`).

## Global Constraints

- Package manager: `pnpm` (workspaces). Run a single package's tests with `pnpm --filter <name> exec vitest run <path>`.
- Contracts package: `@orca/contracts`; daemon: `@orca/daemon`; desktop: `@orca/desktop`.
- All Zod object schemas in `@orca/contracts` use `.strict()`.
- Conventional Commits for commit messages.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- The branch is `feat/honest-orchestrator-surface`; the Brainstorm template is at unreleased `version: 3` on this branch — do NOT bump the version for the catalog edit.

---

### Task 1: Contracts — `ConfirmationSummary` on `Activity`

**Files:**
- Modify: `packages/contracts/src/index.ts` (near `Activity`, ~line 1200; import `StepResultScoringProposal` from `./workflows/index.js` is already re-exported via the package — confirm it is in scope in this file)
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces: `ConfirmationSummary` Zod schema + type; `Activity.confirmationSummary?: ConfirmationSummary`.
  ```ts
  type ConfirmationSummary = {
    lead: string;
    fields: Array<{ label: string; value: string | string[] }>;
    scoring: StepResultScoringProposal | null;
  };
  ```

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/index.test.ts`:
```ts
import { Activity, ConfirmationSummary } from "./index.js";

describe("ConfirmationSummary", () => {
  it("accepts string and string[] field values and a nullable scoring", () => {
    const parsed = ConfirmationSummary.parse({
      lead: "The frame is complete.",
      fields: [
        { label: "Problem", value: "Users cannot rename workspaces." },
        { label: "Constraints", value: ["one folder = one workspace", "unique names"] },
      ],
      scoring: null,
    });
    expect(parsed.fields).toHaveLength(2);
  });

  it("rides on Activity as an optional field", () => {
    const base = {
      id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
      agentSessionId: null, turnOrdinal: 0, status: "paused_for_input",
      currentText: "x", finalSummary: null, sourceKind: "step_confirmation_pending",
      workCategory: null, confidence: null,
      createdAt: "2026-06-18T00:00:00.000Z", updatedAt: "2026-06-18T00:00:00.000Z",
      completedAt: null, steps: [],
      confirmationSummary: { lead: "ok", fields: [], scoring: null },
    };
    expect(Activity.parse(base).confirmationSummary?.lead).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts exec vitest run src/index.test.ts -t ConfirmationSummary`
Expected: FAIL — `ConfirmationSummary` is not exported.

- [ ] **Step 3: Implement minimal schema**

In `packages/contracts/src/index.ts`, immediately before `export const Activity = z`:
```ts
export const ConfirmationSummary = z
  .object({
    lead: z.string().max(4000),
    fields: z
      .array(
        z.object({
          label: z.string().min(1).max(128),
          value: z.union([z.string().max(4000), z.array(z.string().max(4000)).max(64)]),
        }).strict()
      )
      .max(32),
    scoring: StepResultScoringProposal.nullable(),
  })
  .strict();
export type ConfirmationSummary = z.infer<typeof ConfirmationSummary>;
```
Then add to the `Activity` object (after `stepResult: WorkflowStepResult.optional(),`):
```ts
    confirmationSummary: ConfirmationSummary.optional(),
```
If `StepResultScoringProposal` is not already imported/in scope in `index.ts`, add it to the existing `@orca/contracts` workflows re-export import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts exec vitest run src/index.test.ts -t ConfirmationSummary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): ConfirmationSummary on Activity"
```

---

### Task 2: Contracts — `PendingRevision` + `SubmitStepRevisionRequest`

**Files:**
- Modify: `packages/contracts/src/index.ts` (near `OrchestratorChatMessage`, ~line 1245)
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces: `PendingRevision = { workflowRunId: string }`; `OrchestratorChatMessage.pendingRevision?: PendingRevision`; `SubmitStepRevisionRequest = { feedback: string }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/index.test.ts`:
```ts
import { OrchestratorChatMessage, PendingRevision, SubmitStepRevisionRequest } from "./index.js";

describe("PendingRevision", () => {
  it("rides on OrchestratorChatMessage", () => {
    const msg = OrchestratorChatMessage.parse({
      id: "m1", goalId: "g1", role: "orchestrator", kind: "message",
      body: "What would you like to revise?", correlationId: null,
      createdAt: "2026-06-18T00:00:00.000Z",
      pendingRevision: { workflowRunId: "r1" },
    });
    expect(msg.pendingRevision?.workflowRunId).toBe("r1");
  });

  it("SubmitStepRevisionRequest requires non-empty feedback", () => {
    expect(SubmitStepRevisionRequest.safeParse({ feedback: "" }).success).toBe(false);
    expect(SubmitStepRevisionRequest.parse({ feedback: "tighten the success metric" }).feedback)
      .toBe("tighten the success metric");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts exec vitest run src/index.test.ts -t PendingRevision`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

In `packages/contracts/src/index.ts`, before `export const OrchestratorChatMessage = z`:
```ts
export const PendingRevision = z
  .object({ workflowRunId: z.string().min(1) })
  .strict();
export type PendingRevision = z.infer<typeof PendingRevision>;
```
Add to the `OrchestratorChatMessage` object (after `pendingApproval: PendingApproval.optional()` — add a comma to that line):
```ts
    pendingRevision: PendingRevision.optional()
```
Then, after the `ListOrchestratorMessagesResponse` block, add:
```ts
export const SubmitStepRevisionRequest = z
  .object({ feedback: z.string().min(1).max(4000) })
  .strict();
export type SubmitStepRevisionRequest = z.infer<typeof SubmitStepRevisionRequest>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts exec vitest run src/index.test.ts -t PendingRevision`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): pendingRevision marker + SubmitStepRevisionRequest"
```

---

### Task 3: Daemon — `buildConfirmationSummary` pure builder

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts`
- Test: `apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts`

**Interfaces:**
- Consumes: `WorkflowStepOutputSchema`, `StepResultScoringProposal` from `@orca/contracts`.
- Produces:
  ```ts
  function buildConfirmationSummary(
    outputSchema: WorkflowStepOutputSchema,
    block: unknown,
    scoring: StepResultScoringProposal | null,
    proposal: string | null
  ): ConfirmationSummaryT
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { buildConfirmationSummary } from "./confirmation-summary.js";

const schema: WorkflowStepOutputSchema = [
  { key: "problem", type: "string", required: true },
  { key: "success_outcome", type: "string", required: true },
  { key: "constraints", type: "array", itemType: "string", required: true },
  { key: "open_questions", type: "array", itemType: "string", required: false },
];

describe("buildConfirmationSummary", () => {
  it("renders humanized labels, skips empty/missing fields, leads with scoring.reason", () => {
    const out = buildConfirmationSummary(
      schema,
      { problem: "Can't rename workspaces", success_outcome: "  ", constraints: ["unique names", " "], open_questions: [] },
      { successScore: 0.9, quality: { outputCompleteness: 0.95, outputCorrectness: 0.95, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 }, reason: "Frame is complete and unambiguous.", handoffReady: true },
      "ignored when scoring.reason present"
    );
    expect(out.lead).toBe("Frame is complete and unambiguous.");
    expect(out.fields).toEqual([
      { label: "Problem", value: "Can't rename workspaces" },
      { label: "Constraints", value: ["unique names"] },
    ]);
    expect(out.scoring?.successScore).toBe(0.9);
  });

  it("falls back to proposal then a generic lead when scoring is null", () => {
    expect(buildConfirmationSummary(schema, {}, null, "  Proposed the frame  ").lead).toBe("Proposed the frame");
    expect(buildConfirmationSummary(schema, {}, null, null).lead).toBe("Step complete.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/confirmation-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts`:
```ts
import type {
  ConfirmationSummary as ConfirmationSummaryT,
  StepResultScoringProposal,
  WorkflowStepOutputSchema,
} from "@orca/contracts";

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldValue(raw: unknown): string | string[] | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    const items = raw
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    return items.length > 0 ? items : null;
  }
  return null; // objects / null are omitted
}

/** Builds the structured confirmation-card payload from a step's recorded output
 *  block and the mediator's scoring. Empty/missing fields and the internal
 *  `_completion` key are omitted so the card never shows a blank label. */
export function buildConfirmationSummary(
  outputSchema: WorkflowStepOutputSchema,
  block: unknown,
  scoring: StepResultScoringProposal | null,
  proposal: string | null
): ConfirmationSummaryT {
  const obj = (block ?? {}) as Record<string, unknown>;
  const fields: ConfirmationSummaryT["fields"] = [];
  for (const field of outputSchema) {
    if (field.key === "_completion") continue;
    const value = fieldValue(obj[field.key]);
    if (value === null) continue;
    fields.push({ label: humanizeKey(field.key), value });
  }
  const lead = scoring?.reason?.trim() || proposal?.trim() || "Step complete.";
  return { lead, fields, scoring };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/confirmation-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/confirmation-summary.ts apps/daemon/src/workflows/orchestrator/confirmation-summary.test.ts
git commit -m "feat(daemon): buildConfirmationSummary structures the confirmation card body"
```

---

### Task 4: Daemon — stash the proposal text at approval time

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`approve_step_complete` handler, ~lines 1462-1471)
- Test: covered by Task 5's projection test (the stash field is internal; no standalone test needed here — fold the verification into Task 5).

**Interfaces:**
- Produces: `pending_completion_json` now also contains `proposal: string` (the agent's extracted proposal prose).

- [ ] **Step 1: Modify the stash write**

In `service.ts`, in the supervised/handoff branch of `approve_step_complete`, replace:
```ts
          db.prepare(
            "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
          ).run(
            JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt }),
            ctx.stepRun.id
          );
          const summary = summarizeScoring(scoring, extractProposal(responseText));
```
with:
```ts
          const proposal = extractProposal(responseText);
          db.prepare(
            "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
          ).run(
            JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt, proposal }),
            ctx.stepRun.id
          );
          const summary = summarizeScoring(scoring, proposal);
```

- [ ] **Step 2: Verify the daemon still compiles**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit -p tsconfig.json`
Expected: PASS (no type errors). The existing `confirmStep` stash parse ignores the extra field.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): stash agent proposal text for the confirmation card lead"
```

---

### Task 5: Daemon — project `confirmationSummary` onto the paused activity

**Files:**
- Modify: `apps/daemon/src/activities/projection.ts`
- Test: `apps/daemon/src/activities/projection.test.ts` (create if absent)

**Interfaces:**
- Consumes: `buildConfirmationSummary` (Task 3); `pending_completion_json` stash (Task 4).
- Produces: `listActivitiesByGoal` returns `step_confirmation_pending` activities with `confirmationSummary` populated.

Notes for the implementer: the run's template snapshot is stored in `workflow_templates.steps_json`; each step object carries `id` and `outputSchema`. `enrichStepResult` in the same file already joins these tables — mirror that join.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/daemon/src/activities/projection.test.ts`. Use the existing test DB helper if one exists in the daemon test suite (search for `openTestDatabase`/`migrate` usage in `apps/daemon/src/activities/*.test.ts`); otherwise mirror the setup used by `apps/daemon/src/activities/updater.test.ts`. The test must:
```ts
import { describe, it, expect } from "vitest";
import { listActivitiesByGoal } from "./projection.js";
// ...open a migrated in-memory db (mirror the helper used by sibling activity tests)...

describe("enrichConfirmationSummary", () => {
  it("attaches confirmationSummary to a step_confirmation_pending activity from the stash", () => {
    // Arrange: insert a goal, a workflow template whose steps_json includes
    //   [{ id: "frame", name: "Frame", outputSchema: [{ key: "problem", type: "string", required: true }] }],
    //   a workflow_run referencing that template, a workflow_step_run with
    //   step_template_id = "frame" and pending_completion_json =
    //   JSON.stringify({ block: { problem: "Can't rename" }, scoring: { successScore: 0.9, quality: {...}, reason: "Done.", handoffReady: true }, finishedAt: "...", proposal: "p" }),
    //   and an activities row with source_kind = 'step_confirmation_pending'
    //   pointing at that step run.
    const activities = listActivitiesByGoal(db, "g1");
    const confirm = activities.find((a) => a.sourceKind === "step_confirmation_pending");
    expect(confirm?.confirmationSummary?.lead).toBe("Done.");
    expect(confirm?.confirmationSummary?.fields).toEqual([{ label: "Problem", value: "Can't rename" }]);
    expect(confirm?.confirmationSummary?.scoring?.successScore).toBe(0.9);
  });
});
```
(Fill in the arrange block with real inserts matching the daemon's schema — read `apps/daemon/migrations/*` for the exact `workflow_templates`, `workflow_runs`, `workflow_step_runs`, and `activities` columns.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/projection.test.ts`
Expected: FAIL — `confirmationSummary` is `undefined`.

- [ ] **Step 3: Implement the enrich function**

In `apps/daemon/src/activities/projection.ts`, add imports:
```ts
import { StepResultScoringProposal, WorkflowStepOutputSchema } from "@orca/contracts";
import { buildConfirmationSummary } from "../workflows/orchestrator/confirmation-summary.js";
```
Add the function (mirroring `enrichStepResult`):
```ts
function enrichConfirmationSummary(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "step_confirmation_pending") return activity;
  const row = db
    .prepare(
      `SELECT sr.pending_completion_json AS stash,
              sr.step_template_id,
              wt.steps_json
       FROM workflow_step_runs sr
       LEFT JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
       LEFT JOIN workflow_templates wt ON wt.id = wr.template_id
       WHERE sr.id = ?`
    )
    .get(activity.stepRunId) as {
      stash: string | null;
      step_template_id: string;
      steps_json: string | null;
    } | undefined;
  if (!row?.stash || !row.steps_json) return activity;

  let stash: { block?: unknown; scoring?: unknown; proposal?: unknown };
  try { stash = JSON.parse(row.stash); } catch { return activity; }

  const steps = JSON.parse(row.steps_json) as Array<{ id: string; outputSchema?: unknown }>;
  const step = steps.find((s) => s.id === row.step_template_id);
  const schemaParse = WorkflowStepOutputSchema.safeParse(step?.outputSchema);
  if (!schemaParse.success) return activity;

  const scoringParse = StepResultScoringProposal.safeParse(stash.scoring);
  const confirmationSummary = buildConfirmationSummary(
    schemaParse.data,
    stash.block,
    scoringParse.success ? scoringParse.data : null,
    typeof stash.proposal === "string" ? stash.proposal : null,
  );
  return Activity.parse({ ...activity, confirmationSummary });
}
```
Wire it into the chain in `listActivitiesByGoal`:
```ts
  return rows
    .map((r) => rowToActivity(db, r))
    .map((a) => enrichStepResult(db, a))
    .map((a) => enrichConfirmationSummary(db, a))
    .map((a) => enrichProviderRecovery(db, a));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/activities/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/projection.ts apps/daemon/src/activities/projection.test.ts
git commit -m "feat(daemon): project confirmationSummary onto paused confirmation activity"
```

---

### Task 6: Daemon — interview policy + Frame instructions drop the redundant ask_user

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts` (interview policy line ~112)
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (Frame step instructions)
- Test: `apps/daemon/src/orchestrator-llm/prompts.test.ts`; `apps/daemon/src/workflows/templates/catalog.test.ts`

**Interfaces:** none (prompt copy only).

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/orchestrator-llm/prompts.test.ts`, add:
```ts
it("interview policy blocks completion on open questions but does not require a separate confirm ask_user", () => {
  const { systemPrompt } = composeOrchestratorPrompt(/* existing minimal input used by sibling tests */);
  expect(systemPrompt).toMatch(/interview: never approve_step_complete while the step output's open_questions is non-empty/);
  expect(systemPrompt).not.toMatch(/ask the user to confirm/);
});
```
In `apps/daemon/src/workflows/templates/catalog.test.ts`, add:
```ts
it("Frame step no longer instructs the agent to ask the user to confirm", () => {
  const brainstorm = BUILTIN_TEMPLATE_CATALOG.find((t) => t.id === "orca/brainstorm")!;
  const frame = brainstorm.steps.find((s) => s.id === "frame")!;
  expect(frame.completionPolicy).toBe("interview");
  expect(frame.instructions).not.toMatch(/ask the user to confirm/i);
  expect(frame.instructions).toMatch(/complete/i);
});
```
(Reuse the exact `composeOrchestratorPrompt` argument shape from the existing tests in `prompts.test.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/orchestrator-llm/prompts.test.ts src/workflows/templates/catalog.test.ts`
Expected: FAIL — current copy still says "ask the user to confirm".

- [ ] **Step 3: Edit the interview policy line**

In `prompts.ts`, replace the interview bullet:
```ts
    "- interview: never approve_step_complete while the step output's open_questions is non-empty or the synthesized result is unconfirmed by the user — use ask_user (one decision at a time, with a recommended answer) until the queue is drained, then ask the user to confirm.",
```
with:
```ts
    "- interview: never approve_step_complete while the step output's open_questions is non-empty — use ask_user (one decision at a time, with a recommended answer) until the queue is drained, then approve_step_complete. The user confirms or revises the synthesized result on the completion card, so do not ask a separate confirmation question.",
```

- [ ] **Step 4: Edit the Frame instructions**

In `catalog.ts`, in the Frame step, replace the final two sentences:
```
When no questions remain, present your synthesized frame (problem, success outcome, constraints) and ask the user to confirm or revise. Complete only after the user confirms.
```
with:
```
When no questions remain, synthesize the frame (problem, success outcome, constraints) into the step output with an empty open_questions list and complete; the user confirms or revises it on the completion card.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/orchestrator-llm/prompts.test.ts src/workflows/templates/catalog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/orchestrator-llm/prompts.test.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(daemon): drop redundant interview confirm ask_user; card owns confirm/revise"
```

---

### Task 7: Daemon — persist `pendingRevision` on orchestrator messages

**Files:**
- Create: `apps/daemon/migrations/0035_orchestrator_message_pending_revision.sql`
- Modify: `apps/daemon/src/orchestrator-chat/projection.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`postOrchestratorMessage`)
- Test: `apps/daemon/src/orchestrator-chat/projection.test.ts`

**Interfaces:**
- Produces: `postOrchestratorMessage(..., role?, pendingQuestion?, pendingRevision?)`; projection parses `pending_revision` into `OrchestratorChatMessage.pendingRevision`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0035_orchestrator_message_pending_revision.sql`:
```sql
ALTER TABLE orchestrator_messages ADD COLUMN pending_revision TEXT;
```

- [ ] **Step 2: Write the failing projection test**

In `apps/daemon/src/orchestrator-chat/projection.test.ts`, add a case: insert an `orchestrator_messages` row with `pending_revision = '{"workflowRunId":"r1"}'`, then assert `listOrchestratorMessagesByGoal(db, "g1")[0].pendingRevision?.workflowRunId === "r1"`. (Mirror the existing insert + assert style already in that test file.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/orchestrator-chat/projection.test.ts`
Expected: FAIL — `pendingRevision` undefined (column not selected/parsed).

- [ ] **Step 4: Implement projection parsing**

In `projection.ts`, add `pending_revision` to the SELECT column list, then near the `pendingApproval` parse add:
```ts
    let pendingRevision: unknown = undefined;
    if (typeof row.pending_revision === "string" && row.pending_revision) {
      try {
        const parsed = JSON.parse(row.pending_revision);
        if (PendingRevision.safeParse(parsed).success) pendingRevision = parsed;
      } catch { /* ignore malformed */ }
    }
```
Import `PendingRevision` at the top, and add to the returned `OrchestratorChatMessage.parse({ ... })`:
```ts
      ...(pendingRevision !== undefined ? { pendingRevision } : {}),
```

- [ ] **Step 5: Extend `postOrchestratorMessage`**

In `service.ts`, change the signature and INSERT of `postOrchestratorMessage`:
```ts
  private postOrchestratorMessage(
    db: Database.Database,
    now: () => string,
    goalId: string,
    body: string,
    options: RequestNextDecisionOptions,
    role: "orchestrator" | "user" = "orchestrator",
    pendingQuestion?: PendingQuestionT,
    pendingRevision?: { workflowRunId: string }
  ): void {
```
Update the INSERT to include `role` and `pending_revision`:
```ts
      db.prepare(
        `INSERT INTO orchestrator_messages
          (id, goal_id, role, kind, body, correlation_id, created_at, pending_question, pending_revision)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        goalId,
        role,
        body,
        correlationId,
        createdAt,
        pendingQuestion ? JSON.stringify(pendingQuestion) : null,
        pendingRevision ? JSON.stringify(pendingRevision) : null
      );
      const payload = { messageId, role };
```
Update the existing caller `postHandoffClosingSummary` (the only current caller) — it relies on the default `role` and passes no pendingQuestion, so its call `this.postOrchestratorMessage(db, now, ctx.run.goalId, lines.join("\n"), options)` stays valid.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/orchestrator-chat/projection.test.ts`
Expected: PASS. Also run `pnpm --filter @orca/daemon exec tsc --noEmit -p tsconfig.json` — expected PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/migrations/0035_orchestrator_message_pending_revision.sql apps/daemon/src/orchestrator-chat/projection.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/orchestrator-chat/projection.test.ts
git commit -m "feat(daemon): persist pendingRevision marker on orchestrator messages"
```

---

### Task 8: Daemon — `requestStepRevision` + `submitStepRevision` service methods

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (sibling step-completion tests live here)

**Interfaces:**
- Consumes: `postOrchestratorMessage` (Task 7), existing `reviseStep`, `resumeFromConfirmation`, `getWorkflowRunById`, `readStepRun`.
- Produces:
  ```ts
  async requestStepRevision(db, now, runId, options?): Promise<void>
  async submitStepRevision(db, now, runId, feedback, options?): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

In `service.agent-step.test.ts`, add two tests (reuse the file's existing harness that drives a step to a `pending_completion_json` confirmation pause):
```ts
it("requestStepRevision posts a 'What would you like to revise?' message with a pendingRevision marker", async () => {
  // Arrange: drive the step to a confirmation pause (pending_completion_json set).
  await service.requestStepRevision(db, now, runId, { bus, idFactory });
  const msgs = listOrchestratorMessagesByGoal(db, goalId);
  const prompt = msgs.find((m) => m.pendingRevision?.workflowRunId === runId);
  expect(prompt?.body).toBe("What would you like to revise?");
  expect(prompt?.role).toBe("orchestrator");
});

it("submitStepRevision clears the marker + stash, relays feedback, and resumes the step", async () => {
  await service.requestStepRevision(db, now, runId, { bus, idFactory });
  await service.submitStepRevision(db, now, runId, "tighten the success metric", { bus, idFactory });
  // stash cleared:
  const stash = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { pending_completion_json: string | null };
  expect(stash.pending_completion_json).toBeNull();
  // marker cleared:
  const msgs = listOrchestratorMessagesByGoal(db, goalId);
  expect(msgs.some((m) => m.pendingRevision != null)).toBe(false);
  // user feedback persisted as a chat bubble:
  expect(msgs.some((m) => m.role === "user" && m.body === "tighten the success metric")).toBe(true);
  // activity resumed (no longer paused at confirmation):
  const activities = listActivitiesByGoal(db, goalId);
  expect(activities.some((a) => a.sourceKind === "step_confirmation_pending")).toBe(false);
});
```
(Import `listOrchestratorMessagesByGoal` and `listActivitiesByGoal`; reuse the harness's `db/now/bus/idFactory/runId/stepRunId/goalId`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.agent-step.test.ts -t Revision`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement the methods**

In `service.ts`, after `confirmStep`, add:
```ts
  /** Posts the conversational revision prompt and marks the step awaiting a
   *  revision. No-op if the step is not paused at a confirmation. */
  async requestStepRevision(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return;
    const stash = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as { pending_completion_json: string | null } | undefined;
    if (!stash?.pending_completion_json) return;
    this.postOrchestratorMessage(
      db, now, run.goalId, "What would you like to revise?", options,
      "orchestrator", undefined, { workflowRunId: runId }
    );
  }

  /** Accepts the user's revision text: persists it as a user bubble, clears the
   *  pending marker + completion stash, relays the feedback to the live step
   *  agent, and resumes the step. Idempotent once the stash is cleared. */
  async submitStepRevision(
    db: Database.Database,
    now: () => string,
    runId: string,
    feedback: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return;
    const stepRun = readStepRun(db, run.currentStepRunId);
    const stashRow = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(stepRun.id) as { pending_completion_json: string | null } | undefined;
    if (!stashRow?.pending_completion_json) return; // idempotent no-op

    // Persist the user's revision as a chat bubble (no mediator trigger).
    this.postOrchestratorMessage(db, now, run.goalId, feedback, options, "user");

    db.prepare(
      "UPDATE orchestrator_messages SET pending_revision = NULL WHERE goal_id = ? AND json_extract(pending_revision, '$.workflowRunId') = ?"
    ).run(run.goalId, runId);
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(stepRun.id);

    const activityCtx = { db, bus: options.bus ?? new EventBus() };
    resumeFromConfirmation(activityCtx, { stepRunId: stepRun.id });

    const sessionRow = db
      .prepare("SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1")
      .get(stepRun.id) as { id: string } | undefined;
    await this.reviseStep(db, now, { run, stepRun }, sessionRow?.id ?? null, feedback, options);
  }
```
Confirm `readStepRun`, `getWorkflowRunById`, `resumeFromConfirmation`, and `EventBus` are already imported in `service.ts` (they are used elsewhere in the file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.agent-step.test.ts -t Revision`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): requestStepRevision + submitStepRevision conversational revise flow"
```

---

### Task 9: Daemon — revise HTTP routes

**Files:**
- Modify: `apps/daemon/src/server.ts` (next to the `confirm-step` route, ~line 1645)
- Test: `apps/daemon/src/server.activity.test.ts` (sibling route tests)

**Interfaces:**
- Consumes: `requestStepRevision`, `submitStepRevision` (Task 8); `SubmitStepRevisionRequest` (Task 2).
- Produces: `POST /v1/workflows/runs/:id/revise-step` and `POST /v1/workflows/runs/:id/revise-step/submit`.

- [ ] **Step 1: Write the failing test**

In `server.activity.test.ts`, add a test that boots the server (mirror the existing confirm-step route test), drives a step to a confirmation pause, then:
```ts
const r1 = await app.inject({ method: "POST", url: `/v1/workflows/runs/${runId}/revise-step` });
expect(r1.statusCode).toBe(202);
const r2 = await app.inject({
  method: "POST", url: `/v1/workflows/runs/${runId}/revise-step/submit`,
  payload: { feedback: "tighten the success metric" }, headers: { "content-type": "application/json" },
});
expect(r2.statusCode).toBe(202);
const bad = await app.inject({
  method: "POST", url: `/v1/workflows/runs/${runId}/revise-step/submit`,
  payload: { feedback: "" }, headers: { "content-type": "application/json" },
});
expect(bad.statusCode).toBe(400);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/server.activity.test.ts -t revise`
Expected: FAIL — 404 (routes not registered).

- [ ] **Step 3: Implement the routes**

In `server.ts`, import `SubmitStepRevisionRequest` from `@orca/contracts` (add to the existing contracts import block), and after the `confirm-step` route add:
```ts
  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/revise-step", async (request, reply) => {
    await orchestratorService.requestStepRevision(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });

  server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/revise-step/submit", async (request, reply) => {
    const parsed = SubmitStepRevisionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    await orchestratorService.submitStepRevision(
      getDatabase(),
      daemonContext.now,
      request.params.id,
      parsed.data.feedback,
      { bus: eventBus, idFactory: daemonContext.idFactory }
    );
    return reply.code(202).send({ ok: true });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/server.activity.test.ts -t revise`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.activity.test.ts
git commit -m "feat(daemon): revise-step request + submit routes"
```

---

### Task 10: Desktop — api client for revise

**Files:**
- Modify: `apps/desktop/src/api.ts` (near `confirmStep`, ~line 1723)
- Test: `apps/desktop/src/api.test.ts`

**Interfaces:**
- Produces: `requestStepRevision(runId): Promise<void>`; `submitStepRevision(runId, feedback): Promise<void>`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/api.test.ts`, mirror the existing `confirmStep` client test (which mocks `fetch`/`loadConfig`) and assert the two functions POST to the correct URLs, and that `submitStepRevision` sends `{ feedback }` as JSON.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/api.test.ts -t revis`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

In `api.ts`, after `confirmStep`:
```ts
export async function requestStepRevision(runId: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(
    `${baseUrl}/v1/workflows/runs/${runId}/revise-step`,
    { method: "POST", headers: authHeaders(token) },
    "Failed to start revision",
  );
}

export async function submitStepRevision(runId: string, feedback: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(
    `${baseUrl}/v1/workflows/runs/${runId}/revise-step/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ feedback }),
    },
    "Failed to submit revision",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop exec vitest run src/api.test.ts -t revis`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): requestStepRevision + submitStepRevision api clients"
```

---

### Task 11: Desktop — enhanced confirmation card in `LiveActivity`

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (styles for the new card sections)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Interfaces:**
- Consumes: `Activity.confirmationSummary` (Task 1).
- Produces: `LiveActivity` accepts `onRevise?: (runId: string) => void`; renders lead, structured fields, a collapsible scores dropdown, and Continue + Revise buttons for `step_confirmation_pending`.

- [ ] **Step 1: Write the failing test**

In `ActivityThread.test.tsx`, add:
```ts
import { render, screen, fireEvent } from "@testing-library/react";
import { LiveActivity } from "./ActivityThread";

const confirmActivity = {
  id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "paused_for_input", currentText: "fallback",
  finalSummary: null, sourceKind: "step_confirmation_pending", workCategory: null,
  confidence: null, createdAt: "t", updatedAt: "t", completedAt: null, steps: [],
  stepName: "Frame",
  confirmationSummary: {
    lead: "The frame is complete.",
    fields: [
      { label: "Problem", value: "Cannot rename workspaces" },
      { label: "Constraints", value: ["unique names", "one folder = one workspace"] },
    ],
    scoring: { successScore: 0.9, quality: { outputCompleteness: 0.95, outputCorrectness: 0.95, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 }, reason: "ok", handoffReady: true },
  },
} as any;

it("renders lead, fields, a collapsed scores dropdown, and Continue + Revise", () => {
  const onContinue = vi.fn(); const onRevise = vi.fn();
  render(<LiveActivity activity={confirmActivity} onContinue={onContinue} onRevise={onRevise} />);
  expect(screen.getByText("The frame is complete.")).toBeInTheDocument();
  expect(screen.getByText("Cannot rename workspaces")).toBeInTheDocument();
  expect(screen.getByText("unique names")).toBeInTheDocument();
  // scores hidden until expanded
  expect(screen.queryByText(/Output completeness/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("confirm-scores-toggle"));
  expect(screen.getByText(/Output completeness/i)).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("step-confirm-revise"));
  expect(onRevise).toHaveBeenCalledWith("r1");
  fireEvent.click(screen.getByTestId("step-confirm-continue"));
  expect(onContinue).toHaveBeenCalledWith("r1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/ActivityThread.test.tsx -t "Continue + Revise"`
Expected: FAIL — no Revise button / no scores toggle.

- [ ] **Step 3: Implement the card**

In `ActivityThread.tsx`, extend `LiveActivity`'s props and the confirmation branch. Add `onRevise?: (runId: string) => void` to the props type. Add local state `const [scoresOpen, setScoresOpen] = useState(false);` (import `useState` is already imported at top). Replace the `isConfirmation` block body:
```tsx
      {isConfirmation ? (
        <div className="step-confirm" data-testid="step-confirm">
          {activity.confirmationSummary ? (
            <>
              <div className="step-confirm-lead">{activity.confirmationSummary.lead}</div>
              {activity.confirmationSummary.fields.length > 0 ? (
                <dl className="step-confirm-fields">
                  {activity.confirmationSummary.fields.map((f, i) => (
                    <div key={i} className="step-confirm-field">
                      <dt>{f.label}</dt>
                      <dd>
                        {Array.isArray(f.value) ? (
                          <ul>{f.value.map((v, j) => <li key={j}>{v}</li>)}</ul>
                        ) : f.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {activity.confirmationSummary.scoring ? (
                <div className="step-confirm-scores">
                  <button
                    type="button"
                    data-testid="confirm-scores-toggle"
                    className="step-confirm-scores-toggle"
                    onClick={() => setScoresOpen((o) => !o)}
                  >
                    {scoresOpen ? "Hide scores" : "Scores"}
                  </button>
                  {scoresOpen ? (
                    <dl className="step-result-metrics">
                      <div><dt>Success</dt><dd>{Math.round(activity.confirmationSummary.scoring.successScore * 100)}%</dd></div>
                      <div><dt>Output completeness</dt><dd>{Math.round(activity.confirmationSummary.scoring.quality.outputCompleteness * 100)}%</dd></div>
                      <div><dt>Output correctness</dt><dd>{Math.round(activity.confirmationSummary.scoring.quality.outputCorrectness * 100)}%</dd></div>
                      <div><dt>Instruction adherence</dt><dd>{Math.round(activity.confirmationSummary.scoring.quality.instructionAdherence * 100)}%</dd></div>
                      <div><dt>Downstream readiness</dt><dd>{Math.round(activity.confirmationSummary.scoring.quality.downstreamReadiness * 100)}%</dd></div>
                      <div><dt>Risk level (higher = riskier)</dt><dd>{Math.round(activity.confirmationSummary.scoring.quality.riskLevel * 100)}%</dd></div>
                      <div><dt>Handoff</dt><dd>{activity.confirmationSummary.scoring.handoffReady ? "Ready" : "Not ready"}</dd></div>
                    </dl>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="activity-bubble-text">{activity.currentText}</div>
          )}
          <div className="step-confirm-actions">
            <button
              type="button"
              data-testid="step-confirm-continue"
              className="step-confirm-continue-btn"
              onClick={() => onContinue?.(activity.workflowRunId)}
            >
              Continue
            </button>
            <button
              type="button"
              data-testid="step-confirm-revise"
              className="step-confirm-revise-btn"
              onClick={() => onRevise?.(activity.workflowRunId)}
            >
              Revise
            </button>
          </div>
        </div>
      ) : null}
```
Note: when `isConfirmation` and a `confirmationSummary` exists, the leading `<div className="activity-bubble-text">{activity.currentText}</div>` at the top of the bubble would duplicate content — guard it: change that line to
```tsx
      {!(isConfirmation && activity.confirmationSummary) ? (
        <div className="activity-bubble-text">{activity.currentText}</div>
      ) : null}
```

- [ ] **Step 4: Add styles**

In `orca-chat.css`, add minimal styles mirroring `.step-result-*`:
```css
.step-confirm-lead { font-weight: 600; margin-bottom: 8px; }
.step-confirm-fields { display: grid; gap: 6px; margin: 0 0 10px; }
.step-confirm-field dt { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
.step-confirm-field dd { margin: 0; }
.step-confirm-field ul { margin: 2px 0 0; padding-left: 16px; }
.step-confirm-scores { margin-bottom: 10px; }
.step-confirm-scores-toggle { background: none; border: none; padding: 0; cursor: pointer; opacity: .75; }
.step-confirm-actions { display: flex; gap: 8px; align-items: center; }
.step-confirm-revise-btn { background: none; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/ActivityThread.test.tsx -t "Continue + Revise"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): structured confirmation card with scores dropdown + Revise"
```

---

### Task 12: Desktop — wire Revise + composer reroute in `OrcaChat`

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `requestStepRevision`, `submitStepRevision` (Task 10); `LiveActivity` `onRevise` (Task 11); `OrchestratorChatMessage.pendingRevision` (Task 2).

- [ ] **Step 1: Write the failing test**

In `OrcaChat.test.tsx` (which already mocks `../api`), add a test: seed `listOrchestratorMessages` to return a message with `pendingRevision: { workflowRunId: "r1" }`; type into the composer and submit; assert `submitStepRevision` was called with `("r1", <text>)` and `createOrchestratorMessage` was NOT called. Add a second test: render with a `step_confirmation_pending` live activity (via the mocked `listActivities`), click `step-confirm-revise`, and assert `requestStepRevision` was called with `"r1"`. (Mirror the existing OrcaChat test setup for mocking api + rendering.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx -t revis`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring**

In `OrcaChat.tsx`:
1. Add to the api import block: `requestStepRevision, submitStepRevision`.
2. After the `pendingWorkerQuestionId` computation, add:
```tsx
  const pendingRevisionRunId =
    [...messages].reverse().find((m) => m.pendingRevision != null)?.pendingRevision?.workflowRunId ?? null;
```
3. In `handleSendMessage`, after the `liveQuestionId` branch and before the normal `createOrchestratorMessage` send, add:
```tsx
    if (pendingRevisionRunId) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await submitStepRevision(pendingRevisionRunId, body);
        markAnswerPending();
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to send your revision."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }
```
4. Add a handler:
```tsx
  async function handleRevise(runId: string) {
    try {
      await requestStepRevision(runId);
    } finally {
      setRefreshNonce((current) => current + 1);
    }
  }
```
5. Pass it to `LiveActivity` and hide the confirmation card once a revision is pending. Replace the `liveActivity && (...)` block's `<LiveActivity .../>` usage so it is suppressed when the live activity is the confirmation awaiting a revision:
```tsx
            {liveActivity &&
              !(liveActivity.sourceKind === "step_confirmation_pending" &&
                pendingRevisionRunId === liveActivity.workflowRunId) && (
              <LiveActivity
                activity={liveActivity}
                renderProviderRecovery={({ runId, recovery }) => (
                  <ProviderRecoveryCard
                    runId={runId}
                    recovery={recovery}
                    onChanged={() => setRefreshNonce((current) => current + 1)}
                  />
                )}
                onContinue={handleContinue}
                onRevise={handleRevise}
              />
            )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx -t revis`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): wire Revise button + composer reroute for revisions"
```

---

### Task 13: Full verification

- [ ] **Step 1: Typecheck all packages**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 3: Commit any incidental fixes** (only if Steps 1-2 surfaced gaps)

```bash
git add -A && git commit -m "test: fix fallout from unified confirmation card"
```

---

## Self-Review

**1. Spec coverage:**
- Card: lead + structured body + scores dropdown + Continue/Revise → Tasks 1, 3, 5, 11. ✓
- Data threading (`confirmationSummary` via projection, proposal stash) → Tasks 1, 4, 5. ✓
- Revise flow (prompt message, deterministic reroute, reviseStep + resume, user bubble) → Tasks 2, 7, 8, 9, 10, 12. ✓
- Remove redundant ask_user (interview policy + Frame instructions) → Task 6. ✓
- Scope (shared card / generic rendering) → schema-generic builder (Task 3) applied to all `step_confirmation_pending` (Task 5). ✓
- Error handling (revise cap via reviseStep, stash-clear idempotency, sparse fields) → Tasks 3, 8. ✓
- Testing → each task is TDD; Task 13 runs the full suite. ✓

**2. Placeholder scan:** Task 5 and Task 12 reference "mirror the existing harness/setup" rather than inlining the daemon's full DB-fixture boilerplate; this is intentional because the exact fixture columns must be read from the migrations/sibling tests at implementation time, and inventing them here risks drift. All production code is fully specified.

**3. Type consistency:** `ConfirmationSummary` shape is identical across Task 1 (contract), Task 3 (builder return), Task 5 (projection), Task 11 (render). `pendingRevision: { workflowRunId }` is identical across Tasks 2, 7, 8, 12. `requestStepRevision`/`submitStepRevision` signatures match across Tasks 8, 9, 10, 12.
