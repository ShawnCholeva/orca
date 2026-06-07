# Orca Activity Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orca chat's mixed message stream with a first-class **Activity Thread** — one live, paced "supervision" bubble per agent turn that updates in place, persists only meaningful summaries, mediates worker questions in Orca's voice, and keeps transport plumbing out of chat.

**Architecture:** A new `activities` SQLite table is the single source of truth for supervision narration. A provider-neutral `ActivitySignal` union is produced by a Claude signal adapter and fed to an `ActivityUpdater` that applies **paced narration** (coalesce by work-category, throttle to human reading speed, reassure on long phases). The updater writes through `ActivityStore`, which emits `activity.changed` domain events; the existing WebSocket `/v1/events` stream forwards them, and the desktop renders the live bubble + meaningful completed summaries. Worker questions pause the live activity and embed an Orca-voiced question card; the existing in-memory held-hook resolution path is unchanged.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Zod (`@orca/contracts`), Vitest (daemon), React + Vitest/Testing-Library (desktop). pnpm workspace.

---

## Locked Design Decisions (do not re-litigate)

These were resolved with the product owner during planning. Implement exactly:

1. **Data model:** new first-class `activities` table (migration `0024`). Do **not** overload `orchestrator_messages`.
2. **Turn grouping:** key on `step_run_id` with an incrementing `turn_ordinal`. **At most one non-terminal activity per step run**, enforced by a SQLite partial unique index. A new signal updates the single live row; after it completes/expires, the next signal opens a new turn (`turn_ordinal + 1`). `agent_session_id` is stored for traceability only, not part of the key. Restart-safe via persisted rows.
3. **Worker question card:** embedded on the activity row (`pending_question` JSON), rendered from the activity. The existing held-hook resolution (`WorkerQuestionStore` + `/answer` route) is **unchanged**; the activity carries the question only for rendering, and the `/answer` route also completes the activity.
4. **Completed-summary display:** inline, **only when meaningful** — predicate: `status = completed AND final_summary` non-empty `AND source_kind` is not a transient kind (`weak_signal`). Transient/weak-signal activities expire silently. One summary per turn is the natural cap; **no separate capping logic**.
5. **Weak-signal threshold:** 10s of no meaningful update → conservative "still working" text (transient, never persisted).
6. **Live texture — paced narration (Option C):** capture tool-use, but coalesce consecutive same-category tool calls into one phrase and throttle updates to ~3s; reassure on long same-category phases. Lively but calm.
7. **Question presentation — hybrid:** deterministic Orca-voice templating on the held path (no added latency); optional LLM polish is explicitly out of scope for v1.
8. **Recommendations:** `AskUserQuestion` has **no** structured recommendation field — it is a `(Recommended)` label-text + first-position convention, already preserved losslessly by the existing round-trip. Do **not** add a `recommended` schema field. Optional best-effort badge detection at render only.
9. **Codex:** v1 is **Claude-only**. The contract is provider-neutral; provider specifics live in the Claude adapter. No Codex adapter in this plan.
10. **Retire scaffold:** the never-wired `internal_thought` / `agent_paraphrased` roles, `internal_kind` / `raw_agent_text` / `why_rationale` columns, and `InternalThoughtRow` are dead code subsumed by this feature. This plan removes their desktop render branches and stops the (already-absent) production use. The `mark_done_ready` intent maps to a `completed`/`paused_for_input` activity; full mark-done wiring stays out of scope (it is already stubbed).
11. **Transport messages out of chat:** stop posting `"Relayed your message to the agent working the current step."` and `"The agent needs your input."` as durable chat rows. `routing` is a desktop loading-flag, fixed in the desktop phase. Real failures (no live session, expired question, missing provider) **stay** as visible chat messages.

---

## Constants (single source — reference these exact names)

Add to `apps/daemon/src/activities/constants.ts` (created in Task 1.3):

```ts
/** Minimum gap between live-bubble narration updates (paced narration). */
export const ACTIVITY_THROTTLE_MS = 3_000;
/** Silence after which the live bubble shows a conservative "still working" note. */
export const ACTIVITY_WEAK_SIGNAL_MS = 10_000;
```

---

## File Structure

**Daemon — new files (`apps/daemon/src/activities/`):**
- `constants.ts` — throttle + weak-signal constants.
- `signals.ts` — provider-neutral `ActivitySignal` union (no Claude concepts).
- `claude-adapter.ts` — Claude tool-name → `ActivityWorkCategory`; category → narration phrase. The *only* Claude-specific module.
- `store.ts` — `activities` table reads/writes + `activity.changed` event emission. Owns the one-live-per-step invariant.
- `projection.ts` — `listActivitiesByGoal`, `getActivityById` (read models for the API).
- `updater.ts` — `ActivityUpdater`: paced-narration brain (coalesce + throttle + reassure). Holds per-step throttle state.
- `routes.ts` — `GET /v1/goals/:goalId/activities`.

**Daemon — modified:**
- `apps/daemon/migrations/0024_activities.sql` — create table + indexes.
- `apps/daemon/src/migrations.ts` — register `0024`.
- `packages/contracts/src/index.ts` — `Activity*` schemas + `"activity.changed"` event type.
- `apps/daemon/src/agent-hooks/routes.ts` — add non-blocking `POST /v1/agent-hooks/tool-use` + `onToolUse` dep.
- `apps/daemon/src/agent-hooks/hook-settings.ts` — add `PreToolUse "*"` narration hook + `toolUseHookUrl`.
- `apps/daemon/src/server.ts` — wire updater (event subscription for `workflow.step.started`; hook handlers for tool-use/question/permission/turn-completed); register activity routes; remove transport-message posts.
- `apps/daemon/src/workflows/orchestrator/service.ts` — drop the `"Relayed your message…"` durable post (`acknowledgeUserMessageAction`).

**Desktop — new/modified:**
- `apps/desktop/src/orchestrator/ActivityThread.tsx` — live bubble + paused question card + meaningful completed summaries.
- `apps/desktop/src/api.ts` — `listActivities`; recognize `activity.changed`.
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — render `ActivityThread`; remove `routing` flags; remove dead `internal_thought` / `agent_paraphrased` render branches.

---

## Guardrails & Validations (the safety contract)

Every phase must uphold these; tests below enforce them:

- **G1 — One live bubble:** the partial unique index makes a second `active`/`paused_for_input` row per `step_run` a DB error. Store writes go through `openOrUpdateLive`, which updates the existing live row rather than inserting.
- **G2 — Narration never gates tools:** `/v1/agent-hooks/tool-use` returns `{ continue: true }` and **never** a `permissionDecision`. A test asserts the response carries no `permissionDecision`/`decision` key, so the permission/elicit flow is untouched. It also no-ops for `AskUserQuestion` (handled by `elicit`).
- **G3 — Request validation:** every new route `safeParse`s its input and returns `400 { error: { code: "validation_failed", issues } }` on failure (matches existing routes).
- **G4 — Lossless answers:** the worker-answer round-trip continues to validate against exact option labels via the existing `validateAnswers`/`assembleAnswerReason`. Embedding the question on the activity changes rendering only, not resolution.
- **G5 — No transient persistence:** `weak_signal` and not-yet-summarized turns never produce a durable row (expire with empty `final_summary`). A test asserts a weak-signal-only turn yields no rendered summary.
- **G6 — Paced, not noisy:** the updater drops same-category tool-use signals inside `ACTIVITY_THROTTLE_MS`. A test asserts a burst of same-category signals yields a single update.
- **G7 — Safe attribution:** any hook that cannot resolve a session/goal/step no-ops safely (never throws into the hook response, never fabricates an activity).

---

## PHASE 1 — Data model, store, projection, read API (daemon foundation)

Ships: activities can be created/updated/read and emit events. No behavior change to chat yet.

### Task 1.1: Contracts — Activity schemas + event type

**Files:**
- Modify: `packages/contracts/src/index.ts` (add after the `PendingApproval` / `SubmitPermissionDecisionRequest` block, ~line 1035; `PendingQuestion` is already defined above it)
- Modify: `packages/contracts/src/index.ts` `DomainEventType` enum (~line 233, end of `workflow.*` list)
- Test: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/index.test.ts`:

```ts
import { Activity, ActivityStatus, DomainEventType } from "./index";

describe("Activity contract", () => {
  it("parses a minimal active activity", () => {
    const parsed = Activity.parse({
      id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
      agentSessionId: null, turnOrdinal: 0, status: "active",
      currentText: "Watching the step agent…", finalSummary: null,
      sourceKind: "step_started", workCategory: null, confidence: null,
      createdAt: "2026-06-05T00:00:00.000Z", updatedAt: "2026-06-05T00:00:00.000Z",
      completedAt: null,
    });
    expect(parsed.status).toBe("active");
  });

  it("accepts an embedded pending question", () => {
    const parsed = Activity.parse({
      id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
      agentSessionId: "sess1", turnOrdinal: 1, status: "paused_for_input",
      currentText: "I need your call.", finalSummary: null,
      sourceKind: "question_pending", workCategory: null, confidence: null,
      pendingQuestion: { questionId: "q1", toolUseId: "t1", questions: [
        { header: "Signals", question: "Which passed?", multiSelect: true,
          options: [{ label: "A", description: "x" }] },
      ] },
      createdAt: "2026-06-05T00:00:00.000Z", updatedAt: "2026-06-05T00:00:00.000Z",
      completedAt: null,
    });
    expect(parsed.pendingQuestion?.questionId).toBe("q1");
  });

  it("rejects an unknown status", () => {
    expect(ActivityStatus.safeParse("running").success).toBe(false);
  });

  it("includes the activity.changed event type", () => {
    expect(DomainEventType.safeParse("activity.changed").success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- index.test.ts`
Expected: FAIL — `Activity` / `ActivityStatus` not exported; `activity.changed` not in enum.

- [ ] **Step 3: Add the schemas and event type**

In `packages/contracts/src/index.ts`, add `"activity.changed"` as the final entry of the `DomainEventType` `z.enum([...])` list (after `"workflow.human_review.requested"`):

```ts
  "workflow.human_review.requested",
  "activity.changed"
```

Then add this block immediately after the `SubmitPermissionDecisionRequest` definition (it must come after `PendingQuestion`, which is defined earlier):

```ts
export const ActivityStatus = z.enum([
  "active",
  "paused_for_input",
  "completed",
  "expired"
]);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

export const ActivitySourceKind = z.enum([
  "step_started",
  "tool_use",
  "question_pending",
  "permission_pending",
  "turn_completed",
  "weak_signal"
]);
export type ActivitySourceKind = z.infer<typeof ActivitySourceKind>;

export const ActivityWorkCategory = z.enum([
  "reading",
  "searching",
  "editing",
  "running",
  "testing",
  "other"
]);
export type ActivityWorkCategory = z.infer<typeof ActivityWorkCategory>;

export const ActivityConfidence = z.enum(["low", "medium", "high"]);
export type ActivityConfidence = z.infer<typeof ActivityConfidence>;

export const Activity = z
  .object({
    id: z.string(),
    goalId: z.string(),
    workflowRunId: z.string(),
    stepRunId: z.string(),
    agentSessionId: z.string().nullable(),
    turnOrdinal: z.number().int().nonnegative(),
    status: ActivityStatus,
    currentText: z.string().max(4000),
    finalSummary: z.string().max(4000).nullable(),
    sourceKind: ActivitySourceKind,
    workCategory: ActivityWorkCategory.nullable(),
    confidence: ActivityConfidence.nullable(),
    pendingQuestion: PendingQuestion.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable()
  })
  .strict();
export type Activity = z.infer<typeof Activity>;

export const ListActivitiesResponse = z
  .object({ items: z.array(Activity) })
  .strict();
export type ListActivitiesResponse = z.infer<typeof ListActivitiesResponse>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- index.test.ts`
Expected: PASS. Then `pnpm --filter @orca/contracts build` to refresh `dist` (consumed by daemon/desktop).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): Activity projection schemas + activity.changed event"
```

### Task 1.2: Migration 0024 — activities table

**Files:**
- Create: `apps/daemon/migrations/0024_activities.sql`
- Modify: `apps/daemon/src/migrations.ts` (the `MIGRATIONS` array)
- Test: `apps/daemon/src/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/migrations.test.ts` (mirror the existing table-assertion style in that file):

```ts
it("0024 creates activities with a one-live-per-step partial unique index", () => {
  const db = freshMigratedDb(); // existing helper in this test file
  const cols = db.prepare("PRAGMA table_info(activities)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining([
    "id", "goal_id", "workflow_run_id", "step_run_id", "agent_session_id",
    "turn_ordinal", "status", "current_text", "final_summary", "source_kind",
    "work_category", "confidence", "pending_question", "created_at",
    "updated_at", "completed_at",
  ]));

  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at)
              VALUES ('g1','t','active','2026-06-05','2026-06-05')`).run();
  const ins = (id: string, status: string) => db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, turn_ordinal,
       status, current_text, source_kind, created_at, updated_at)
     VALUES (?, 'g1', 'r1', 's1', 0, ?, 't', 'step_started', '2026-06-05', '2026-06-05')`
  );
  ins("a1", "active").run("a1", "active");
  // Second non-terminal row for the same step must violate the partial unique index.
  expect(() => ins("a2", "active").run("a2", "active")).toThrow();
  // A terminal row for the same step is allowed.
  expect(() => ins("a3", "completed").run("a3", "completed")).not.toThrow();
});
```

> If `migrations.test.ts` has no `freshMigratedDb`/`goals` helper, reuse whatever harness the file's other tests use to obtain a fully-migrated `Database` and a valid goal row; match that file's existing column names for `goals`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts`
Expected: FAIL — no such table `activities`.

- [ ] **Step 3: Create the migration and register it**

Create `apps/daemon/migrations/0024_activities.sql`:

```sql
-- 0024_activities.sql
-- First-class Orca Activity Thread projection: one updating row per agent turn,
-- grouped by step run. Subsumes the never-wired internal_thought scaffold for
-- supervision narration. Nothing FK-references this table.
CREATE TABLE activities (
  id               TEXT PRIMARY KEY,
  goal_id          TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  workflow_run_id  TEXT NOT NULL,
  step_run_id      TEXT NOT NULL,
  agent_session_id TEXT,
  turn_ordinal     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('active','paused_for_input','completed','expired')),
  current_text     TEXT NOT NULL,
  final_summary    TEXT,
  source_kind      TEXT NOT NULL,
  work_category    TEXT,
  confidence       TEXT,
  pending_question TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX idx_activities_goal_created ON activities(goal_id, created_at, id);
CREATE INDEX idx_activities_step_run ON activities(step_run_id, turn_ordinal);

-- Dedup key: at most one live (non-terminal) activity per step run.
CREATE UNIQUE INDEX idx_activities_one_live_per_step
  ON activities(step_run_id) WHERE status IN ('active','paused_for_input');
```

In `apps/daemon/src/migrations.ts`, append to the `MIGRATIONS` array after `"0023_worker_permission_mode.sql"`:

```ts
  "0024_activities.sql",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0024_activities.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): activities table with one-live-per-step invariant"
```

### Task 1.3: ActivityStore — write path + event emission

**Files:**
- Create: `apps/daemon/src/activities/constants.ts`
- Create: `apps/daemon/src/activities/store.ts`
- Test: `apps/daemon/src/activities/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/store.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrationsOn } from "../migrations"; // use the file's actual exported runner
import { EventBus } from "../events";
import {
  openOrUpdateLive, pauseForInput, completeLive, expireLive,
  getLiveForStepRun, getPausedForGoal, type ActivityStoreCtx,
} from "./store";

function ctxFor(db: Database.Database) {
  const events: Array<{ type: string }> = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  let n = 0;
  const ctx: ActivityStoreCtx = {
    db, bus,
    now: () => "2026-06-05T00:00:00.000Z",
    idFactory: () => `id-${++n}`,
  };
  return { ctx, events };
}

function seedGoal(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at)
              VALUES ('g1','t','active','2026-06-05','2026-06-05')`).run();
}

describe("ActivityStore", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); runMigrationsOn(db); seedGoal(db); });

  const base = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess1" };

  it("opens a live row then updates it in place (one live per step)", () => {
    const { ctx, events } = ctxFor(db);
    const a = openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching…", workCategory: null });
    const b = openOrUpdateLive(ctx, { ...base, sourceKind: "tool_use", currentText: "Reading…", workCategory: "reading" });
    expect(b.id).toBe(a.id);
    expect(b.currentText).toBe("Reading…");
    expect(b.turnOrdinal).toBe(0);
    expect(events.filter((e) => e.type === "activity.changed").length).toBe(2);
  });

  it("opens a new turn after the prior one completes", () => {
    const { ctx } = ctxFor(db);
    const a = openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching…", workCategory: null });
    completeLive(ctx, { stepRunId: "s1", finalSummary: "Done.", confidence: "high" });
    const b = openOrUpdateLive(ctx, { ...base, sourceKind: "tool_use", currentText: "Reading…", workCategory: "reading" });
    expect(b.id).not.toBe(a.id);
    expect(b.turnOrdinal).toBe(1);
    expect(getLiveForStepRun(db, "s1")?.id).toBe(b.id);
  });

  it("pauses with an embedded question and resolves it via getPausedForGoal", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching…", workCategory: null });
    pauseForInput(ctx, { stepRunId: "s1", currentText: "I need your call.",
      pendingQuestion: { questionId: "q1", toolUseId: "t1", questions: [
        { header: "Signals", question: "Which?", multiSelect: true, options: [{ label: "A", description: "x" }] }] } });
    const paused = getPausedForGoal(db, "g1");
    expect(paused?.pendingQuestion?.questionId).toBe("q1");
    expect(paused?.status).toBe("paused_for_input");
  });

  it("expireLive clears the live row without a durable summary", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "weak_signal", currentText: "Still working…", workCategory: null });
    expireLive(ctx, { stepRunId: "s1" });
    expect(getLiveForStepRun(db, "s1")).toBeUndefined();
  });
});
```

> Use the migration runner this codebase actually exposes for an arbitrary `Database` (check `migrations.ts` exports — adapt `runMigrationsOn` to the real name). If only a path-based runner exists, open a temp-file DB instead of `:memory:`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/store.test.ts`
Expected: FAIL — module `./store` not found.

- [ ] **Step 3: Implement constants and store**

Create `apps/daemon/src/activities/constants.ts`:

```ts
/** Minimum gap between live-bubble narration updates (paced narration). */
export const ACTIVITY_THROTTLE_MS = 3_000;
/** Silence after which the live bubble shows a conservative "still working" note. */
export const ACTIVITY_WEAK_SIGNAL_MS = 10_000;
```

Create `apps/daemon/src/activities/store.ts`:

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  Activity, PendingQuestion,
  type Activity as ActivityT,
  type ActivitySourceKind, type ActivityWorkCategory, type ActivityConfidence,
  type PendingQuestion as PendingQuestionT, type DomainEvent,
} from "@orca/contracts";
import type { EventBus } from "../events.js";

export interface ActivityStoreCtx {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory?: () => string;
}

export interface OpenOrUpdateInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  agentSessionId: string | null;
  sourceKind: ActivitySourceKind;
  currentText: string;
  workCategory: ActivityWorkCategory | null;
}

const SELECT_COLS = `id, goal_id, workflow_run_id, step_run_id, agent_session_id,
  turn_ordinal, status, current_text, final_summary, source_kind, work_category,
  confidence, pending_question, created_at, updated_at, completed_at`;

function rowToActivity(row: Record<string, unknown>): ActivityT {
  let pendingQuestion: unknown = undefined;
  if (typeof row.pending_question === "string" && row.pending_question) {
    try {
      const parsed = JSON.parse(row.pending_question);
      if (PendingQuestion.safeParse(parsed).success) pendingQuestion = parsed;
    } catch { /* ignore malformed */ }
  }
  return Activity.parse({
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id, agentSessionId: row.agent_session_id ?? null,
    turnOrdinal: row.turn_ordinal, status: row.status, currentText: row.current_text,
    finalSummary: row.final_summary ?? null, sourceKind: row.source_kind,
    workCategory: row.work_category ?? null, confidence: row.confidence ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at ?? null,
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
  });
}

export function getLiveForStepRun(db: Database.Database, stepRunId: string): ActivityT | undefined {
  const row = db.prepare(
    `SELECT ${SELECT_COLS} FROM activities
       WHERE step_run_id = ? AND status IN ('active','paused_for_input')
       ORDER BY turn_ordinal DESC LIMIT 1`
  ).get(stepRunId) as Record<string, unknown> | undefined;
  return row ? rowToActivity(row) : undefined;
}

export function getPausedForGoal(db: Database.Database, goalId: string): ActivityT | undefined {
  const row = db.prepare(
    `SELECT ${SELECT_COLS} FROM activities
       WHERE goal_id = ? AND status = 'paused_for_input'
       ORDER BY updated_at DESC LIMIT 1`
  ).get(goalId) as Record<string, unknown> | undefined;
  return row ? rowToActivity(row) : undefined;
}

function nextTurnOrdinal(db: Database.Database, stepRunId: string): number {
  const row = db.prepare(
    "SELECT MAX(turn_ordinal) AS max FROM activities WHERE step_run_id = ?"
  ).get(stepRunId) as { max: number | null };
  return row.max == null ? 0 : row.max + 1;
}

/** Inserts an events row + publishes activity.changed, mirroring insertMessageWithEvent. */
function emitChanged(ctx: ActivityStoreCtx, goalId: string, activityId: string, createdAt: string): void {
  const idFactory = ctx.idFactory ?? randomUUID;
  const eventId = idFactory();
  const payload = { activityId };
  const result = ctx.db.prepare(
    "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(eventId, "activity.changed", goalId, JSON.stringify(payload), createdAt);
  const event: DomainEvent = {
    seq: Number(result.lastInsertRowid), id: eventId, type: "activity.changed",
    goalId, payload, createdAt,
  };
  ctx.bus.publish(event);
}

export function openOrUpdateLive(ctx: ActivityStoreCtx, input: OpenOrUpdateInput): ActivityT {
  const idFactory = ctx.idFactory ?? randomUUID;
  const now = ctx.now();
  const live = getLiveForStepRun(ctx.db, input.stepRunId);
  let activityId: string;
  ctx.db.transaction(() => {
    if (live && live.status === "active") {
      activityId = live.id;
      ctx.db.prepare(
        `UPDATE activities SET source_kind = ?, current_text = ?, work_category = ?, updated_at = ?
           WHERE id = ?`
      ).run(input.sourceKind, input.currentText, input.workCategory, now, live.id);
    } else if (live && live.status === "paused_for_input") {
      // A paused turn stays paused until resolved; do not overwrite with narration.
      activityId = live.id;
    } else {
      activityId = idFactory();
      ctx.db.prepare(
        `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id,
           turn_ordinal, status, current_text, source_kind, work_category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).run(activityId, input.goalId, input.workflowRunId, input.stepRunId, input.agentSessionId,
        nextTurnOrdinal(ctx.db, input.stepRunId), input.currentText, input.sourceKind,
        input.workCategory, now, now);
    }
  })();
  emitChanged(ctx, input.goalId, activityId!, now);
  return getLiveForStepRun(ctx.db, input.stepRunId)!;
}

export function pauseForInput(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; currentText: string; pendingQuestion: PendingQuestionT }
): ActivityT | undefined {
  const live = getLiveForStepRun(ctx.db, input.stepRunId);
  if (!live) return undefined;
  const now = ctx.now();
  ctx.db.prepare(
    `UPDATE activities SET status = 'paused_for_input', source_kind = 'question_pending',
       current_text = ?, pending_question = ?, updated_at = ? WHERE id = ?`
  ).run(input.currentText, JSON.stringify(input.pendingQuestion), now, live.id);
  emitChanged(ctx, live.goalId, live.id, now);
  return getLiveForStepRun(ctx.db, input.stepRunId);
}

export function completeLive(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; finalSummary: string; confidence: ActivityConfidence | null }
): ActivityT | undefined {
  const live = getLiveForStepRun(ctx.db, input.stepRunId);
  if (!live) return undefined;
  const now = ctx.now();
  ctx.db.prepare(
    `UPDATE activities SET status = 'completed', source_kind = 'turn_completed',
       final_summary = ?, confidence = ?, pending_question = NULL, updated_at = ?, completed_at = ?
       WHERE id = ?`
  ).run(input.finalSummary, input.confidence, now, now, live.id);
  emitChanged(ctx, live.goalId, live.id, now);
  return undefined;
}

export function expireLive(ctx: ActivityStoreCtx, input: { stepRunId: string }): void {
  const live = getLiveForStepRun(ctx.db, input.stepRunId);
  if (!live) return;
  const now = ctx.now();
  ctx.db.prepare(
    `UPDATE activities SET status = 'expired', pending_question = NULL, updated_at = ?, completed_at = ?
       WHERE id = ?`
  ).run(now, now, live.id);
  emitChanged(ctx, live.goalId, live.id, now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- activities/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/constants.ts apps/daemon/src/activities/store.ts apps/daemon/src/activities/store.test.ts
git commit -m "feat(daemon): ActivityStore with one-live-per-step upsert + events"
```

### Task 1.4: Projection + read route

**Files:**
- Create: `apps/daemon/src/activities/projection.ts`
- Create: `apps/daemon/src/activities/routes.ts`
- Modify: `apps/daemon/src/server.ts` (register the route near other `register*Routes(server, …)` calls)
- Test: `apps/daemon/src/activities/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/routes.test.ts`:

```ts
import Database from "better-sqlite3";
import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { runMigrationsOn } from "../migrations";
import { registerActivityRoutes } from "./routes";

function appWithGoalAndActivity() {
  const db = new Database(":memory:"); runMigrationsOn(db);
  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at)
              VALUES ('g1','t','active','2026-06-05','2026-06-05')`).run();
  db.prepare(`INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, turn_ordinal,
       status, current_text, source_kind, created_at, updated_at)
     VALUES ('a1','g1','r1','s1',0,'active','Watching…','step_started','2026-06-05','2026-06-05')`).run();
  const app = Fastify();
  registerActivityRoutes(app, { db });
  return app;
}

describe("GET /v1/goals/:goalId/activities", () => {
  it("returns the goal's activities", async () => {
    const app = appWithGoalAndActivity();
    const res = await app.inject({ method: "GET", url: "/v1/goals/g1/activities" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].currentText).toBe("Watching…");
  });

  it("returns an empty list for an unknown goal", async () => {
    const app = appWithGoalAndActivity();
    const res = await app.inject({ method: "GET", url: "/v1/goals/none/activities" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/routes.test.ts`
Expected: FAIL — `./routes` / `./projection` not found.

- [ ] **Step 3: Implement projection and route**

Create `apps/daemon/src/activities/projection.ts`:

```ts
import type Database from "better-sqlite3";
import { Activity, PendingQuestion, type Activity as ActivityT } from "@orca/contracts";

const SELECT_COLS = `id, goal_id, workflow_run_id, step_run_id, agent_session_id,
  turn_ordinal, status, current_text, final_summary, source_kind, work_category,
  confidence, pending_question, created_at, updated_at, completed_at`;

function rowToActivity(row: Record<string, unknown>): ActivityT {
  let pendingQuestion: unknown = undefined;
  if (typeof row.pending_question === "string" && row.pending_question) {
    try {
      const parsed = JSON.parse(row.pending_question);
      if (PendingQuestion.safeParse(parsed).success) pendingQuestion = parsed;
    } catch { /* ignore malformed */ }
  }
  return Activity.parse({
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id, agentSessionId: row.agent_session_id ?? null,
    turnOrdinal: row.turn_ordinal, status: row.status, currentText: row.current_text,
    finalSummary: row.final_summary ?? null, sourceKind: row.source_kind,
    workCategory: row.work_category ?? null, confidence: row.confidence ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at ?? null,
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
  });
}

export function listActivitiesByGoal(db: Database.Database, goalId: string): ActivityT[] {
  const rows = db.prepare(
    `SELECT ${SELECT_COLS} FROM activities WHERE goal_id = ?
       ORDER BY created_at ASC, id ASC`
  ).all(goalId) as Array<Record<string, unknown>>;
  return rows.map(rowToActivity);
}
```

Create `apps/daemon/src/activities/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { ListActivitiesResponse } from "@orca/contracts";
import { listActivitiesByGoal } from "./projection.js";

export function registerActivityRoutes(
  server: FastifyInstance,
  deps: { db: Database.Database }
): void {
  server.get("/v1/goals/:goalId/activities", async (request) => {
    const { goalId } = request.params as { goalId: string };
    const items = listActivitiesByGoal(deps.db, goalId);
    return ListActivitiesResponse.parse({ items });
  });
}
```

In `apps/daemon/src/server.ts`, add the import near the other route imports and register it alongside the existing `register*Routes(server, …)` calls (e.g., next to `registerContextRoutes`):

```ts
import { registerActivityRoutes } from './activities/routes.js';
// …
registerActivityRoutes(server, { db });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- activities/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/projection.ts apps/daemon/src/activities/routes.ts apps/daemon/src/server.ts apps/daemon/src/activities/routes.test.ts
git commit -m "feat(daemon): activities read projection + GET route"
```

---

## PHASE 2 — Signals, Claude adapter, paced updater (the narration brain)

Ships: a fully unit-tested `ActivityUpdater` that turns provider-neutral signals into paced activity writes. No wiring yet — pure logic.

### Task 2.1: Provider-neutral signal types + Claude adapter

**Files:**
- Create: `apps/daemon/src/activities/signals.ts`
- Create: `apps/daemon/src/activities/claude-adapter.ts`
- Test: `apps/daemon/src/activities/claude-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/claude-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { categorizeClaudeTool, narrateCategory } from "./claude-adapter";

describe("Claude signal adapter", () => {
  it("maps tool names to work categories", () => {
    expect(categorizeClaudeTool("Read", {})).toBe("reading");
    expect(categorizeClaudeTool("Grep", {})).toBe("searching");
    expect(categorizeClaudeTool("Glob", {})).toBe("searching");
    expect(categorizeClaudeTool("Edit", {})).toBe("editing");
    expect(categorizeClaudeTool("Write", {})).toBe("editing");
    expect(categorizeClaudeTool("Bash", { command: "ls" })).toBe("running");
    expect(categorizeClaudeTool("Bash", { command: "pnpm test" })).toBe("testing");
    expect(categorizeClaudeTool("Bash", { command: "vitest run" })).toBe("testing");
    expect(categorizeClaudeTool("SomethingElse", {})).toBe("other");
  });

  it("produces calm, human-readable narration per category", () => {
    expect(narrateCategory("reading")).toMatch(/codebase/i);
    expect(narrateCategory("testing")).toMatch(/test/i);
    expect(narrateCategory("other")).toMatch(/working/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/claude-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement signals and adapter**

Create `apps/daemon/src/activities/signals.ts`:

```ts
import type { ActivityWorkCategory, ActivityConfidence, PendingQuestion } from "@orca/contracts";

/** Provider-neutral supervision signals. Adapters (e.g. Claude) produce these;
 *  the ActivityUpdater consumes them. No provider concepts leak in here. */
export type ActivitySignal =
  | { kind: "step_started"; goalId: string; workflowRunId: string; stepRunId: string;
      agentSessionId: string | null; stepName: string | null }
  | { kind: "tool_use"; goalId: string; workflowRunId: string; stepRunId: string;
      agentSessionId: string | null; category: ActivityWorkCategory }
  | { kind: "question_pending"; stepRunId: string; text: string; pendingQuestion: PendingQuestion }
  | { kind: "permission_pending"; goalId: string; workflowRunId: string; stepRunId: string;
      agentSessionId: string | null; toolName: string }
  | { kind: "turn_completed"; stepRunId: string; summary: string; confidence: ActivityConfidence | null }
  | { kind: "weak_signal_tick"; goalId: string; workflowRunId: string; stepRunId: string;
      agentSessionId: string | null };
```

Create `apps/daemon/src/activities/claude-adapter.ts`:

```ts
import type { ActivityWorkCategory } from "@orca/contracts";

const TEST_COMMAND = /\b(test|vitest|jest|pytest)\b/i;

export function categorizeClaudeTool(toolName: string, toolInput: unknown): ActivityWorkCategory {
  switch (toolName) {
    case "Read":
      return "reading";
    case "Grep":
    case "Glob":
      return "searching";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "editing";
    case "Bash": {
      const cmd = (toolInput as { command?: string })?.command ?? "";
      return TEST_COMMAND.test(cmd) ? "testing" : "running";
    }
    default:
      return "other";
  }
}

export function narrateCategory(category: ActivityWorkCategory): string {
  switch (category) {
    case "reading":  return "Reading through the codebase…";
    case "searching":return "Searching the codebase…";
    case "editing":  return "Making changes…";
    case "running":  return "Running a command…";
    case "testing":  return "Running the test suite…";
    case "other":    return "Working on the step…";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- activities/claude-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/signals.ts apps/daemon/src/activities/claude-adapter.ts apps/daemon/src/activities/claude-adapter.test.ts
git commit -m "feat(daemon): provider-neutral activity signals + Claude adapter"
```

### Task 2.2: ActivityUpdater — paced narration (coalesce + throttle + reassure)

**Files:**
- Create: `apps/daemon/src/activities/updater.ts`
- Test: `apps/daemon/src/activities/updater.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/activities/updater.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrationsOn } from "../migrations";
import { EventBus } from "../events";
import { getLiveForStepRun, listActivitiesByGoalForTest } from "./store-test-helpers"; // see note
import { listActivitiesByGoal } from "./projection";
import { ActivityUpdater } from "./updater";
import type { ActivityStoreCtx } from "./store";

function setup() {
  const db = new Database(":memory:"); runMigrationsOn(db);
  db.prepare(`INSERT INTO goals (id, title, status, created_at, updated_at)
              VALUES ('g1','t','active','2026-06-05','2026-06-05')`).run();
  let clockMs = 0;
  const ctx: ActivityStoreCtx = {
    db, bus: new EventBus(),
    now: () => new Date(clockMs).toISOString(),
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
  };
  const updater = new ActivityUpdater(() => clockMs);
  const advance = (ms: number) => { clockMs += ms; };
  return { db, ctx, updater, advance };
}

const base = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: "sess1" };

describe("ActivityUpdater paced narration", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });

  it("step_started opens a live bubble naming the step", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Mechanics check" });
    expect(getLiveForStepRun(h.db, "s1")?.currentText).toMatch(/Mechanics check/);
  });

  it("coalesces a burst of same-category tool_use into one update (G6)", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Step" });
    const before = getLiveForStepRun(h.db, "s1")!.updatedAt;
    h.updater.apply(h.ctx, { kind: "tool_use", ...base, category: "reading" });
    h.advance(500);
    h.updater.apply(h.ctx, { kind: "tool_use", ...base, category: "reading" });
    h.advance(500);
    h.updater.apply(h.ctx, { kind: "tool_use", ...base, category: "reading" });
    const live = getLiveForStepRun(h.db, "s1")!;
    expect(live.currentText).toMatch(/codebase/i);
    // Exactly one narration update landed despite three reads within the throttle window.
    const reads = listActivitiesByGoal(h.db, "g1").filter((a) => a.workCategory === "reading");
    expect(reads).toHaveLength(1);
    expect(live.updatedAt).not.toBe(before);
  });

  it("updates immediately when the work category changes", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Step" });
    h.updater.apply(h.ctx, { kind: "tool_use", ...base, category: "reading" });
    h.updater.apply(h.ctx, { kind: "tool_use", ...base, category: "testing" });
    expect(getLiveForStepRun(h.db, "s1")?.currentText).toMatch(/test/i);
  });

  it("emits a weak-signal note only after 10s of silence, and never persists it (G5)", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Step" });
    h.advance(9_000);
    h.updater.apply(h.ctx, { kind: "weak_signal_tick", ...base });
    expect(getLiveForStepRun(h.db, "s1")?.sourceKind).toBe("step_started"); // too soon
    h.advance(2_000);
    h.updater.apply(h.ctx, { kind: "weak_signal_tick", ...base });
    expect(getLiveForStepRun(h.db, "s1")?.sourceKind).toBe("weak_signal");
    // Expire (abandoned) → no durable summary row.
    h.updater.apply(h.ctx, { kind: "turn_completed", stepRunId: "s1", summary: "", confidence: null });
    const durable = listActivitiesByGoal(h.db, "g1").filter(
      (a) => a.status === "completed" && a.finalSummary);
    expect(durable).toHaveLength(0);
  });

  it("turn_completed with a summary persists exactly one durable row", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Step" });
    h.updater.apply(h.ctx, { kind: "turn_completed", stepRunId: "s1", summary: "12/12 pass", confidence: "high" });
    const durable = listActivitiesByGoal(h.db, "g1").filter(
      (a) => a.status === "completed" && a.finalSummary);
    expect(durable).toHaveLength(1);
    expect(durable[0].finalSummary).toBe("12/12 pass");
  });

  it("question_pending pauses the live bubble with the embedded question", () => {
    h.updater.apply(h.ctx, { kind: "step_started", ...base, stepName: "Step" });
    h.updater.apply(h.ctx, { kind: "question_pending", stepRunId: "s1", text: "I need your call.",
      pendingQuestion: { questionId: "q1", toolUseId: "t1", questions: [
        { header: "Signals", question: "Which?", multiSelect: true, options: [{ label: "A", description: "x" }] }] } });
    const live = getLiveForStepRun(h.db, "s1")!;
    expect(live.status).toBe("paused_for_input");
    expect(live.pendingQuestion?.questionId).toBe("q1");
  });
});
```

> `getLiveForStepRun` is exported from `./store`; import it from there (the `store-test-helpers` import above is a naming convenience — replace with `import { getLiveForStepRun } from "./store"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- activities/updater.test.ts`
Expected: FAIL — `./updater` not found.

- [ ] **Step 3: Implement the updater**

Create `apps/daemon/src/activities/updater.ts`:

```ts
import type { ActivityWorkCategory } from "@orca/contracts";
import {
  openOrUpdateLive, pauseForInput, completeLive, expireLive,
  type ActivityStoreCtx,
} from "./store.js";
import { narrateCategory } from "./claude-adapter.js";
import { ACTIVITY_THROTTLE_MS, ACTIVITY_WEAK_SIGNAL_MS } from "./constants.js";
import type { ActivitySignal } from "./signals.js";

interface ThrottleState {
  lastUpdateMs: number;
  lastCategory: ActivityWorkCategory | null;
}

/** Applies provider-neutral signals to the activity store with paced narration:
 *  same-category tool-use inside the throttle window is dropped; category changes
 *  update immediately; weak-signal ticks only fire after silence. */
export class ActivityUpdater {
  private readonly perStep = new Map<string, ThrottleState>();
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  apply(ctx: ActivityStoreCtx, signal: ActivitySignal): void {
    switch (signal.kind) {
      case "step_started": {
        openOrUpdateLive(ctx, {
          goalId: signal.goalId, workflowRunId: signal.workflowRunId, stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId, sourceKind: "step_started",
          currentText: `Watching the step agent start ${signal.stepName ?? "the step"}…`,
          workCategory: null,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: this.nowMs(), lastCategory: null });
        return;
      }
      case "tool_use": {
        const state = this.perStep.get(signal.stepRunId);
        const now = this.nowMs();
        const sameCategory = state?.lastCategory === signal.category;
        const withinWindow = state != null && now - state.lastUpdateMs < ACTIVITY_THROTTLE_MS;
        if (sameCategory && withinWindow) return; // G6: coalesce
        openOrUpdateLive(ctx, {
          goalId: signal.goalId, workflowRunId: signal.workflowRunId, stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId, sourceKind: "tool_use",
          currentText: narrateCategory(signal.category), workCategory: signal.category,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: now, lastCategory: signal.category });
        return;
      }
      case "weak_signal_tick": {
        const state = this.perStep.get(signal.stepRunId);
        const now = this.nowMs();
        if (state != null && now - state.lastUpdateMs < ACTIVITY_WEAK_SIGNAL_MS) return;
        openOrUpdateLive(ctx, {
          goalId: signal.goalId, workflowRunId: signal.workflowRunId, stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId, sourceKind: "weak_signal",
          currentText: "Still working on the step; no new output yet.", workCategory: null,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: now, lastCategory: null });
        return;
      }
      case "permission_pending": {
        openOrUpdateLive(ctx, {
          goalId: signal.goalId, workflowRunId: signal.workflowRunId, stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId, sourceKind: "permission_pending",
          currentText: `The agent wants to run ${signal.toolName} — awaiting your approval.`,
          workCategory: null,
        });
        this.perStep.set(signal.stepRunId, { lastUpdateMs: this.nowMs(), lastCategory: null });
        return;
      }
      case "question_pending": {
        pauseForInput(ctx, {
          stepRunId: signal.stepRunId, currentText: signal.text, pendingQuestion: signal.pendingQuestion,
        });
        return;
      }
      case "turn_completed": {
        const summary = signal.summary.trim();
        if (summary) {
          completeLive(ctx, { stepRunId: signal.stepRunId, finalSummary: summary, confidence: signal.confidence });
        } else {
          expireLive(ctx, { stepRunId: signal.stepRunId }); // G5: nothing meaningful → no durable row
        }
        this.perStep.delete(signal.stepRunId);
        return;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- activities/updater.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/updater.ts apps/daemon/src/activities/updater.test.ts
git commit -m "feat(daemon): ActivityUpdater paced narration (coalesce/throttle/reassure)"
```

---

## PHASE 3 — Wire the updater into live signals + retire transport messages

Ships: real Claude signals drive the activity thread end-to-end on the daemon. After this phase the desktop still renders the old way (Phase 4), but the API + events are live.

### Task 3.1: Non-blocking tool-use hook (G2)

**Files:**
- Modify: `apps/daemon/src/agent-hooks/routes.ts` (add `onToolUse` dep + route)
- Modify: `apps/daemon/src/agent-hooks/hook-settings.ts` (add narration hook + URL)
- Test: `apps/daemon/src/agent-hooks/routes.test.ts`, `apps/daemon/src/agent-hooks/hook-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/agent-hooks/routes.test.ts`:

```ts
it("tool-use hook records narration and never returns a permission decision (G2)", async () => {
  const calls: Array<{ toolName: string }> = [];
  const app = Fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude",
    onWorkerQuestion: async () => "ok", onPermissionRequest: async () => "deny",
    onToolUse: async (_sessionId, p) => { calls.push({ toolName: p.toolName }); },
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/tool-use?sessionId=s1",
    payload: { tool_name: "Read", tool_input: { file_path: "x" }, tool_use_id: "t1" } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(JSON.stringify(body)).not.toMatch(/permissionDecision|behavior/);
  expect(body).toEqual({ continue: true });
  expect(calls).toEqual([{ toolName: "Read" }]);
});

it("tool-use hook ignores AskUserQuestion (handled by elicit)", async () => {
  const calls: string[] = [];
  const app = Fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude",
    onWorkerQuestion: async () => "ok", onPermissionRequest: async () => "deny",
    onToolUse: async (_s, p) => { calls.push(p.toolName); },
  });
  await app.inject({ method: "POST", url: "/v1/agent-hooks/tool-use?sessionId=s1",
    payload: { tool_name: "AskUserQuestion", tool_input: {}, tool_use_id: "t1" } });
  expect(calls).toEqual([]);
});
```

Add to `apps/daemon/src/agent-hooks/hook-settings.test.ts`:

```ts
it("includes a non-blocking PreToolUse '*' narration hook", () => {
  const s = buildAgentHookSettings({ sessionId: "s1", port: 9999, authToken: "tok" });
  const star = s.hooks.PreToolUse?.find((h) => h.matcher === "*");
  expect(star).toBeDefined();
  expect(star!.hooks[0].url).toContain("/v1/agent-hooks/tool-use");
  // AskUserQuestion matcher still present for the elicit flow.
  expect(s.hooks.PreToolUse?.some((h) => h.matcher === "AskUserQuestion")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- agent-hooks`
Expected: FAIL — `onToolUse` not in deps; no `tool-use` route; no `*` PreToolUse hook.

- [ ] **Step 3: Implement the hook**

In `apps/daemon/src/agent-hooks/routes.ts`, add to `AgentHookRouteDeps`:

```ts
  /** Fire-and-forget tool-use narration. MUST NOT influence tool execution. */
  onToolUse(sessionId: string, payload: { toolName: string; toolInput: unknown; toolUseId: string }): Promise<void>;
```

Add the route inside `registerAgentHookRoutes` (after the `permission` route):

```ts
  server.post("/v1/agent-hooks/tool-use", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const body = (request.body ?? {}) as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
    // AskUserQuestion is narrated by the elicit flow; skip to avoid double-narration.
    if (sessionId && body.tool_name && body.tool_name !== "AskUserQuestion") {
      await deps.onToolUse(sessionId, {
        toolName: body.tool_name, toolInput: body.tool_input ?? {}, toolUseId: body.tool_use_id ?? "",
      });
    }
    // Strictly observational: never returns a permission decision (G2).
    return { continue: true };
  });
```

In `apps/daemon/src/agent-hooks/hook-settings.ts`, add the URL helper:

```ts
export function toolUseHookUrl(port: number, sessionId: string): string {
  return `http://127.0.0.1:${port}/v1/agent-hooks/tool-use?sessionId=${encodeURIComponent(sessionId)}`;
}
```

And add a second `PreToolUse` entry in `buildAgentHookSettings` (keep the existing `AskUserQuestion` entry; add the `*` entry):

```ts
      PreToolUse: [
        { matcher: "AskUserQuestion", hooks: [{ type: "http", url: elicitHookUrl(args.port, args.sessionId), headers, timeout: 600 }] },
        { matcher: "*", hooks: [{ type: "http", url: toolUseHookUrl(args.port, args.sessionId), headers, timeout: 5 }] },
      ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- agent-hooks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-hooks/routes.ts apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/routes.test.ts apps/daemon/src/agent-hooks/hook-settings.test.ts
git commit -m "feat(daemon): non-blocking tool-use narration hook"
```

### Task 3.2: Wire updater into server hook handlers + step events

**Files:**
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/server.activity.test.ts` (new)

This task connects signals to the updater. Define a small helper `resolveStepContext(db, sessionId)` returning `{ goalId, workflowRunId, stepRunId, agentSessionId } | null` from the `sessions` row (`sessions.workflow_step_run_id`, `sessions.goal_id`) joined to the step run's `workflow_run_id`. The updater + `ctx` are created once and reused.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/server.activity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTestServer } from "./test-helpers"; // use this file's real server-with-db harness

// This is an integration smoke test: a tool-use hook for a live workflow-step
// session produces a live activity readable via the API.
describe("activity wiring", () => {
  it("a tool-use hook creates a live activity for the step", async () => {
    const { app, seedActiveWorkflowSession } = await buildTestServer();
    const { goalId, sessionId } = seedActiveWorkflowSession(); // helper inserts goal/run/step/session
    await app.inject({ method: "POST", url: `/v1/agent-hooks/tool-use?sessionId=${sessionId}`,
      payload: { tool_name: "Read", tool_input: { file_path: "x" }, tool_use_id: "t1" } });
    const res = await app.inject({ method: "GET", url: `/v1/goals/${goalId}/activities` });
    expect(res.json().items.some((a: { currentText: string }) => /codebase/i.test(a.currentText))).toBe(true);
  });
});
```

> Match this codebase's existing server integration-test harness (see `server.test.ts` / `server.permission-flow.test.ts`) for `buildTestServer` and a seed helper. If no seed helper exists, insert the `goals`/`workflow_runs`/`workflow_step_runs`/`sessions` rows inline using the column shapes those tables already use, ensuring `sessions.workflow_step_run_id` and `sessions.goal_id` are set and the step run is `active`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- server.activity.test.ts`
Expected: FAIL — `onToolUse` not yet wired in `server.ts` (no handler passed), so no activity appears.

- [ ] **Step 3: Wire the updater in `server.ts`**

Near the daemon-context/event setup, construct the updater and a context factory:

```ts
import { ActivityUpdater } from './activities/updater.js';
import { categorizeClaudeTool } from './activities/claude-adapter.js';
import type { ActivityStoreCtx } from './activities/store.js';

const activityUpdater = new ActivityUpdater();
const activityCtx: ActivityStoreCtx = {
  db, bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory,
};

/** Resolve the goal/run/step context for a worker session, or null if unattributable (G7). */
function resolveStepContext(sessionId: string): {
  goalId: string; workflowRunId: string; stepRunId: string; agentSessionId: string;
} | null {
  const row = db.prepare(
    `SELECT s.goal_id AS goalId, s.workflow_step_run_id AS stepRunId, wr.id AS workflowRunId
       FROM sessions s
       JOIN workflow_step_runs sr ON sr.id = s.workflow_step_run_id
       JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
      WHERE s.id = ?`
  ).get(sessionId) as { goalId: string; stepRunId: string; workflowRunId: string } | undefined;
  if (!row?.stepRunId) return null;
  return { ...row, agentSessionId: sessionId };
}
```

Pass `onToolUse` into `registerAgentHookRoutes(server, { … })`:

```ts
    onToolUse: async (sessionId, payload) => {
      const c = resolveStepContext(sessionId);
      if (!c) return; // G7
      activityUpdater.apply(activityCtx, {
        kind: "tool_use", goalId: c.goalId, workflowRunId: c.workflowRunId,
        stepRunId: c.stepRunId, agentSessionId: c.agentSessionId,
        category: categorizeClaudeTool(payload.toolName, payload.toolInput),
      });
    },
```

In the existing `onPermissionRequest` handler, after computing `behavior`, narrate (do not change the decision):

```ts
      const c = resolveStepContext(sessionId);
      if (c) activityUpdater.apply(activityCtx, {
        kind: "permission_pending", goalId: c.goalId, workflowRunId: c.workflowRunId,
        stepRunId: c.stepRunId, agentSessionId: c.agentSessionId, toolName: payload.toolName,
      });
```

In `onResponseDone` (server.ts:1105) — the turn-completion signal — add after the existing logic:

```ts
      const c = resolveStepContext(payload.sessionId);
      if (c) activityUpdater.apply(activityCtx, {
        kind: "turn_completed", stepRunId: c.stepRunId,
        summary: deriveTurnSummary(payload.responseText), confidence: null,
      });
```

Add a small deterministic summarizer near the helpers (first non-empty line, capped — no LLM):

```ts
/** Deterministic, no-LLM turn summary: first meaningful line of the agent's last
 *  message, capped. Empty input yields "" (→ activity expires, no durable row). */
function deriveTurnSummary(responseText: string): string {
  const line = responseText.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.slice(0, 280);
}
```

Subscribe to `workflow.step.started` to open the activity at step start:

```ts
eventBus.subscribe((event) => {
  if (event.type !== "workflow.step.started") return;
  const stepRunId = (event.payload as { stepRunId?: string }).stepRunId;
  if (!stepRunId || !event.goalId) return;
  const row = db.prepare(
    `SELECT sr.workflow_run_id AS workflowRunId, st.name AS stepName,
            (SELECT id FROM sessions WHERE workflow_step_run_id = sr.id ORDER BY created_at DESC LIMIT 1) AS sessionId
       FROM workflow_step_runs sr LEFT JOIN workflow_steps st ON st.id = sr.workflow_step_id
      WHERE sr.id = ?`
  ).get(stepRunId) as { workflowRunId: string; stepName: string | null; sessionId: string | null } | undefined;
  if (!row) return;
  activityUpdater.apply(activityCtx, {
    kind: "step_started", goalId: event.goalId, workflowRunId: row.workflowRunId,
    stepRunId, agentSessionId: row.sessionId, stepName: row.stepName,
  });
});
```

> Verify the real column names for `workflow_step_runs` → step definition and the `workflow.step.started` payload field (`stepRunId`). Adjust the joins to the actual schema; the shape above matches the patterns already used in `server.ts` (e.g. the boot reconcile query at server.ts:587).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- server.activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.activity.test.ts
git commit -m "feat(daemon): drive activity thread from Claude hook + step signals"
```

### Task 3.3: Route worker questions through the activity (pause) + drop transport messages

**Files:**
- Modify: `apps/daemon/src/server.ts` (`onWorkerQuestion` handler ~1149; `/answer` route ~1189)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`acknowledgeUserMessageAction` ~739)
- Test: `apps/daemon/src/server.activity.test.ts`, `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/server.activity.test.ts`:

```ts
it("a worker question pauses the activity and embeds the question (no chat row)", async () => {
  const { app, seedActiveWorkflowSession, listChatMessages } = await buildTestServer();
  const { goalId, sessionId } = seedActiveWorkflowSession();
  // Fire the elicit hook in the background (it holds open until answered/timeout).
  void app.inject({ method: "POST", url: `/v1/agent-hooks/elicit?sessionId=${sessionId}`,
    payload: { tool_use_id: "t1", tool_input: { questions: [
      { header: "Signals", question: "Which passed?", multiSelect: true, options: [{ label: "A", description: "x" }] }] } } });
  await new Promise((r) => setTimeout(r, 20));
  const res = await app.inject({ method: "GET", url: `/v1/goals/${goalId}/activities` });
  const paused = res.json().items.find((a: { status: string }) => a.status === "paused_for_input");
  expect(paused.pendingQuestion.questions[0].options[0].label).toBe("A"); // G4 lossless
  // The old "The agent needs your input." chat row is no longer posted.
  expect(listChatMessages(goalId).some((m: { body: string }) => /needs your input/.test(m.body))).toBe(false);
});
```

Add to `service.agent-step.test.ts` (forward path no longer posts the relay ack):

```ts
it("forward_to_agent does not post a 'Relayed your message' chat row", async () => {
  // Arrange the existing forward_to_agent scenario used elsewhere in this file,
  // with a live session so delivery succeeds, then assert no relay-ack message:
  const messages = listChatMessagesForGoal(goalId); // reuse this file's helper
  expect(messages.some((m) => /Relayed your message/.test(m.body))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- server.activity.test.ts service.agent-step.test.ts`
Expected: FAIL — question still posts a chat row; relay ack still posted.

- [ ] **Step 3: Implement**

In `server.ts` `onWorkerQuestion` (server.ts:1149), replace the `insertMessageWithEvent({ … body: "The agent needs your input." … })` block with an activity pause (keep the `workerQuestions.record(...)` call and the held-promise logic unchanged):

```ts
      if (isNew) {
        const c = resolveStepContext(sessionId);
        if (c) {
          activityUpdater.apply(activityCtx, {
            kind: "question_pending", stepRunId: c.stepRunId,
            text: orcaVoiceQuestionText(payload.questions),
            pendingQuestion: { questionId, toolUseId: payload.toolUseId, questions: payload.questions },
          });
        }
      }
```

Add the deterministic Orca-voice templater (hybrid presentation, decision #7) near the helpers:

```ts
import type { PendingQuestionItem } from "@orca/contracts";

/** Deterministic Orca-voice lead-in for a worker question. No LLM (held path). */
function orcaVoiceQuestionText(questions: PendingQuestionItem[]): string {
  const first = questions[0];
  if (!first) return "I need your input to continue.";
  return questions.length === 1
    ? `I need your call on ${first.header.toLowerCase()}.`
    : `I need your input on a few things, starting with ${first.header.toLowerCase()}.`;
}
```

In the `/answer` route (server.ts:1189), after `workerQuestions.resolveAnswers(...)` succeeds, also complete the activity so the bubble closes with a durable supervision summary:

```ts
    const c = resolveStepContext(pending.sessionId);
    if (c) {
      const headers = pending.questions.map((q) => q.header).join(", ");
      activityUpdater.apply(activityCtx, {
        kind: "turn_completed", stepRunId: c.stepRunId,
        summary: `Asked about ${headers}; recorded your answer.`, confidence: null,
      });
    }
```

In `service.ts` `acknowledgeUserMessageAction` (service.ts:739), the `forward_to_agent` success branch should no longer surface a durable relay ack. Change the success case to return an empty string and have the caller skip posting when empty. Locate the caller of `acknowledgeUserMessageAction` and guard the post:

```ts
      case "forward_to_agent":
        return sessionId
          ? "" // success is shown via the activity thread, not a chat row
          : "Couldn't relay your message — no live agent session for the current step. It may need to be respawned.";
```

At the call site that posts this acknowledgment, wrap the post:

```ts
      const ack = this.acknowledgeUserMessageAction(action, sessionId);
      if (ack) this.postOrchestratorMessage(db, now, ctx.run.goalId, ack, options);
```

> Keep the failure strings (no live session, etc.) — only the success relay ack is removed (decision #11). Find the exact call site by searching for `acknowledgeUserMessageAction(` in `service.ts` and apply the `if (ack)` guard there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- server.activity.test.ts service.agent-step.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.activity.test.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): mediate worker questions via activity; drop relay-ack chat row"
```

---

## PHASE 4 — Desktop rendering + scaffold retirement

Ships: the user sees the activity thread; transport noise and dead scaffold are gone.

### Task 4.1: API client — listActivities + activity.changed

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/api.test.ts` (mirror the existing client-fn tests there, which mock `fetch`):

```ts
it("listActivities GETs the goal activities and parses them", async () => {
  mockFetchOnce({ items: [{
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
    turnOrdinal: 0, status: "active", currentText: "Watching…", finalSummary: null,
    sourceKind: "step_started", workCategory: null, confidence: null,
    createdAt: "2026-06-05T00:00:00.000Z", updatedAt: "2026-06-05T00:00:00.000Z", completedAt: null,
  }] });
  const items = await listActivities("g1");
  expect(items[0].currentText).toBe("Watching…");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- api.test.ts`
Expected: FAIL — `listActivities` not exported.

- [ ] **Step 3: Implement the client function**

In `apps/desktop/src/api.ts`, add (mirroring an existing `requestJson`-based GET such as the orchestrator-messages client):

```ts
import { ListActivitiesResponse, type Activity } from "@orca/contracts";

export async function listActivities(goalId: string): Promise<Activity[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await requestJson<unknown>(`${baseUrl}/v1/goals/${goalId}/activities`, {
    headers: authHeaders(token),
  });
  return ListActivitiesResponse.parse(res).items;
}
```

> Match the exact request helper the neighbouring client functions use (`requestJson`/`authHeaders`/`loadConfig` per api.ts:223/279). If they pass `{ method: "GET" }` explicitly, do the same.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): listActivities API client"
```

### Task 4.2: ActivityThread component

**Files:**
- Create: `apps/desktop/src/orchestrator/ActivityThread.tsx`
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

The component receives the goal's `Activity[]`, renders (a) meaningful completed summaries inline in order, and (b) the single live (`active`/`paused_for_input`) bubble at the bottom. Paused renders the existing `WorkerQuestionForm` from the embedded `pendingQuestion`. Recommendation badge: if an option label ends with `(Recommended)`, render a badge and strip the suffix (decision #8, best-effort).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/orchestrator/ActivityThread.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActivityThread } from "./ActivityThread";
import type { Activity } from "@orca/contracts";

const mk = (over: Partial<Activity>): Activity => ({
  id: "a", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "active", currentText: "Watching…", finalSummary: null,
  sourceKind: "step_started", workCategory: null, confidence: null,
  createdAt: "2026-06-05T00:00:00.000Z", updatedAt: "2026-06-05T00:00:00.000Z", completedAt: null,
  ...over,
});

describe("ActivityThread", () => {
  it("renders the live bubble's current text", () => {
    render(<ActivityThread goalId="g1" activities={[mk({ currentText: "Reading through the codebase…" })]} />);
    expect(screen.getByText("Reading through the codebase…")).toBeInTheDocument();
  });

  it("renders a meaningful completed summary but not an expired one (G5)", () => {
    render(<ActivityThread goalId="g1" activities={[
      mk({ id: "c1", status: "completed", finalSummary: "12/12 pass", sourceKind: "turn_completed" }),
      mk({ id: "x1", status: "expired", finalSummary: null, sourceKind: "weak_signal" }),
    ]} />);
    expect(screen.getByText("12/12 pass")).toBeInTheDocument();
    expect(screen.queryByText(/still working/i)).not.toBeInTheDocument();
  });

  it("renders the embedded question card when paused", () => {
    render(<ActivityThread goalId="g1" activities={[mk({
      status: "paused_for_input", currentText: "I need your call on signals.",
      sourceKind: "question_pending",
      pendingQuestion: { questionId: "q1", toolUseId: "t1", questions: [
        { header: "Signals", question: "Which passed?", multiSelect: true,
          options: [{ label: "A", description: "x" }] }] },
    })]} />);
    expect(screen.getByText("I need your call on signals.")).toBeInTheDocument();
    expect(screen.getByText(/which passed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- ActivityThread.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/desktop/src/orchestrator/ActivityThread.tsx`:

```tsx
import type { Activity } from "@orca/contracts";
import { WorkerQuestionForm } from "./OrcaChat"; // export it from OrcaChat (Task 4.3)

function isMeaningfulCompleted(a: Activity): boolean {
  return a.status === "completed" && !!a.finalSummary && a.sourceKind !== "weak_signal";
}

export function ActivityThread({ goalId, activities }: { goalId: string; activities: Activity[] }) {
  const completed = activities.filter(isMeaningfulCompleted);
  const live = activities.find((a) => a.status === "active" || a.status === "paused_for_input") ?? null;
  return (
    <div className="activity-thread">
      {completed.map((a) => (
        <div key={a.id} className="activity-summary" data-testid="activity-summary">
          {a.finalSummary}
        </div>
      ))}
      {live && (
        <div className="activity-bubble" data-testid="activity-bubble" data-status={live.status}>
          <div className="activity-bubble-text">{live.currentText}</div>
          {live.status === "paused_for_input" && live.pendingQuestion && (
            <WorkerQuestionForm goalId={goalId} pending={live.pendingQuestion} />
          )}
        </div>
      )}
    </div>
  );
}
```

> If `WorkerQuestionForm` already handles the `(Recommended)` label convention, do nothing extra. Otherwise add best-effort badge detection inside that form: when an option `label` ends with `" (Recommended)"`, strip the suffix for display and render a small "Recommended" badge. Keep it purely presentational (decision #8).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- ActivityThread.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): ActivityThread (live bubble + meaningful summaries + question card)"
```

### Task 4.3: Integrate into OrcaChat; remove routing flag + dead scaffold

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx`:

```tsx
it("renders the activity thread and no longer shows a 'routing' indicator", async () => {
  // Use this file's existing render harness with a goal that has an active step
  // and one live activity returned by the mocked listActivities.
  renderOrcaChatWith({ activities: [{ /* mk active activity, currentText: "Reading…" */ } as any] });
  expect(await screen.findByTestId("activity-bubble")).toBeInTheDocument();
  expect(screen.queryByText("routing")).not.toBeInTheDocument();
});
```

> Reuse the file's existing mocking approach (it already mocks the API and event stream). Add `listActivities` to the mocked api module returning the supplied activities.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- OrcaChat.test.tsx`
Expected: FAIL — no `activity-bubble`; `routing` still present.

- [ ] **Step 3: Implement integration + cleanup**

In `OrcaChat.tsx`:

1. Add activity state + load it on `refreshNonce`/goal change (mirror the messages effect at OrcaChat.tsx:269), and add `"activity.changed"` to the event-stream refresh predicate (OrcaChat.tsx:280):

```ts
const [activities, setActivities] = useState<Activity[]>([]);
// inside the load effect keyed on [refreshNonce, selectedGoalId]:
if (selectedGoalId) setActivities(await listActivities(selectedGoalId));
// in the onEvent predicate:
event.type === "activity.changed" ||
```

2. `export` `WorkerQuestionForm` (currently a local function at OrcaChat.tsx:692) so `ActivityThread` can import it.

3. Render `<ActivityThread goalId={selectedGoalId ?? ""} activities={activities} />` just above the awaiting-reply indicator (OrcaChat.tsx:586).

4. Remove the two `{… && <ThinkingRow label="routing" />}` lines (OrcaChat.tsx:439, 543).

5. Remove the dead render branches for roles that are never produced (decision #10): delete the `if (message.role === "internal_thought") { … }` block (OrcaChat.tsx:552) and the `if (message.role === "agent_paraphrased") { … }` block (OrcaChat.tsx:562), plus the now-unused imports `InternalThoughtRow` and `AgentParaphrasedMessage` and the `showMarkDoneCard`/`MarkDoneConfirmCard` block (OrcaChat.tsx:575) if `mark_done_ready` is never set (it isn't). Keep the default `ChatMessageRow` path.

> Removing these branches is safe because no production path ever sets those roles or `internalKind` (verified during design). If any of the deleted symbols (`InternalThoughtRow`, `AgentParaphrasedMessage`, `MarkDoneConfirmCard`) become unreferenced, delete their imports too; leave their component files in place unless they are now entirely unused across the app (mention, don't mass-delete, per CLAUDE.md §3).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- OrcaChat.test.tsx`
Expected: PASS. Also run the full desktop suite to catch any tests that asserted the removed branches: `pnpm --filter @orca/desktop test`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): render ActivityThread; remove routing flag + dead chat-role branches"
```

---

## PHASE 5 — Full verification + cleanup

### Task 5.1: End-to-end + guardrail verification

- [x] **Step 1: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. Pay attention to `server.test.ts` / `server.permission-flow.test.ts` — the permission/elicit flow must be unchanged (G2).
Result: PASS — 1729 passed / 7 skipped, verified green across 3 consecutive full-suite runs (see Step-1 note below).

> Verification surfaced a load-sensitive flake in `worker-session.test.ts` (the
> watcher fixes from the prior `chore: activity thread verification fixes`
> commit): `fs.watchFile` takes its baseline stat asynchronously, so bytes
> appended between tail setup and that first stat were folded into the baseline
> and never reported under full-suite parallel load. Fixed by driving the tail
> from a self-managed `setInterval(pump)` (idempotent `pos→EOF` read) instead of
> watchFile's change events — deterministic, no baseline race. Cleanup +
> exception-safety from the prior commit are preserved.

- [x] **Step 2: Run the full desktop suite**

Run: `pnpm --filter @orca/desktop test`
Expected: PASS.
Result: PASS — 469 passed.

- [x] **Step 3: Run contracts + typecheck + lint across the workspace**

Run: `pnpm --filter @orca/contracts test && pnpm -r typecheck && pnpm -r lint`
Expected: PASS. Fix any `knip` unused-export complaints for symbols the scaffold removal orphaned.
Result: PASS — contracts 150 passed; typecheck green for all 3 projects; root `lint` is a no-op, so ran `pnpm knip` instead. knip's only feature-introduced orphan was the unused `getActivityById` export in `activities/projection.ts` (store.ts has its own private copy) — removed. Remaining knip findings are all pre-existing repo-wide unused exports out of scope for this branch.

- [ ] **Step 4: Manual smoke (optional but recommended)** — NOT RUN

Use the live daemon in the `daemon-terminal` tmux session. Start a goal's workflow, watch the Orca chat: confirm one live bubble that updates through reading/testing phases, a paused question card on `AskUserQuestion`, a single concise summary on completion, and no `routing` / `Relayed your message` / `The agent needs your input.` rows.

- [x] **Step 5: Commit any verification fixes**

```bash
git add -A
git commit -m "chore: activity thread verification fixes"
```

---

## Self-Review (completed against the spec)

**Spec coverage:**
- Single live updating bubble per turn → Tasks 1.3 (one-live invariant), 2.2 (updater), 4.2/4.3 (render). ✅
- Transport details out of chat → Task 3.3 (relay ack), 4.3 (routing flag). ✅
- Persist concise final summary only when meaningful → Task 2.2 (complete vs expire), 4.2 (predicate). ✅
- Worker questions Orca-mediated, lossless, recommendations preserved → Task 3.3 (pause + Orca voice), 4.2 (badge), G4 (round-trip unchanged). ✅
- Provider-neutral contract, Claude first, Codex deferred → Tasks 2.1 (signals/adapter split). ✅
- Weak-signal handling → Task 2.2 (10s tick). ✅
- Data model as first-class projection → Tasks 1.1/1.2. ✅
- Event flow (signal → normalize → update → event → desktop refresh) → Tasks 3.x + 4.x. ✅
- Retire `internal_thought` scaffold → Task 4.3. ✅
- Testing strategy bullets → covered across store/updater/routes/component tests. ✅

**Open item to confirm during execution (not a blocker):** the exact `workflow.step.started` payload field and the `workflow_step_runs`→step-name join (Task 3.2 Step 3) — verify against the live schema and adjust the query; everything else is self-contained.

**Type consistency:** `Activity`, `ActivitySignal` kinds, store fns (`openOrUpdateLive`/`pauseForInput`/`completeLive`/`expireLive`/`getLiveForStepRun`/`getPausedForGoal`), `ActivityUpdater.apply`, `categorizeClaudeTool`/`narrateCategory`, `listActivities`, `ActivityThread` props, `WorkerQuestionForm` export — all referenced consistently across tasks.
