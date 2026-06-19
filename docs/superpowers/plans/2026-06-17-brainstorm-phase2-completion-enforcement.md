# Brainstorm Phase 2: Completion Enforcement + Mediator Context Enrichment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orchestrator honor each step's `completionPolicy`: a deterministic backstop that prevents an `interview` step from completing while it has unresolved `open_questions`, and a policy-aware mediator that can actually see the active step (instructions, schema, `completionPolicy`, prior outputs, agent turns, workspaces) so its prompt rule has effect.

**Architecture:** The mediator (`orchestrator-llm/`) turns triggers into one `OrchestratorAction`, applied by `WorkflowOrchestratorService.applyOrchestratorAction` (`workflows/orchestrator/service.ts`). Today the mediator's context builder (`build-context.ts`) only emits a placeholder `currentStep` — so the LLM is policy-blind. This phase (1) enriches that context from the DB for active runs, (2) adds `completionPolicy` to the context type + a prompt rule, and (3) adds a deterministic interview backstop in `applyOrchestratorAction`'s `approve_step_complete` case, which already has both `ctx.stepTpl.completionPolicy` and the step's emitted output block (with `open_questions`) in hand.

**Tech Stack:** TypeScript, Zod, Vitest, better-sqlite3. Depends on Phase 1 (`StepCompletionPolicy` + `completionPolicy` on `WorkflowStepTemplate`, already merged).

---

## File Structure

- `apps/daemon/src/orchestrator-llm/context.ts` — add optional `completionPolicy` to the `currentStep` context type (pass-through; no logic).
- `apps/daemon/src/orchestrator-llm/build-context.ts` — active-run enrichment: load the real current step (incl. `completionPolicy`), prior step outputs, current-step agent turns, and attached workspaces from the DB when `runId`/`stepRunId` are present; keep the freeform path otherwise.
- `apps/daemon/src/orchestrator-llm/build-context.test.ts` — tests for the enriched path (existing file; extend it).
- `apps/daemon/src/orchestrator-llm/prompts.ts` — add a `completionPolicy` rule to the mediator system prompt.
- `apps/daemon/src/orchestrator-llm/prompts.test.ts` — assert the rule text.
- `apps/daemon/src/workflows/orchestrator/service.ts` — interview backstop in the `approve_step_complete` case of `applyOrchestratorAction`.
- `apps/daemon/src/workflows/orchestrator/service.*.test.ts` — backstop test.

---

### Task 1: Add `completionPolicy` to the mediator context type

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/context.ts:16-22` (the `currentStep` shape in `OrchestratorContextInput`)
- Test: `apps/daemon/src/orchestrator-llm/context.test.ts` (create if absent; otherwise add to the existing one)

- [ ] **Step 1: Write the failing test**

Add (in `apps/daemon/src/orchestrator-llm/context.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildOrchestratorContext, type OrchestratorContextInput } from "./context.js";

function baseInput(): OrchestratorContextInput {
  return {
    goal: { id: "g1", title: "T", description: "D", attachedWorkspaces: [] },
    run: { templateId: "tpl", templateVersion: 1, ordinal: 0, status: "active" },
    currentStep: { id: "frame", instructions: "i", outputSchema: [{ key: "x", type: "string", required: true }], agentAdapterId: "claude-code", executionMode: "shadow_session", completionPolicy: "interview" },
    chatMessages: [], currentStepAgentTurns: [], priorStepArtifacts: [], payloadBudgetBytes: 64 * 1024,
  };
}

describe("buildOrchestratorContext completionPolicy", () => {
  it("carries completionPolicy through to the invocation context", () => {
    const ctx = buildOrchestratorContext(baseInput());
    expect(ctx.currentStep.completionPolicy).toBe("interview");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/context`
Expected: FAIL — `completionPolicy` is not a known property of the `currentStep` type.

- [ ] **Step 3: Add the optional field to the type**

In `apps/daemon/src/orchestrator-llm/context.ts`, import the type and extend `currentStep`:

```ts
import type {
  ExecutionMode,
  StepCompletionPolicy,
  WorkflowRunStatus,
  WorkflowStepOutputSchema,
} from "@orca/contracts";
```

Then in `OrchestratorContextInput`, change the `currentStep` shape (lines 16-22) to include:

```ts
  currentStep: {
    id: string;
    instructions: string;
    outputSchema: WorkflowStepOutputSchema;
    agentAdapterId: string;
    executionMode: ExecutionMode;
    completionPolicy?: StepCompletionPolicy;
  };
```

No change to `buildOrchestratorContext` is needed — it already returns `input.currentStep` verbatim, so the new field flows through.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/context.ts apps/daemon/src/orchestrator-llm/context.test.ts
git commit -m "feat(orchestrator-llm): thread completionPolicy through mediator context type

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Enrich the mediator context from the DB for active runs

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/build-context.ts`
- Test: `apps/daemon/src/orchestrator-llm/build-context.test.ts` (extend existing)

**Context for the implementer:** `buildContextFromDb` currently always returns the freeform placeholder `currentStep`. When `args.runId` and `args.stepRunId` are both non-null, replace the placeholder with real data:
- Load the run row: `SELECT id, template_id, status FROM workflow_runs WHERE id = ?`.
- Load the template row and parse its steps: `SELECT steps_json, version FROM workflow_templates WHERE id = ?` → `JSON.parse(steps_json)` is a `WorkflowStepTemplate[]`.
- Load the current step run: `SELECT step_template_id, ordinal FROM workflow_step_runs WHERE id = ?`. Find the matching step template by `id === step_template_id`.
- Populate `currentStep` from that template: `id`, `instructions`, `outputSchema`, `completionPolicy` (may be undefined), `agentAdapterId` (use the existing default `"claude-code"`), `executionMode` (`"shadow_session"`).
- `priorStepArtifacts`: the most-recent `step_output` artifact per OTHER step template in the run. Mirror the established query in `service.ts:collectPriorStepArtifacts` — `SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ?`, then read `workflow_artifacts` (`type='step_output'`, `step_run_id` set, excluding the current `stepRunId`), keeping the last (most recent) body per `step_template_id`, `JSON.parse`-ing each body. Map to `{ stepId: step_template_id, outputJson }`.
- `attachedWorkspaces`: `SELECT id, name, path FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC` → map to `{ id, name, root: path }`.
- `currentStepAgentTurns`: keep `[]` for this task (agent-turn reconstruction is a follow-on; the backstop and prompt rule don't need it). Note this explicitly in the code with a comment so it isn't mistaken for an oversight.

Keep the freeform path (empty `currentStep`, freeform schema, empty workspaces) when `runId` or `stepRunId` is null.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/orchestrator-llm/build-context.test.ts`. Reuse the existing in-memory DB setup in that file (it already constructs a `better-sqlite3` DB and runs migrations for the freeform tests); follow that exact pattern. Seed a goal, a workspace, a `workflow_templates` row whose `steps_json` contains a step with `id: "frame"`, `completionPolicy: "interview"`, `instructions: "interview the user"`, a `workflow_runs` row, a `workflow_step_runs` row for that step, and a prior `workflow_artifacts` row of type `step_output` for a different step.

```ts
it("enriches currentStep with the real step + completionPolicy for an active run", () => {
  // ...seed goal g1, template tpl with steps [{id:'frame', ordinal:0, name:'Frame',
  //    instructions:'interview the user', outputSchema:[{key:'problem',type:'string',required:true}],
  //    agentPreference:[{adapterId:'claude-code',modelId:'claude-haiku-4-5'}], completionPolicy:'interview'}],
  //    run r1 (template_id tpl), step run sr1 (step_template_id 'frame')...
  const ctx = buildContextFromDb(db, { goalId: "g1", runId: "r1", stepRunId: "sr1", payloadBudgetBytes: 64 * 1024 });
  expect(ctx.currentStep.id).toBe("frame");
  expect(ctx.currentStep.instructions).toBe("interview the user");
  expect(ctx.currentStep.completionPolicy).toBe("interview");
  expect(ctx.goal.attachedWorkspaces.length).toBeGreaterThan(0);
});

it("keeps the freeform placeholder when no run is active", () => {
  const ctx = buildContextFromDb(db, { goalId: "g1", runId: null, stepRunId: null, payloadBudgetBytes: 64 * 1024 });
  expect(ctx.currentStep.id).toBe("");
});
```

(Fill in the seeding using the same insert statements the file's existing tests use; match the real column names from `migrations.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test build-context`
Expected: FAIL — `ctx.currentStep.id` is `""` for the active-run case (placeholder still returned).

- [ ] **Step 3: Implement the active-run enrichment**

In `apps/daemon/src/orchestrator-llm/build-context.ts`, before building the `input`, add (when `args.runId && args.stepRunId`) the loads described in the Context note above, producing real `currentStep`, `priorStepArtifacts`, and `attachedWorkspaces`. Parse `steps_json` as `WorkflowStepTemplate[]` (import the type from `@orca/contracts`). Guard every query: if the run, template, or step row is missing, fall back to the freeform placeholder rather than throwing. Keep `currentStepAgentTurns: []` with an explanatory comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test build-context`
Expected: PASS (both the active-run and freeform cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/build-context.ts apps/daemon/src/orchestrator-llm/build-context.test.ts
git commit -m "feat(orchestrator-llm): enrich mediator context from DB for active runs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Add the `completionPolicy` rule to the mediator prompt

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts` (the `composeOrchestratorPrompt` system prompt array, ~lines 81-108)
- Test: `apps/daemon/src/orchestrator-llm/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/orchestrator-llm/prompts.test.ts`:

```ts
it("instructs the mediator to honor completionPolicy", () => {
  const { systemPrompt } = composeOrchestratorPrompt({
    triggerKind: "agent_response",
    context: { /* reuse the test helper / minimal context already used in this file */ } as any,
    triggerPayload: {},
  });
  expect(systemPrompt).toMatch(/completionPolicy/);
  expect(systemPrompt).toMatch(/interview/i);
  expect(systemPrompt).toMatch(/open_questions/);
});
```

(Use whatever minimal `context` the other tests in this file already construct.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/prompts`
Expected: FAIL — no `completionPolicy` text in the prompt.

- [ ] **Step 3: Add the rule**

In `composeOrchestratorPrompt`, add these lines to the `systemPrompt` array (after the existing `ask_user` guidance line, before `"Return exactly one structured action."`):

```ts
    "Honor the current step's completionPolicy (in context.currentStep.completionPolicy):",
    "- interview: never approve_step_complete while the step output's open_questions is non-empty or the synthesized result is unconfirmed by the user — use ask_user (one decision at a time) until the queue is drained, then ask the user to confirm.",
    "- reasoning: pause at any material fork (options that genuinely diverge and are the user's to decide) via ask_user; never approve_step_complete while such a decision is pending.",
    "- handoff: open_questions is a recorded deliverable and does not block completion, but still ask_user for any genuine decision (e.g. where to save an artifact).",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/prompts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts apps/daemon/src/orchestrator-llm/prompts.test.ts
git commit -m "feat(orchestrator-llm): prompt the mediator to honor step completionPolicy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Deterministic interview backstop in `approve_step_complete`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the `approve_step_complete` case in `applyOrchestratorAction`, starting line 1440)
- Test: add to the existing `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (or the closest existing `applyOrchestratorAction`/approval test in that directory)

**Context:** In `approve_step_complete`, `const block = extractOrcaStepCompleteBlock(responseText)` is the step's emitted output JSON (or `null`). `ctx.stepTpl.completionPolicy` is the current step's policy. When the policy is `interview` and the block has a non-empty `open_questions` array, completion must be refused and the step revised instead of advanced — the structural backstop the design requires. This runs before BOTH the supervised and unsupervised completion paths.

- [ ] **Step 1: Write the failing test**

Add a test that drives `applyOrchestratorAction` (or the public entry that reaches it) with: a `ctx.stepTpl` whose `completionPolicy` is `"interview"`, an `approve_step_complete` action, and a `responseText` containing an `orca:step-complete` block with `open_questions: ["unresolved?"]`. Assert that the step is NOT completed/advanced — i.e. `reviseStep` path is taken (revise_attempts incremented and no `step_output` written / `advanceToNextStep` not called). Mirror the harness/stubs used by the nearest existing approval test in the orchestrator test suite (reuse its service construction and DB seeding helpers).

```ts
it("refuses to complete an interview step while open_questions remain", async () => {
  // build service + ctx with stepTpl.completionPolicy = "interview"
  // responseText includes: ```orca:step-complete { "open_questions": ["x?"], ... } ```
  // invoke the approval path
  // expect: no step_output artifact for the step run; revise_attempts incremented
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: FAIL — the step completes/advances despite the open question.

- [ ] **Step 3: Implement the backstop**

At the very start of the `case "approve_step_complete": {` block (line 1440), before the `getSupervisionMode` branch, add:

```ts
if (ctx.stepTpl.completionPolicy === "interview") {
  const block = extractOrcaStepCompleteBlock(responseText);
  const oq = (block as { open_questions?: unknown } | null)?.open_questions;
  if (Array.isArray(oq) && oq.length > 0) {
    return this.reviseStep(
      db,
      now,
      ctx,
      sessionId,
      "This interview step still has unresolved open questions. Resolve each one with the user (one at a time, with a recommended answer), then present the synthesized result and ask the user to confirm before completing.",
      options
    );
  }
}
```

(The existing `const block = extractOrcaStepCompleteBlock(responseText);` later in the case stays; this adds an earlier, scoped read. If you prefer, hoist the single `block` declaration above the guard and reuse it — keep it DRY, but don't change unrelated lines.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: PASS.

- [ ] **Step 5: Run the broader orchestrator suite to check for regressions**

Run: `pnpm --filter @orca/daemon test workflows/orchestrator`
Expected: PASS (no existing approval/advancement test regresses — non-interview steps are unaffected because the guard is policy-gated).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @orca/daemon typecheck` (expect PASS), then:

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(orchestrator): block interview step completion while open questions remain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase 2 slice of the 2026-06-17 spec, §1 + §5):**
- Mediator honors `completionPolicy` → Task 3 prompt rule, made effective by Task 1 (type) + Task 2 (real context). ✓
- Interview step can't complete with non-empty `open_questions` (deterministic backstop) → Task 4. ✓
- Reasoning steps pause at forks → Task 3 prompt rule (LLM-driven; the deterministic side for reasoning forks is not mechanizable without a fork signal and is intentionally left to the prompt). ✓ (noted)
- `handoff` open_questions non-blocking → Task 3 prompt rule + Task 4 guard is policy-gated to `interview` only, so handoff/reasoning are unaffected. ✓
- Deferred to later phases: Done's actual `.orca/specs` write + multi-workspace `ask_user` + closing summary (Phase 3); `currentStepAgentTurns` reconstruction, narration (Phase 4); result card (Phase 5). Task 2 leaves `currentStepAgentTurns: []` with a comment.

**Placeholder scan:** Task 2's test seeding is described rather than fully literal because it must match this repo's migration column names — the implementer is directed to reuse the existing `build-context.test.ts` DB setup and the documented queries. All implementation code blocks are literal. No TBD/TODO.

**Type consistency:** `completionPolicy` is the same `StepCompletionPolicy` type from Phase 1 throughout (context type in Task 1, read in Task 2, prompt reference in Task 3, `ctx.stepTpl.completionPolicy` in Task 4). `extractOrcaStepCompleteBlock`, `reviseStep`, and `collectPriorStepArtifacts` are existing symbols referenced by their real names.

---

## Remaining phases

- **Phase 3 — Done persistence:** `.orca/specs` write, multi-workspace `ask_user` (no default), `spec` artifact, closing summary. Builds on the now-real mediator context (workspaces) from Task 2.
- **Phase 4 — Narration:** reconstruct `currentStepAgentTurns` (Task 2 stub), plain-English activity feed, agent reasoning notes.
- **Phase 5 — Result card:** surface the step output `summary`/headline into the `WorkflowStepResult` projection; rework `ActivityThread.tsx` to lead with the result, scores in drawer.
