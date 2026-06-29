# Human-Prompt Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a `≤1-human-prompt-per-step-run` invariant so a single decision can never be surfaced to the human through multiple uncoordinated channels (worker `AskUserQuestion`, orchestrator `ask_user`, step-confirmation card).

**Architecture:** Add one deterministic control-plane gate seam (`isHumanPromptOpen`) that reads the *existing* event-sourced projections (`orchestrator_messages.pending_question` + `activities` confirmation rows), scoped by `stepRunId`. The optional orchestrator `ask_user` channel acquires the gate before posting (suppress + audit); the worker hard-block always posts and supersedes any redundant orchestrator question. Release is free — answering/resolving already clears the source state.

**Tech Stack:** TypeScript, better-sqlite3, Zod contracts, Vitest, pnpm workspaces. Daemon = `apps/daemon`; contracts = `packages/contracts`; desktop = `apps/desktop` (React + Vitest + Testing Library).

## Global Constraints

- Source of truth is derived from durable projected state; **no new projection table** and **no new mutable gate state**. (Spec: Substrate choice.)
- `PendingQuestion` field additions are **additive optional JSON** — no DB migration. (Spec §2.)
- The suppression audit record is a typed event on the append-only `events` spine — **not** a new `HarnessTransition` boundary. (Spec: Harness-axis alignment.)
- The gate is **pure deterministic code, no LLM**. (Spec: Deterministic-core placement.)
- Worker `AskUserQuestion` is a hard block and **always posts**; only the orchestrator `ask_user` yields. (Spec: precedence.)
- Match existing daemon style: raw `better-sqlite3` prepared statements, `ctx.db.transaction(...)`, events inserted via `INSERT INTO events (...)` then `ctx.bus.publish(...)` (mirror `recordWorkerQuestionAnswer`, `usecases.ts:288`).

---

### Task 1: Extend contracts (PendingQuestion fields + suppression event type)

**Files:**
- Modify: `packages/contracts/src/index.ts` (`PendingQuestion` ~line 1102; `DomainEventType` enum ~line 167)

**Interfaces:**
- Produces: `PendingQuestion.stepRunId?: string`, `PendingQuestion.withdrawn?: true`; `DomainEventType` member `"orchestrator.prompt.suppressed"`. Every later task relies on these.

- [ ] **Step 1: Add the two optional fields to `PendingQuestion`**

In `packages/contracts/src/index.ts`, change the `PendingQuestion` object (currently ends at `answer: PendingQuestionAnswer.optional()`):

```ts
export const PendingQuestion = z
  .object({
    questionId: z.string().min(1),
    toolUseId: z.string().min(1),
    questions: z.array(PendingQuestionItem).min(1).max(4),
    source: z.enum(["worker", "orchestrator"]).optional(),
    answer: PendingQuestionAnswer.optional(),
    // Step-run scope so the human-prompt gate can read prompts per step run.
    stepRunId: z.string().min(1).optional(),
    // Set when a worker hard-block supersedes a now-redundant orchestrator question.
    withdrawn: z.literal(true).optional()
  })
  .strict();
```

- [ ] **Step 2: Add the suppression event type to `DomainEventType`**

In the `DomainEventType = z.enum([...])` list, add the member next to the other `orchestrator.message.*` entries:

```ts
  "orchestrator.message.created",
  "orchestrator.message.updated",
  "orchestrator.prompt.suppressed",
```

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @orca/contracts build`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(contracts): add stepRunId/withdrawn to PendingQuestion + prompt.suppressed event"
```

---

### Task 2: The gate read seam (`isHumanPromptOpen`)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/human-prompt-gate.ts`
- Test: `apps/daemon/src/workflows/orchestrator/human-prompt-gate.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3` `Database` handle.
- Produces: `isHumanPromptOpen(db: Database.Database, stepRunId: string): boolean` — true iff an unanswered, non-withdrawn `pending_question` OR a `paused_for_input` `step_confirmation_pending` activity exists for `stepRunId`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/human-prompt-gate.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { isHumanPromptOpen } from "./human-prompt-gate.js";

const tempDirs: string[] = [];
const NOW = "2026-06-29T05:00:00.000Z";

function config(dir: string): Config {
  return {
    dataDir: dir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node", "x.js"],
    getAuthToken: () => "t",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-gate-"));
  tempDirs.push(dir);
  const db = openDatabase(config(dir));
  runMigrations(db, defaultMigrationsDir());
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('g1','G','d','active',1,?,?,NULL,'orca/openai','gpt-5')"
  ).run(NOW, NOW);
  return db;
}

function insertQuestion(db: Database.Database, id: string, pq: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?, 'g1', 'orchestrator', 'message', 'b', ?, ?, ?)"
  ).run(id, id, NOW, JSON.stringify(pq));
}

function insertConfirmationCard(db: Database.Database, id: string, stepRunId: string): void {
  db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal, status, current_text, final_summary, source_kind, work_category, confidence, pending_question, created_at, updated_at, completed_at)
     VALUES (?, 'g1', 'run1', ?, NULL, 0, 'paused_for_input', 'Confirm', NULL, 'step_confirmation_pending', NULL, NULL, NULL, ?, ?, NULL)`
  ).run(id, stepRunId, NOW, NOW);
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("isHumanPromptOpen", () => {
  it("false when nothing is open for the step run", () => {
    const db = setup();
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
    closeDatabase(db);
  });

  it("true for an unanswered worker question scoped to the step run", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1" });
    expect(isHumanPromptOpen(db, "sr1")).toBe(true);
    closeDatabase(db);
  });

  it("false when that question has been answered", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1", answer: { viaChat: true } });
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
    closeDatabase(db);
  });

  it("false when the question is withdrawn", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "orchestrator", stepRunId: "sr1", withdrawn: true });
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
    closeDatabase(db);
  });

  it("does not leak across step runs", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1" });
    expect(isHumanPromptOpen(db, "sr2")).toBe(false);
    closeDatabase(db);
  });

  it("true for an open step-confirmation card", () => {
    const db = setup();
    insertConfirmationCard(db, "a1", "sr1");
    expect(isHumanPromptOpen(db, "sr1")).toBe(true);
    closeDatabase(db);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @orca/daemon test human-prompt-gate`
Expected: FAIL — cannot resolve `./human-prompt-gate.js`.

- [ ] **Step 3: Implement the gate**

Create `apps/daemon/src/workflows/orchestrator/human-prompt-gate.ts`:

```ts
import type Database from "better-sqlite3";

/**
 * The human-prompt gate (Governed axis). True iff a human prompt is already open
 * for this step run, across all channels — an unanswered, non-withdrawn
 * pending_question (worker OR orchestrator) or a paused step-confirmation card.
 *
 * Derived purely from the existing event-sourced projections; it holds no state
 * of its own, so release is automatic when a prompt is answered or resolved.
 * Distinct from the routing gates (workflow_gate_decisions) and permission-gate.ts.
 */
export function isHumanPromptOpen(db: Database.Database, stepRunId: string): boolean {
  const question = db
    .prepare(
      `SELECT 1 FROM orchestrator_messages
        WHERE pending_question IS NOT NULL
          AND json_extract(pending_question, '$.stepRunId') = ?
          AND json_extract(pending_question, '$.answer') IS NULL
          AND json_extract(pending_question, '$.withdrawn') IS NULL
        LIMIT 1`
    )
    .get(stepRunId);
  if (question !== undefined) return true;

  const card = db
    .prepare(
      `SELECT 1 FROM activities
        WHERE step_run_id = ?
          AND source_kind = 'step_confirmation_pending'
          AND status = 'paused_for_input'
        LIMIT 1`
    )
    .get(stepRunId);
  return card !== undefined;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @orca/daemon test human-prompt-gate`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/human-prompt-gate.ts apps/daemon/src/workflows/orchestrator/human-prompt-gate.test.ts
git commit -m "feat(orchestrator): human-prompt gate read over event-sourced projections"
```

---

### Task 3: Supersede helper (`withdrawOrchestratorPromptsForStepRun`)

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts` (add export; mirror `recordWorkerQuestionAnswer` at line 288)
- Test: `apps/daemon/src/orchestrator-chat/usecases.test.ts` (add cases)

**Interfaces:**
- Consumes: `OrchestratorChatCtx` (`db`, `bus`, `idFactory`); `PendingQuestion` contract.
- Produces: `withdrawOrchestratorPromptsForStepRun(ctx, input: { goalId: string; stepRunId: string }): number` — sets `withdrawn:true` on every open (`answer` null, not already withdrawn) `pending_question` for `stepRunId` whose `source !== "worker"`; emits one `orchestrator.message.updated` per row; returns the count withdrawn.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/orchestrator-chat/usecases.test.ts` (inside the existing top-level `describe`, reusing its `setup()`):

```ts
import { withdrawOrchestratorPromptsForStepRun } from "./usecases.js";
import { PendingQuestion } from "@orca/contracts";

function seedQuestion(db: import("better-sqlite3").Database, id: string, pq: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?, 'goal-1', 'orchestrator', 'message', 'b', ?, ?, ?)"
  ).run(id, id, NOW, JSON.stringify(pq));
}
function readPq(db: import("better-sqlite3").Database, id: string) {
  const row = db.prepare("SELECT pending_question FROM orchestrator_messages WHERE id = ?").get(id) as { pending_question: string };
  return PendingQuestion.parse(JSON.parse(row.pending_question));
}
const ITEM = [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }];

describe("withdrawOrchestratorPromptsForStepRun", () => {
  it("withdraws an open orchestrator question but not the worker hard-block", () => {
    const { db, ctx } = setup();
    seedQuestion(db, "mo", { questionId: "qo", toolUseId: "to", questions: ITEM, source: "orchestrator", stepRunId: "sr1" });
    seedQuestion(db, "mw", { questionId: "qw", toolUseId: "tw", questions: ITEM, source: "worker", stepRunId: "sr1" });

    const n = withdrawOrchestratorPromptsForStepRun(ctx, { goalId: "goal-1", stepRunId: "sr1" });

    expect(n).toBe(1);
    expect(readPq(db, "mo").withdrawn).toBe(true);
    expect(readPq(db, "mw").withdrawn).toBeUndefined();
  });

  it("ignores already-answered and other step runs", () => {
    const { db, ctx } = setup();
    seedQuestion(db, "ma", { questionId: "qa", toolUseId: "ta", questions: ITEM, source: "orchestrator", stepRunId: "sr1", answer: { viaChat: true } });
    seedQuestion(db, "mb", { questionId: "qb", toolUseId: "tb", questions: ITEM, source: "orchestrator", stepRunId: "sr2" });
    const n = withdrawOrchestratorPromptsForStepRun(ctx, { goalId: "goal-1", stepRunId: "sr1" });
    expect(n).toBe(0);
    expect(readPq(db, "mb").withdrawn).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @orca/daemon test orchestrator-chat/usecases`
Expected: FAIL — `withdrawOrchestratorPromptsForStepRun` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/daemon/src/orchestrator-chat/usecases.ts`, add after `recordWorkerQuestionAnswer` (line ~327):

```ts
/**
 * Supersede: when a worker hard-block opens for a step run, retract any open
 * orchestrator question for the same step run (the worker's covers the decision).
 * Mirrors recordWorkerQuestionAnswer's transaction + event pattern. Returns the
 * number of questions withdrawn.
 */
export function withdrawOrchestratorPromptsForStepRun(
  ctx: Pick<OrchestratorChatCtx, "db" | "bus" | "idFactory">,
  input: { goalId: string; stepRunId: string }
): number {
  const idFactory = ctx.idFactory ?? randomUUID;
  const staged = ctx.db.transaction(() => {
    const rows = ctx.db
      .prepare(
        `SELECT id, pending_question FROM orchestrator_messages
          WHERE goal_id = ?
            AND json_extract(pending_question, '$.stepRunId') = ?
            AND json_extract(pending_question, '$.answer') IS NULL
            AND json_extract(pending_question, '$.withdrawn') IS NULL
            AND IFNULL(json_extract(pending_question, '$.source'), '') != 'worker'`
      )
      .all(input.goalId, input.stepRunId) as Array<{ id: string; pending_question: string }>;

    const events: DomainEvent[] = [];
    for (const row of rows) {
      const pending = PendingQuestion.parse(JSON.parse(row.pending_question));
      const next = { ...pending, withdrawn: true as const };
      ctx.db
        .prepare("UPDATE orchestrator_messages SET pending_question = ? WHERE id = ?")
        .run(JSON.stringify(next), row.id);
      const payload = { messageId: row.id };
      const eventId = idFactory();
      const result = ctx.db
        .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(eventId, "orchestrator.message.updated", input.goalId, JSON.stringify(payload), new Date().toISOString());
      events.push({
        seq: Number(result.lastInsertRowid), id: eventId, type: "orchestrator.message.updated",
        goalId: input.goalId, payload, createdAt: new Date().toISOString(),
      });
    }
    return events;
  })();

  for (const e of staged) ctx.bus.publish(e);
  return staged.length;
}
```

Confirm `PendingQuestion`, `DomainEvent`, `randomUUID`, and `OrchestratorChatCtx` are already imported in this file (they are — used by `recordWorkerQuestionAnswer`).

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter @orca/daemon test orchestrator-chat/usecases`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/usecases.test.ts
git commit -m "feat(orchestrator-chat): supersede redundant orchestrator question on worker hard-block"
```

---

### Task 4: Suppression audit record (`recordPromptSuppressed`)

**Files:**
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Test: `apps/daemon/src/orchestrator-chat/usecases.test.ts`

**Interfaces:**
- Consumes: `OrchestratorChatCtx` (`db`, `bus`, `idFactory`); `PendingQuestionItem`.
- Produces: `recordPromptSuppressed(ctx, input: { goalId: string; stepRunId: string; questions: PendingQuestionItemT[]; openPrompt: "worker_question" | "orchestrator_question" | "confirmation_card" }): void` — appends one `orchestrator.prompt.suppressed` event to the spine (queryable, Inspectable axis) and publishes it.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/orchestrator-chat/usecases.test.ts`:

```ts
import { recordPromptSuppressed } from "./usecases.js";

describe("recordPromptSuppressed", () => {
  it("appends a queryable suppression event to the spine", () => {
    const { db, ctx } = setup();
    recordPromptSuppressed(ctx, {
      goalId: "goal-1", stepRunId: "sr1", questions: ITEM, openPrompt: "worker_question",
    });
    const row = db
      .prepare("SELECT type, goal_id, payload FROM events WHERE type = 'orchestrator.prompt.suppressed'")
      .get() as { type: string; goal_id: string; payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.stepRunId).toBe("sr1");
    expect(payload.openPrompt).toBe("worker_question");
    expect(Array.isArray(payload.questions)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @orca/daemon test orchestrator-chat/usecases`
Expected: FAIL — `recordPromptSuppressed` not exported.

- [ ] **Step 3: Implement**

In `apps/daemon/src/orchestrator-chat/usecases.ts`, add (and ensure `PendingQuestionItem as PendingQuestionItemT` type import — it is exported by `@orca/contracts`):

```ts
/**
 * Inspectable-axis audit: a suppressed orchestrator ask_user leaves a queryable
 * record on the append-only events spine (never a silent drop). Suppression is
 * deferral — the judge re-raises any genuinely-distinct question after release.
 */
export function recordPromptSuppressed(
  ctx: Pick<OrchestratorChatCtx, "db" | "bus" | "idFactory">,
  input: {
    goalId: string;
    stepRunId: string;
    questions: PendingQuestionItemT[];
    openPrompt: "worker_question" | "orchestrator_question" | "confirmation_card";
  }
): void {
  const idFactory = ctx.idFactory ?? randomUUID;
  const payload = { stepRunId: input.stepRunId, openPrompt: input.openPrompt, questions: input.questions };
  const eventId = idFactory();
  const createdAt = new Date().toISOString();
  const result = ctx.db
    .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(eventId, "orchestrator.prompt.suppressed", input.goalId, JSON.stringify(payload), createdAt);
  ctx.bus.publish({
    seq: Number(result.lastInsertRowid), id: eventId, type: "orchestrator.prompt.suppressed",
    goalId: input.goalId, payload, createdAt,
  });
}
```

Add `PendingQuestionItem` to the existing `@orca/contracts` import in this file, aliased as `type PendingQuestionItem as PendingQuestionItemT` (follow the file's existing `...T` alias convention).

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter @orca/daemon test orchestrator-chat/usecases`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/usecases.test.ts
git commit -m "feat(orchestrator-chat): inspectable suppression audit on the events spine"
```

---

### Task 5: Acquire/suppress at the orchestrator `ask_user` site

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`applyOrchestratorAction`, `case "ask_user"` ~line 959)
- Test: `apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts` is the nearest service harness; add a focused case there OR a new `service.ask-user-gate.test.ts` reusing its setup.

**Interfaces:**
- Consumes: `isHumanPromptOpen` (Task 2), `recordPromptSuppressed` (Task 4).
- Produces: gated `ask_user` behavior — posts at most one orchestrator question per step run; stamps `stepRunId` + `source: "orchestrator"` when it does post.

- [ ] **Step 1: Add imports to `service.ts`**

```ts
import { isHumanPromptOpen } from "./human-prompt-gate.js";
import { recordPromptSuppressed } from "../../orchestrator-chat/usecases.js";
```

- [ ] **Step 2: Replace the `case "ask_user"` body**

Current (service.ts ~959-971):

```ts
      case "ask_user": {
        const idFactory = options.idFactory ?? randomUUID;
        const pendingQuestion: PendingQuestionT = {
          questionId: idFactory(),
          toolUseId: idFactory(),
          questions: action.questions,
        };
        postOrchestratorMessage(db, now, ctx.run.goalId, sanitizeNarration(action.body), options, "orchestrator", pendingQuestion);
        return { postedChatReply: true };
      }
```

Replace with:

```ts
      case "ask_user": {
        // Acquire the human-prompt gate: if any prompt is already open for this
        // step run (worker hard-block, prior orchestrator question, or a
        // confirmation card), suppress this redundant ask. Deferral, not loss —
        // the judge re-raises a genuinely-distinct question after release.
        if (isHumanPromptOpen(db, ctx.stepRun.id)) {
          recordPromptSuppressed(
            { db, bus: options.bus ?? new EventBus(), idFactory: options.idFactory ?? randomUUID },
            { goalId: ctx.run.goalId, stepRunId: ctx.stepRun.id, questions: action.questions, openPrompt: "worker_question" }
          );
          return { postedChatReply: false };
        }
        const idFactory = options.idFactory ?? randomUUID;
        const pendingQuestion: PendingQuestionT = {
          questionId: idFactory(),
          toolUseId: idFactory(),
          questions: action.questions,
          source: "orchestrator",
          stepRunId: ctx.stepRun.id,
        };
        postOrchestratorMessage(db, now, ctx.run.goalId, sanitizeNarration(action.body), options, "orchestrator", pendingQuestion);
        return { postedChatReply: true };
      }
```

Confirm `EventBus` is imported in `service.ts` (it is — used at `forward_to_agent`, `options.bus ?? new EventBus()`).

> Note: `openPrompt: "worker_question"` is the audit label for the common case. If finer attribution is wanted later, `isHumanPromptOpen` can return the winning channel; out of scope here.

- [ ] **Step 3: Write the gate test**

Create `apps/daemon/src/workflows/orchestrator/service.ask-user-gate.test.ts`. Reuse the harness from `service.splitter-routing.test.ts` (copy its `setup()` / fixture builders verbatim — they construct a `db`, an `OrchestratorService`, a run, and a step run). Then:

```ts
// (harness imports + setup copied from service.splitter-routing.test.ts)
import { isHumanPromptOpen } from "./human-prompt-gate.js";

describe("ask_user gate", () => {
  it("suppresses ask_user when a worker question is already open for the step run", async () => {
    const { db, service, ctx } = setup(); // ctx exposes run + stepRun ids; adapt to harness
    // Seed an open worker question for the step run.
    db.prepare(
      "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES ('mw', ?, 'orchestrator', 'message', 'b', 'c', ?, ?)"
    ).run(ctx.run.goalId, NOW, JSON.stringify({ questionId: "qw", toolUseId: "tw", questions: ITEM, source: "worker", stepRunId: ctx.stepRun.id }));

    expect(isHumanPromptOpen(db, ctx.stepRun.id)).toBe(true);

    await service.applyOrchestratorAction(/* ctx */ ctx, /* sessionId */ null, "resp", { kind: "ask_user", body: "pick", questions: ITEM }, options);

    const posted = db.prepare(
      "SELECT COUNT(*) c FROM orchestrator_messages WHERE json_extract(pending_question,'$.source')='orchestrator' AND json_extract(pending_question,'$.stepRunId')=?"
    ).get(ctx.stepRun.id) as { c: number };
    expect(posted.c).toBe(0);

    const audit = db.prepare("SELECT COUNT(*) c FROM events WHERE type='orchestrator.prompt.suppressed'").get() as { c: number };
    expect(audit.c).toBe(1);
  });

  it("posts the orchestrator question (stamped) when no prompt is open", async () => {
    const { db, service, ctx } = setup();
    await service.applyOrchestratorAction(ctx, null, "resp", { kind: "ask_user", body: "pick", questions: ITEM }, options);
    const posted = db.prepare(
      "SELECT pending_question FROM orchestrator_messages WHERE json_extract(pending_question,'$.source')='orchestrator'"
    ).get() as { pending_question: string };
    const pq = JSON.parse(posted.pending_question);
    expect(pq.stepRunId).toBe(ctx.stepRun.id);
    expect(pq.source).toBe("orchestrator");
  });
});
```

> `applyOrchestratorAction` is `private`. If the harness can't call it directly, drive it through the public entry that reaches it (`onAgentResponseDone` / `onUserMessage`) by stubbing the mediator to return an `{ kind: "ask_user" }` action — `service.splitter-routing.test.ts` already shows how this file stubs `orchestratorMediator`. Prefer the public path; reproduce the stub pattern from that test.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @orca/daemon test service.ask-user-gate`
Expected: PASS.

- [ ] **Step 5: Run the broader orchestrator suite for regressions**

Run: `pnpm --filter @orca/daemon test workflows/orchestrator`
Expected: PASS (no regressions in splitter/confirmation/dispatch tests).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.ask-user-gate.test.ts
git commit -m "feat(orchestrator): gate orchestrator ask_user behind the human-prompt gate"
```

---

### Task 6: Worker hard-block stamps stepRunId + supersedes

**Files:**
- Modify: `apps/daemon/src/server.ts` (`onWorkerQuestion` ~line 1648)
- Test: extend the existing server question flow test (`apps/daemon/src/server.permission-flow.test.ts` is the closest live-server harness) with a supersede case, OR rely on Task 3's unit coverage + a manual smoke. Prefer adding the integration case if the harness supports posting a worker question.

**Interfaces:**
- Consumes: `withdrawOrchestratorPromptsForStepRun` (Task 3).
- Produces: worker `pending_question` now carries `stepRunId`; opening a worker question withdraws redundant orchestrator questions for the same step run.

- [ ] **Step 1: Stamp `stepRunId` on the worker question payload**

In `server.ts` `onWorkerQuestion`, the `if (isNew)` block resolves `stepContext` *after* inserting the message (line ~1670). Move the `resolveStepContext(sessionId)` call to the top of the `isNew` block so its `stepRunId` is available for the payload, then add it:

```ts
      if (isNew) {
        const stepContext = resolveStepContext(sessionId);
        insertMessageWithEvent(
          { db, bus: eventBus, idFactory: daemonContext.idFactory },
          {
            id: daemonContext.idFactory(),
            goalId,
            role: "orchestrator",
            body: orcaVoiceQuestionText(payload.questions),
            correlationId: daemonContext.idFactory(),
            createdAt: daemonContext.now(),
            pendingQuestion: {
              questionId,
              toolUseId: payload.toolUseId,
              source: "worker",
              questions: payload.questions,
              ...(stepContext ? { stepRunId: stepContext.stepRunId } : {}),
            },
          },
        );
        // Supersede any redundant orchestrator question for this step run.
        if (stepContext) {
          withdrawOrchestratorPromptsForStepRun(
            { db, bus: eventBus, idFactory: daemonContext.idFactory },
            { goalId, stepRunId: stepContext.stepRunId }
          );
          applyActivitySafely("agent.question_pending", {
            kind: "turn_completed",
            stepRunId: stepContext.stepRunId,
            summary: "",
            confidence: null,
          });
        }
      }
```

- [ ] **Step 2: Import the helper in `server.ts`**

Add `withdrawOrchestratorPromptsForStepRun` to the existing import from `./orchestrator-chat/usecases.js`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @orca/daemon build`
Expected: PASS.

- [ ] **Step 4: Add/extend the server integration test (supersede)**

In `apps/daemon/src/server.permission-flow.test.ts` (reuse its live-server + session setup), add a case: pre-seed an open `source:"orchestrator"` question with `stepRunId` matching the session's step run, drive a worker `AskUserQuestion` through the elicit hook path the file already exercises, then assert the orchestrator question row is now `withdrawn:true` and the worker question row carries `stepRunId`. If the harness cannot reach `onWorkerQuestion` directly, assert the unit-level guarantee is already covered by Task 3 and limit this test to verifying the stamped `stepRunId` on a posted worker question.

- [ ] **Step 5: Run**

Run: `pnpm --filter @orca/daemon test server.permission-flow`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.permission-flow.test.ts
git commit -m "feat(server): worker question stamps stepRunId and supersedes orchestrator question"
```

---

### Task 7: Desktop renders a withdrawn question as retracted

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (worker-question bubble render ~line 1240-1254; latest-unanswered selection ~line 530)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `pendingQuestion.withdrawn` (Task 1 contract field, already flowing through the projection unchanged).

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (follow the file's existing render+fixture helpers):

```tsx
it("renders a withdrawn question as retracted and not answerable", () => {
  renderChat({
    messages: [messageWithPendingQuestion({
      questionId: "q1", toolUseId: "t1", source: "orchestrator", withdrawn: true,
      questions: [{ question: "Which blue?", header: "Active blue", options: [{ label: "info", description: "d" }] }],
    })],
  });
  // The interactive option buttons must NOT render for a withdrawn question.
  expect(screen.queryByRole("button", { name: /info/i })).toBeNull();
  expect(screen.getByText(/withdrawn/i)).toBeInTheDocument();
});
```

If `messageWithPendingQuestion` / `renderChat` helpers don't exist verbatim, adapt to the file's existing pattern for mounting `OrcaChat` with a `messages` array (the file already has worker-question render tests — mirror their fixture builder and add `withdrawn`/`source`).

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @orca/desktop test OrcaChat`
Expected: FAIL — option button still renders / no "withdrawn" text.

- [ ] **Step 3: Implement the withdrawn branch**

In the worker-question bubble render (~line 1240), guard the interactive card on `!message.pendingQuestion.withdrawn` and render a retracted state otherwise:

```tsx
{message.pendingQuestion && (
  message.pendingQuestion.withdrawn ? (
    <div className="pending-question withdrawn" data-testid="question-withdrawn">
      <span className="question-withdrawn-note">Question withdrawn — already answered elsewhere.</span>
    </div>
  ) : (
    /* existing interactive question card unchanged */
  )
)}
```

Also exclude withdrawn (and already-answered) questions from the latest-unanswered selector at line ~530 so the composer never binds to a withdrawn question:

```ts
(m) => m.pendingQuestion?.source === "worker" && m.pendingQuestion.answer == null && !m.pendingQuestion.withdrawn,
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter @orca/desktop test OrcaChat`
Expected: PASS.

- [ ] **Step 5: Add the `withdrawn` style**

In `apps/desktop/src/orchestrator/orca-chat.css`, add a muted/struck style for `.pending-question.withdrawn` consistent with the existing answered-question styling.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): render superseded questions as withdrawn, not answerable"
```

---

### Task 8: Full-suite verification

- [ ] **Step 1: Daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 2: Desktop suite**

Run: `pnpm --filter @orca/desktop test`
Expected: PASS.

- [ ] **Step 3: Workspace typecheck/build**

Run: `pnpm -r build`
Expected: PASS.

- [ ] **Step 4: Manual verification (browser)**

Drive the running app (`pnpm dev:browser`) per ORCA.md: start a goal whose step asks a clarifying question; confirm exactly one human prompt appears per step run, and that answering it lets the run proceed without a duplicate. Confirm a suppressed orchestrator ask leaves an `orchestrator.prompt.suppressed` row in `events`.

---

## Self-Review

**Spec coverage:**
- Gate seam over event spine → Task 2. ✔
- Contract `stepRunId`/`withdrawn` + suppression event → Task 1. ✔
- Worker stamps `stepRunId`, supersedes → Tasks 3 + 6. ✔
- Orchestrator acquire/suppress + stamp `source` → Task 5. ✔
- Confirmation card readable by gate (no acquire) → Task 2 query covers it; no card-side change needed. ✔
- Release is free → no task (verified by Task 2 answered/resolved cases). ✔
- Inspectable suppression record → Task 4. ✔
- Desktop withdrawn render → Task 7. ✔
- Harness-axis alignment, deterministic-core placement → realized by the above; no separate code.

**Placeholder scan:** No "TBD"/"handle edge cases". The two soft spots (Task 5 private-method access, Task 6 harness reach) name the exact fallback and the file that demonstrates the pattern, with concrete assertions — not deferred work.

**Type consistency:** `isHumanPromptOpen(db, stepRunId)`, `withdrawOrchestratorPromptsForStepRun(ctx, {goalId, stepRunId})`, `recordPromptSuppressed(ctx, {goalId, stepRunId, questions, openPrompt})`, `PendingQuestion.{stepRunId?, withdrawn?}`, event `"orchestrator.prompt.suppressed"` — used identically across Tasks 1-7.
