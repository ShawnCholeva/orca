# Supervised Step-Completion Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold each approved+scored worker step at a user checkpoint (in supervised mode) before terminating the worker and advancing, let the user Continue or refine via the live worker, and persist the orchestrator-vs-user divergence signal when they refine.

**Architecture:** A global `supervision_mode` app setting (default supervised) is read by the orchestrator at the `approve_step_complete` gate. Supervised → stash the completion on the step run, pause the step's activity (`paused_for_input` + new `step_confirmation_pending` source kind), and return without terminating/advancing. A new `POST /v1/workflows/runs/:id/confirm-step` runs the existing terminal tail. Refining (user chat → `forward_to_agent` to the live worker) clears the stash, writes a `step_revision_signals` row, and resumes the activity; re-completion re-scores and re-pauses. Unsupervised mode is unchanged.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Zod (`@orca/contracts`), Vitest, React + Vite (desktop).

**Spec:** `docs/superpowers/specs/2026-06-11-supervised-step-completion-checkpoints-design.md`

---

## Conventions for every task

- Daemon tests: `pnpm --filter @orca/daemon test <path>` (optionally `-t "<name>"`).
- Contracts tests: `pnpm --filter @orca/contracts test <path>`.
- Desktop tests: `pnpm --filter @orca/desktop test <path>`.
- **Contracts are consumed via `dist`.** After editing `packages/contracts/src/index.ts`, run `pnpm --filter @orca/contracts build` before daemon/desktop typecheck or tests will see the change.
- Migrations are plain SQL files in `apps/daemon/migrations/` and must be appended to the `migrationFiles` array in `apps/daemon/src/migrations.ts`.

---

## Phase 1 — Contracts

### Task 1: Settings contract (supervision mode)

**Files:**
- Modify: `packages/contracts/src/index.ts` (append near the end, after `ListActivitiesResponse`)
- Test: `packages/contracts/src/settings.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SupervisionMode, AppSettings, PutSettingsRequest } from "./index.js";

describe("settings contracts", () => {
  it("accepts both supervision modes", () => {
    expect(SupervisionMode.parse("supervised")).toBe("supervised");
    expect(SupervisionMode.parse("unsupervised")).toBe("unsupervised");
  });

  it("rejects unknown modes", () => {
    expect(() => SupervisionMode.parse("auto")).toThrow();
  });

  it("AppSettings round-trips", () => {
    const s = AppSettings.parse({ supervisionMode: "supervised" });
    expect(s.supervisionMode).toBe("supervised");
  });

  it("PutSettingsRequest requires a valid mode", () => {
    expect(() => PutSettingsRequest.parse({})).toThrow();
    expect(PutSettingsRequest.parse({ supervisionMode: "unsupervised" }).supervisionMode).toBe(
      "unsupervised"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test src/settings.test.ts`
Expected: FAIL — `SupervisionMode` is not exported.

- [ ] **Step 3: Add the schemas**

Append to `packages/contracts/src/index.ts`:

```ts
export const SupervisionMode = z.enum(["supervised", "unsupervised"]);
export type SupervisionMode = z.infer<typeof SupervisionMode>;

export const AppSettings = z.object({ supervisionMode: SupervisionMode }).strict();
export type AppSettings = z.infer<typeof AppSettings>;

export const PutSettingsRequest = z.object({ supervisionMode: SupervisionMode }).strict();
export type PutSettingsRequest = z.infer<typeof PutSettingsRequest>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/settings.test.ts
git commit -m "feat(contracts): supervision-mode app settings schema"
```

---

### Task 2: Add `step_confirmation_pending` activity source kind

**Files:**
- Modify: `packages/contracts/src/index.ts:1047` (`ActivitySourceKind` enum)
- Test: `packages/contracts/src/index.test.ts` (or create `packages/contracts/src/activity-confirmation.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/activity-confirmation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActivitySourceKind, Activity } from "./index.js";

describe("step_confirmation_pending source kind", () => {
  it("is a valid source kind", () => {
    expect(ActivitySourceKind.parse("step_confirmation_pending")).toBe(
      "step_confirmation_pending"
    );
  });

  it("Activity accepts a paused confirmation row", () => {
    const a = Activity.parse({
      id: "a1",
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1",
      agentSessionId: "sess1",
      turnOrdinal: 2,
      status: "paused_for_input",
      currentText: "Completeness 90% · Correctness 85% · Ready for handoff",
      finalSummary: null,
      sourceKind: "step_confirmation_pending",
      workCategory: null,
      confidence: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      completedAt: null
    });
    expect(a.sourceKind).toBe("step_confirmation_pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test src/activity-confirmation.test.ts`
Expected: FAIL — enum rejects `step_confirmation_pending`.

- [ ] **Step 3: Add the enum member**

In `packages/contracts/src/index.ts`, edit `ActivitySourceKind` (line ~1047) to add the member after `"step_result"`:

```ts
export const ActivitySourceKind = z.enum([
  "step_started",
  "tool_use",
  "question_pending",
  "permission_pending",
  "turn_completed",
  "weak_signal",
  "step_result",
  "step_confirmation_pending"
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test src/activity-confirmation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/activity-confirmation.test.ts
git commit -m "feat(contracts): step_confirmation_pending activity source kind"
```

---

### Task 3: Revision-signal contract

**Files:**
- Modify: `packages/contracts/src/index.ts` (append after the settings schemas from Task 1)
- Test: `packages/contracts/src/revision-signal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { StepRevisionSignal } from "./index.js";

describe("StepRevisionSignal", () => {
  it("round-trips a signal", () => {
    const s = StepRevisionSignal.parse({
      id: "sig1",
      stepRunId: "s1",
      goalId: "g1",
      revisionIndex: 0,
      supersededScoring: {
        successScore: 0.9,
        quality: {
          outputCompleteness: 0.9,
          outputCorrectness: 0.85,
          instructionAdherence: 0.95,
          downstreamReadiness: 0.8,
          riskLevel: 0.1
        },
        reason: "looks good",
        handoffReady: true
      },
      feedbackText: "please add error handling",
      createdAt: "2026-06-11T00:00:00.000Z"
    });
    expect(s.revisionIndex).toBe(0);
    expect(s.supersededScoring.successScore).toBe(0.9);
  });

  it("allows null feedback", () => {
    const s = StepRevisionSignal.parse({
      id: "sig2",
      stepRunId: "s1",
      goalId: "g1",
      revisionIndex: 1,
      supersededScoring: {
        successScore: 0.5,
        quality: {
          outputCompleteness: 0.5,
          outputCorrectness: 0.5,
          instructionAdherence: 0.5,
          downstreamReadiness: 0.5,
          riskLevel: 0.5
        },
        reason: "partial",
        handoffReady: false
      },
      feedbackText: null,
      createdAt: "2026-06-11T00:00:00.000Z"
    });
    expect(s.feedbackText).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test src/revision-signal.test.ts`
Expected: FAIL — `StepRevisionSignal` not exported.

- [ ] **Step 3: Add the schema**

`StepResultScoringProposal` already exists in `packages/contracts/src/index.ts` (imported by the daemon at `service.ts:6`). Reuse it. Append:

```ts
export const StepRevisionSignal = z
  .object({
    id: z.string(),
    stepRunId: z.string(),
    goalId: z.string(),
    revisionIndex: z.number().int().nonnegative(),
    supersededScoring: StepResultScoringProposal,
    feedbackText: z.string().max(4000).nullable(),
    createdAt: z.string()
  })
  .strict();
export type StepRevisionSignal = z.infer<typeof StepRevisionSignal>;
```

> If `StepResultScoringProposal` is declared **below** this insertion point in the file, place this block after its declaration instead (Zod references must be defined before use).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test src/revision-signal.test.ts`
Expected: PASS.

- [ ] **Step 5: Build contracts + commit**

```bash
pnpm --filter @orca/contracts build
git add packages/contracts/src/index.ts packages/contracts/src/revision-signal.test.ts packages/contracts/dist
git commit -m "feat(contracts): step revision-signal schema"
```

---

## Phase 2 — Migrations

### Task 4: `app_settings` table

**Files:**
- Create: `apps/daemon/migrations/0026_app_settings.sql`
- Modify: `apps/daemon/src/migrations.ts` (`migrationFiles` array, after `"0025_activity_step_result.sql"`)
- Test: `apps/daemon/src/migrations.test.ts` (add a case) — verify via the daemon migration test harness.

- [ ] **Step 1: Write the migration SQL**

Create `apps/daemon/migrations/0026_app_settings.sql`:

```sql
-- Global key/value app settings. First key: supervision_mode
-- ('supervised' | 'unsupervised'). Absence of the row means supervised.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: Register the migration**

In `apps/daemon/src/migrations.ts`, add to the `migrationFiles` array after `"0025_activity_step_result.sql"`:

```ts
  "0026_app_settings.sql",
```

- [ ] **Step 3: Write a failing test**

Add to `apps/daemon/src/migrations.test.ts` (follow the existing pattern in that file — open an in-memory DB, run migrations, assert the table exists):

```ts
it("creates the app_settings table", () => {
  const db = freshMigratedDb(); // existing helper in this test file
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'")
    .get();
  expect(row).toBeTruthy();
});
```

> If the test file uses a different helper name for a migrated DB, match it. Inspect the top of `apps/daemon/src/migrations.test.ts` first.

- [ ] **Step 4: Run test**

Run: `pnpm --filter @orca/daemon test src/migrations.test.ts`
Expected: PASS (migration applied, table present).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0026_app_settings.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): app_settings table migration"
```

---

### Task 5: `pending_completion_json` column on step runs

**Files:**
- Create: `apps/daemon/migrations/0027_step_run_pending_completion.sql`
- Modify: `apps/daemon/src/migrations.ts`
- Test: `apps/daemon/src/migrations.test.ts`

- [ ] **Step 1: Write the migration SQL**

Create `apps/daemon/migrations/0027_step_run_pending_completion.sql`:

```sql
-- Supervised-mode stash: the approved completion (orca:step-complete block,
-- validated scoring proposal, finishedAt) held while a step waits at the
-- user confirmation checkpoint. NULL when not paused.
ALTER TABLE workflow_step_runs
  ADD COLUMN pending_completion_json TEXT;
```

- [ ] **Step 2: Register the migration**

Add `"0027_step_run_pending_completion.sql",` after `"0026_app_settings.sql",` in `migrationFiles`.

- [ ] **Step 3: Write a failing test**

```ts
it("adds pending_completion_json to workflow_step_runs", () => {
  const db = freshMigratedDb();
  const cols = db.prepare("PRAGMA table_info(workflow_step_runs)").all() as { name: string }[];
  expect(cols.map((c) => c.name)).toContain("pending_completion_json");
});
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @orca/daemon test src/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0027_step_run_pending_completion.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): step-run pending_completion_json column"
```

---

### Task 6: `step_revision_signals` table

**Files:**
- Create: `apps/daemon/migrations/0028_step_revision_signals.sql`
- Modify: `apps/daemon/src/migrations.ts`
- Test: `apps/daemon/src/migrations.test.ts`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Divergence signal: the user refined a step the orchestrator had already
-- approved and scored. One row per refinement.
CREATE TABLE IF NOT EXISTS step_revision_signals (
  id                      TEXT PRIMARY KEY,
  step_run_id             TEXT NOT NULL,
  goal_id                 TEXT NOT NULL,
  revision_index          INTEGER NOT NULL,
  superseded_scoring_json TEXT NOT NULL,
  feedback_text           TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_revision_signals_step_run
  ON step_revision_signals (step_run_id);
```

- [ ] **Step 2: Register the migration**

Add `"0028_step_revision_signals.sql",` after `"0027_step_run_pending_completion.sql",`.

- [ ] **Step 3: Write a failing test**

```ts
it("creates step_revision_signals with a step_run index", () => {
  const db = freshMigratedDb();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step_revision_signals'")
    .get();
  expect(table).toBeTruthy();
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_step_revision_signals_step_run'")
    .get();
  expect(idx).toBeTruthy();
});
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @orca/daemon test src/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0028_step_revision_signals.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): step_revision_signals table migration"
```

---

## Phase 3 — Daemon settings store + routes

### Task 7: Settings store module

**Files:**
- Create: `apps/daemon/src/settings/store.ts`
- Test: `apps/daemon/src/settings/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { getSupervisionMode, setSupervisionMode } from "./store.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  applyMigrations(d); // match the real exported migration entrypoint name
  return d;
}

describe("settings store", () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
  });

  it("defaults to supervised when unset", () => {
    expect(getSupervisionMode(d)).toBe("supervised");
  });

  it("persists and reads back unsupervised", () => {
    setSupervisionMode(d, "unsupervised", "2026-06-11T00:00:00.000Z");
    expect(getSupervisionMode(d)).toBe("unsupervised");
  });

  it("upserts on repeated writes", () => {
    setSupervisionMode(d, "unsupervised", "2026-06-11T00:00:00.000Z");
    setSupervisionMode(d, "supervised", "2026-06-11T00:01:00.000Z");
    expect(getSupervisionMode(d)).toBe("supervised");
  });
});
```

> Confirm the migration entrypoint: open `apps/daemon/src/migrations.ts` and use the actual exported function name (e.g. `applyMigrations` / `runMigrations`). Match it in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/settings/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `apps/daemon/src/settings/store.ts`:

```ts
import type Database from "better-sqlite3";
import { SupervisionMode } from "@orca/contracts";

const SUPERVISION_KEY = "supervision_mode";

export function getSupervisionMode(db: Database.Database): SupervisionMode {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(SUPERVISION_KEY) as { value: string } | undefined;
  if (row === undefined) return "supervised";
  const parsed = SupervisionMode.safeParse(row.value);
  return parsed.success ? parsed.data : "supervised";
}

export function setSupervisionMode(
  db: Database.Database,
  mode: SupervisionMode,
  now: string
): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SUPERVISION_KEY, mode, now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/settings/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/settings/store.ts apps/daemon/src/settings/store.test.ts
git commit -m "feat(daemon): supervision-mode settings store"
```

---

### Task 8: `GET` / `PUT` `/v1/settings` routes

**Files:**
- Modify: `apps/daemon/src/server.ts` (register near the worker-permission-mode route, ~line 1465)
- Test: `apps/daemon/src/server.test.ts` (add cases following existing route-test patterns)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/server.test.ts` (mirror how other routes are exercised — build the server with a migrated DB, `inject` requests):

```ts
it("GET /v1/settings defaults to supervised", async () => {
  const { server } = buildTestServer(); // existing helper in server.test.ts
  const res = await server.inject({ method: "GET", url: "/v1/settings" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ supervisionMode: "supervised" });
});

it("PUT /v1/settings persists the mode", async () => {
  const { server } = buildTestServer();
  const put = await server.inject({
    method: "PUT",
    url: "/v1/settings",
    payload: { supervisionMode: "unsupervised" }
  });
  expect(put.statusCode).toBe(200);
  const get = await server.inject({ method: "GET", url: "/v1/settings" });
  expect(get.json()).toEqual({ supervisionMode: "unsupervised" });
});

it("PUT /v1/settings rejects an invalid mode", async () => {
  const { server } = buildTestServer();
  const res = await server.inject({
    method: "PUT",
    url: "/v1/settings",
    payload: { supervisionMode: "auto" }
  });
  expect(res.statusCode).toBe(400);
});
```

> Match `buildTestServer` to the actual helper used in `server.test.ts`. Inspect the top of that file for the exact setup (auth header may be required on inject).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/server.test.ts -t "/v1/settings"`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Register the routes**

In `apps/daemon/src/server.ts`, import the store at the top with the other imports:

```ts
import { getSupervisionMode, setSupervisionMode } from "./settings/store.js";
import { PutSettingsRequest } from "@orca/contracts";
```

Add the routes alongside the worker-permission-mode route (~line 1465), using the same `db` in scope:

```ts
server.get("/v1/settings", async () => {
  return { supervisionMode: getSupervisionMode(db) };
});

server.put("/v1/settings", async (request, reply) => {
  const parsed = PutSettingsRequest.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_settings", issues: parsed.error.issues });
  }
  const now = new Date().toISOString();
  setSupervisionMode(db, parsed.data.supervisionMode, now);
  // Task 14 adds the switch-to-unsupervised auto-continue hook here.
  return { supervisionMode: parsed.data.supervisionMode };
});
```

> If `server.ts` derives `now` from an injected clock, reuse that instead of `new Date()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/server.test.ts -t "/v1/settings"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts
git commit -m "feat(daemon): GET/PUT /v1/settings supervision routes"
```

---

## Phase 4 — Activity store: confirmation pause/resume

### Task 9: `pauseForConfirmation` + `resumeFromConfirmation`

**Files:**
- Modify: `apps/daemon/src/activities/store.ts` (add two functions after `pauseForInput`, ~line 260)
- Test: `apps/daemon/src/activities/store.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/activities/store.test.ts` (reuse the file's existing setup that seeds a live activity for a step run):

```ts
it("pauses a live activity for confirmation", () => {
  const ctx = seedCtx();
  openOrUpdateLive(ctx, liveInput()); // existing helpers/inputs in this test file
  const paused = pauseForConfirmation(ctx, {
    stepRunId: liveInput().stepRunId,
    summary: "Completeness 90% · Correctness 85% · Ready for handoff"
  });
  expect(paused?.status).toBe("paused_for_input");
  expect(paused?.sourceKind).toBe("step_confirmation_pending");
  expect(paused?.currentText).toContain("90%");
});

it("resumes a confirmation activity back to active", () => {
  const ctx = seedCtx();
  openOrUpdateLive(ctx, liveInput());
  pauseForConfirmation(ctx, { stepRunId: liveInput().stepRunId, summary: "x" });
  const resumed = resumeFromConfirmation(ctx, { stepRunId: liveInput().stepRunId });
  expect(resumed?.status).toBe("active");
  expect(resumed?.sourceKind).toBe("step_started");
});
```

> Match `seedCtx` / `liveInput` to whatever the existing `store.test.ts` uses. If it constructs the ctx inline, copy that style.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/activities/store.test.ts -t "confirmation"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the functions**

Add to `apps/daemon/src/activities/store.ts` after `pauseForInput` (model on it — note `getLiveForStepRun` matches both `active` and `paused_for_input`):

```ts
export function pauseForConfirmation(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; summary: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined) return undefined;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'paused_for_input', current_text = ?,
             source_kind = 'step_confirmation_pending', work_category = NULL,
             pending_question = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(input.summary, now, live.id);

    const paused = getActivityById(ctx.db, live.id);
    if (paused === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, paused, now);
    return paused;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}

export function resumeFromConfirmation(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string }
): ActivityT | undefined {
  let event: DomainEvent | undefined;
  const activity = ctx.db.transaction(() => {
    const live = getLiveForStepRun(ctx.db, input.stepRunId);
    if (live === undefined || live.status !== "paused_for_input") return undefined;
    if (live.sourceKind !== "step_confirmation_pending") return live;

    const now = currentTime(ctx);
    ctx.db
      .prepare(
        `UPDATE activities
         SET status = 'active', source_kind = 'step_started', updated_at = ?
         WHERE id = ?`
      )
      .run(now, live.id);

    const resumed = getActivityById(ctx.db, live.id);
    if (resumed === undefined) throw new Error(`Activity disappeared: ${live.id}`);
    event = insertActivityChangedEvent(ctx.db, resumed, now);
    return resumed;
  })();

  publishActivityChanged(ctx, event);
  return activity;
}
```

> `live.sourceKind` vs the DB column name: `getActivityById` returns the projected `ActivityT` (camelCase `sourceKind`). Confirm against the row mapper in this file and adjust the property access if it returns the raw row.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/activities/store.test.ts -t "confirmation"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/store.ts apps/daemon/src/activities/store.test.ts
git commit -m "feat(daemon): activity pause/resume for step confirmation"
```

---

## Phase 5 — Orchestrator gate (the core change)

### Task 10: Hold at the checkpoint in supervised mode

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`approve_step_complete`, ~line 751; constructor wiring ~line 302)
- Test: `apps/daemon/src/workflows/orchestrator/service.supervision.test.ts` (create; mirror an existing service test's harness)

**Design notes for the implementer:**
- The orchestrator service does **not** currently import the activity store. Add `import { pauseForConfirmation, resumeFromConfirmation } from "../../activities/store.js";` and call with `{ db, bus: options.bus }`.
- Read the mode with `getSupervisionMode(db)` (import from `../../settings/store.js`).
- The stash payload is `{ block, scoring, finishedAt }` serialized to `pending_completion_json` on the step run row.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/service.supervision.test.ts`. Use the same construction the other `service.*.test.ts` files use (they instantiate the service with mocked `workerTerminate`, `workerDeliver`, etc.). Skeleton:

```ts
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
// import the service + the existing test harness builders used by sibling tests
// (e.g. makeServiceUnderTest, seedRunAtApproval). Reuse them; do not reinvent.

describe("supervised step completion", () => {
  it("holds instead of terminating/advancing when supervised", async () => {
    const { service, db, ctx, terminate, advanceSpy, bus } = seedRunAtApproval();
    setSupervisionMode(db, "supervised", "2026-06-11T00:00:00.000Z");

    await service /* drive the approve_step_complete action for ctx */;

    // worker NOT terminated, run NOT advanced
    expect(terminate).not.toHaveBeenCalled();
    // stash present
    const row = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(ctx.stepRun.id) as { pending_completion_json: string | null };
    expect(row.pending_completion_json).not.toBeNull();
    // activity paused for confirmation
    const act = db
      .prepare("SELECT status, source_kind FROM activities WHERE step_run_id = ?")
      .get(ctx.stepRun.id) as { status: string; source_kind: string };
    expect(act.status).toBe("paused_for_input");
    expect(act.source_kind).toBe("step_confirmation_pending");
  });

  it("terminates and advances immediately when unsupervised", async () => {
    const { service, db, ctx, terminate } = seedRunAtApproval();
    setSupervisionMode(db, "unsupervised", "2026-06-11T00:00:00.000Z");
    await service /* drive approve_step_complete */;
    expect(terminate).toHaveBeenCalledWith(ctx.sessionId);
    const row = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(ctx.stepRun.id) as { pending_completion_json: string | null };
    expect(row.pending_completion_json).toBeNull();
  });
});
```

> **Before writing this test, read one sibling test** (e.g. a `service.*.test.ts` that exercises `approve_step_complete`) to copy its exact harness — how it builds `ctx`, drives the action, and spies on terminate/advance. Replace the `seedRunAtApproval()`/`/* drive ... */` placeholders with that real harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts`
Expected: FAIL — supervised branch not implemented (currently always terminates/advances).

- [ ] **Step 3: Implement the gate branch**

In `service.ts`, replace the body of `case "approve_step_complete":` (lines ~751-781) so the tail is conditional:

```ts
case "approve_step_complete": {
  const block = extractOrcaStepCompleteBlock(responseText);
  const finishedAt = now();

  if (getSupervisionMode(db) === "supervised") {
    // Hold at the checkpoint: stash the completion, pause the activity,
    // leave the worker alive, do not advance.
    db.prepare(
      "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
    ).run(
      JSON.stringify({ block: block ?? {}, scoring: action.scoring ?? null, finishedAt }),
      ctx.stepRun.id
    );
    pauseForConfirmation(
      { db, bus: options.bus },
      { stepRunId: ctx.stepRun.id, summary: summarizeScoring(action.scoring) }
    );
    return { postedChatReply: false };
  }

  // Unsupervised: existing behavior (unchanged).
  const stagedEvents: DomainEvent[] = [];
  this.createStepOutputArtifact(db, now, ctx, JSON.stringify(block ?? {}), options, stagedEvents);
  this.publish(options.bus, stagedEvents);
  if (sessionId) {
    void this.workerTerminate?.(sessionId);
  }
  const stepResult = this.buildApprovalStepResult(db, ctx, action.scoring, finishedAt);
  await this.advanceToNextStep(db, nowWithFirstTimestamp(now, finishedAt), ctx.run.id, {
    ...options,
    stepResultByStepRunId: { ...options.stepResultByStepRunId, [ctx.stepRun.id]: stepResult },
    terminalFinishedAtByStepRunId: { ...options.terminalFinishedAtByStepRunId, [ctx.stepRun.id]: finishedAt }
  });
  return { postedChatReply: false };
}
```

Add a small helper near the top of `service.ts` (module scope):

```ts
function summarizeScoring(scoring: StepResultScoringProposal | undefined): string {
  if (!scoring) return "Step complete — evaluation unavailable. Continue or send revisions.";
  const q = scoring.quality;
  return (
    `Completeness ${Math.round(q.outputCompleteness * 100)}% · ` +
    `Correctness ${Math.round(q.outputCorrectness * 100)}% · ` +
    (scoring.handoffReady ? "Ready for handoff" : "Not ready") +
    " — Continue or send revisions."
  );
}
```

Add imports at the top of `service.ts`:

```ts
import { getSupervisionMode } from "../../settings/store.js";
import { pauseForConfirmation, resumeFromConfirmation } from "../../activities/store.js";
```

> `action.scoring` is the validated `StepResultScoringProposal | undefined` already used at the old line 768. `StepResultScoringProposal` is already imported at `service.ts:6`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full orchestrator suite (no regressions)**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator`
Expected: PASS (unsupervised path is byte-for-byte the old behavior).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.supervision.test.ts
git commit -m "feat(daemon): hold supervised step completion at a checkpoint"
```

---

### Task 11: `confirm-step` route + service Continue method

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (add `confirmStep` method)
- Modify: `apps/daemon/src/server.ts` (register `POST /v1/workflows/runs/:id/confirm-step`)
- Test: `apps/daemon/src/workflows/orchestrator/service.supervision.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `service.supervision.test.ts`:

```ts
it("confirmStep runs the terminal tail exactly once", async () => {
  const { service, db, ctx, terminate } = seedRunAtApproval();
  setSupervisionMode(db, "supervised", "2026-06-11T00:00:00.000Z");
  await service /* drive approve_step_complete -> now paused */;

  await service.confirmStep(db, () => "2026-06-11T00:05:00.000Z", ctx.run.id, baseOptions);

  expect(terminate).toHaveBeenCalledWith(ctx.sessionId);
  const stash = db
    .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
    .get(ctx.stepRun.id) as { pending_completion_json: string | null };
  expect(stash.pending_completion_json).toBeNull();
  // a terminal step_result was persisted by the advance tail
  const sr = db
    .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?")
    .get(ctx.stepRun.id) as { step_result_json: string | null };
  expect(sr.step_result_json).not.toBeNull();
});

it("confirmStep is a no-op when no stash is present", async () => {
  const { service, db, ctx, terminate } = seedRunAtApproval();
  await service.confirmStep(db, () => "t", ctx.run.id, baseOptions);
  expect(terminate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts -t "confirmStep"`
Expected: FAIL — `confirmStep` not defined.

- [ ] **Step 3: Implement `confirmStep`**

Add a method to the service class (near `advanceToNextStep`, ~line 1068). It rebuilds `ctx` from the run's current step and replays the unsupervised tail using the stashed payload:

```ts
async confirmStep(
  db: Database.Database,
  now: () => string,
  runId: string,
  options: RequestNextDecisionOptions
): Promise<void> {
  const run = getWorkflowRunById(db, runId);
  if (!run || !run.currentStepRunId) return;
  const stepRun = getWorkflowStepRunById(db, run.currentStepRunId);
  if (!stepRun) return;

  const stashRow = db
    .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
    .get(stepRun.id) as { pending_completion_json: string | null } | undefined;
  if (!stashRow?.pending_completion_json) return; // idempotent no-op

  const stash = JSON.parse(stashRow.pending_completion_json) as {
    block: unknown;
    scoring: StepResultScoringProposal | null;
    finishedAt: string;
  };

  const template = getTemplateById(db, run.templateId);
  const goal = readGoal(db, run.goalId);
  const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
  if (!template || !goal || !stepTpl) return;
  const ctx = { run, stepRun, stepTpl, template, goal };

  // Clear the stash first so a racing refine/confirm cannot double-apply.
  db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(
    stepRun.id
  );

  const stagedEvents: DomainEvent[] = [];
  this.createStepOutputArtifact(
    db,
    now,
    ctx,
    JSON.stringify(stash.block ?? {}),
    options,
    stagedEvents
  );
  this.publish(options.bus, stagedEvents);

  const sessionId = this.sessionIdForStepRun(db, stepRun.id); // see note
  if (sessionId) void this.workerTerminate?.(sessionId);

  const stepResult = this.buildApprovalStepResult(db, ctx, stash.scoring ?? undefined, stash.finishedAt);
  await this.advanceToNextStep(db, nowWithFirstTimestamp(now, stash.finishedAt), run.id, {
    ...options,
    stepResultByStepRunId: { ...options.stepResultByStepRunId, [stepRun.id]: stepResult },
    terminalFinishedAtByStepRunId: { ...options.terminalFinishedAtByStepRunId, [stepRun.id]: stash.finishedAt }
  });
}
```

> **Two helper lookups to verify against the codebase before finalizing:**
> 1. `readGoal`, `getWorkflowRunById`, `getWorkflowStepRunById`, `getTemplateById` are already imported in `service.ts` (lines 31-35, 251). `stepRun.step_template_id` is the raw row column — confirm the column name in the `StepRunRow` type.
> 2. `sessionIdForStepRun`: the live session id for a step run is looked up elsewhere (the route at `steps/routes.ts:228` queries `sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting')`). If the service has no such helper, query inline with the same SQL. Worker termination is best-effort, so a missing session is fine.

- [ ] **Step 4: Register the route**

In `server.ts`, near the other workflow routes, add (resolving the orchestrator service instance the server already holds — find how `requestNextDecision`/the orchestrator service is referenced in `server.ts` and reuse it):

```ts
server.post<{ Params: { id: string } }>("/v1/workflows/runs/:id/confirm-step", async (request, reply) => {
  const runId = request.params.id;
  await orchestratorService.confirmStep(db, () => new Date().toISOString(), runId, baseDecisionOptions);
  return reply.code(202).send({ ok: true });
});
```

> `orchestratorService` and `baseDecisionOptions` are placeholders for whatever the server already has in scope (the object on which `requestNextDecision` is called, and the standard options/bus it passes). Inspect `server.ts` for the existing orchestrator wiring and reuse it verbatim.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts -t "confirmStep"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.supervision.test.ts
git commit -m "feat(daemon): confirm-step route + Continue terminal tail"
```

---

## Phase 6 — Refine path + revision signals

### Task 12: Revision-signal store

**Files:**
- Create: `apps/daemon/src/workflows/revision-signals/store.ts`
- Test: `apps/daemon/src/workflows/revision-signals/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../migrations.js";
import { recordRevisionSignal, listRevisionSignals } from "./store.js";

const scoring = {
  successScore: 0.9,
  quality: {
    outputCompleteness: 0.9,
    outputCorrectness: 0.85,
    instructionAdherence: 0.95,
    downstreamReadiness: 0.8,
    riskLevel: 0.1
  },
  reason: "ok",
  handoffReady: true
};

describe("revision signal store", () => {
  it("records and lists signals with incrementing index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    recordRevisionSignal(db, { id: "1", stepRunId: "s1", goalId: "g1", supersededScoring: scoring, feedbackText: "more tests", now: "t0" });
    recordRevisionSignal(db, { id: "2", stepRunId: "s1", goalId: "g1", supersededScoring: scoring, feedbackText: null, now: "t1" });
    const rows = listRevisionSignals(db, "s1");
    expect(rows.map((r) => r.revisionIndex)).toEqual([0, 1]);
    expect(rows[0].feedbackText).toBe("more tests");
    expect(rows[1].supersededScoring.successScore).toBe(0.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/workflows/revision-signals/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `apps/daemon/src/workflows/revision-signals/store.ts`:

```ts
import type Database from "better-sqlite3";
import { StepRevisionSignal, StepResultScoringProposal } from "@orca/contracts";

export function recordRevisionSignal(
  db: Database.Database,
  input: {
    id: string;
    stepRunId: string;
    goalId: string;
    supersededScoring: StepResultScoringProposal;
    feedbackText: string | null;
    now: string;
  }
): void {
  const priorCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM step_revision_signals WHERE step_run_id = ?")
      .get(input.stepRunId) as { c: number }
  ).c;
  db.prepare(
    `INSERT INTO step_revision_signals
       (id, step_run_id, goal_id, revision_index, superseded_scoring_json, feedback_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.stepRunId,
    input.goalId,
    priorCount,
    JSON.stringify(input.supersededScoring),
    input.feedbackText,
    input.now
  );
}

export function listRevisionSignals(
  db: Database.Database,
  stepRunId: string
): StepRevisionSignal[] {
  const rows = db
    .prepare(
      "SELECT * FROM step_revision_signals WHERE step_run_id = ? ORDER BY revision_index ASC"
    )
    .all(stepRunId) as {
    id: string;
    step_run_id: string;
    goal_id: string;
    revision_index: number;
    superseded_scoring_json: string;
    feedback_text: string | null;
    created_at: string;
  }[];
  return rows.map((r) =>
    StepRevisionSignal.parse({
      id: r.id,
      stepRunId: r.step_run_id,
      goalId: r.goal_id,
      revisionIndex: r.revision_index,
      supersededScoring: JSON.parse(r.superseded_scoring_json),
      feedbackText: r.feedback_text,
      createdAt: r.created_at
    })
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/workflows/revision-signals/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/revision-signals/store.ts apps/daemon/src/workflows/revision-signals/store.test.ts
git commit -m "feat(daemon): step revision-signal store"
```

---

### Task 13: Refine clears stash, records signal, resumes activity

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`forward_to_agent` case, ~line 724)
- Test: `apps/daemon/src/workflows/orchestrator/service.supervision.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("refining a paused step records a signal, clears the stash, resumes the activity", async () => {
  const { service, db, ctx, deliver } = seedRunAtApproval();
  setSupervisionMode(db, "supervised", "t0");
  await service /* drive approve_step_complete -> paused */;

  // user feedback arrives -> orchestrator decides forward_to_agent
  await service /* drive forward_to_agent with translated="add error handling" for ctx */;

  expect(deliver).toHaveBeenCalledWith(ctx.sessionId, "add error handling");
  const stash = db
    .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
    .get(ctx.stepRun.id) as { pending_completion_json: string | null };
  expect(stash.pending_completion_json).toBeNull();
  const sig = db
    .prepare("SELECT COUNT(*) AS c FROM step_revision_signals WHERE step_run_id = ?")
    .get(ctx.stepRun.id) as { c: number };
  expect(sig.c).toBe(1);
  const act = db
    .prepare("SELECT status FROM activities WHERE step_run_id = ?")
    .get(ctx.stepRun.id) as { status: string };
  expect(act.status).toBe("active");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts -t "refining"`
Expected: FAIL — no signal recorded; stash still present.

- [ ] **Step 3: Implement the refine hook**

In `service.ts`, at the start of the `forward_to_agent` case (~line 724), before delivering, add a stash-clearing branch. Insert immediately inside `case "forward_to_agent": {`:

```ts
// If this step is paused at a confirmation checkpoint, the user is refining:
// record the divergence signal, clear the stash, and resume the activity.
const stashRow = db
  .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
  .get(ctx.stepRun.id) as { pending_completion_json: string | null } | undefined;
if (stashRow?.pending_completion_json) {
  try {
    const stash = JSON.parse(stashRow.pending_completion_json) as {
      scoring: StepResultScoringProposal | null;
    };
    if (stash.scoring) {
      recordRevisionSignal(db, {
        id: randomUUID(),
        stepRunId: ctx.stepRun.id,
        goalId: ctx.run.goalId,
        supersededScoring: stash.scoring,
        feedbackText: action.translated,
        now: now()
      });
    }
  } catch {
    // signal capture must never block refinement
  }
  db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(
    ctx.stepRun.id
  );
  resumeFromConfirmation({ db, bus: options.bus }, { stepRunId: ctx.stepRun.id });
}
```

Add imports at the top of `service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { recordRevisionSignal } from "../revision-signals/store.js";
```

> `action.translated` is the relayed text used at the existing `forward_to_agent` delivery (line 726). `resumeFromConfirmation` was added in Task 9.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/workflows/orchestrator/service.supervision.test.ts -t "refining"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.supervision.test.ts
git commit -m "feat(daemon): capture revision signal + resume on refine"
```

---

## Phase 7 — Mode switch + restart recovery

### Task 14: Switch to unsupervised auto-continues paused steps

**Files:**
- Modify: `apps/daemon/src/server.ts` (`PUT /v1/settings` handler from Task 8)
- Test: `apps/daemon/src/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("switching to unsupervised continues a paused step", async () => {
  const { server, db } = buildTestServer();
  // seed a run paused at a confirmation checkpoint (reuse a daemon test helper
  // that drives a step to the paused state, or insert the stash + paused activity directly)
  const stepRunId = seedPausedStep(db);

  await server.inject({ method: "PUT", url: "/v1/settings", payload: { supervisionMode: "unsupervised" } });

  const stash = db
    .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { pending_completion_json: string | null };
  expect(stash.pending_completion_json).toBeNull();
});
```

> Provide `seedPausedStep` by inserting a workflow run + step run with `pending_completion_json` set and a `paused_for_input` / `step_confirmation_pending` activity, OR reuse the orchestrator harness to reach that state. Keep it minimal.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/server.test.ts -t "switching to unsupervised"`
Expected: FAIL — stash remains.

- [ ] **Step 3: Implement auto-continue**

In the `PUT /v1/settings` handler (Task 8), after persisting, when the new mode is `unsupervised`, find runs with a paused stash and confirm them:

```ts
if (parsed.data.supervisionMode === "unsupervised") {
  const paused = db
    .prepare(
      `SELECT wr.id AS run_id
       FROM workflow_runs wr
       JOIN workflow_step_runs sr ON sr.id = wr.current_step_run_id
       WHERE sr.pending_completion_json IS NOT NULL`
    )
    .all() as { run_id: string }[];
  for (const p of paused) {
    await orchestratorService.confirmStep(db, () => new Date().toISOString(), p.run_id, baseDecisionOptions);
  }
}
```

> Reuse the same `orchestratorService` / `baseDecisionOptions` references resolved in Task 11. Confirm the `workflow_runs.current_step_run_id` column name against `0010_workflows.sql`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/server.test.ts -t "switching to unsupervised"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts
git commit -m "feat(daemon): auto-continue paused steps when switching to unsupervised"
```

---

### Task 15: Re-assert the checkpoint on daemon restart

**Files:**
- Modify: the daemon startup reconciliation path. Find it via the prior spec's "startup reconciliation" for `step_result` activities — grep `reconcile` under `apps/daemon/src/workflows`.
- Test: `apps/daemon/src/workflows/reconcile.test.ts` (existing file — extend)

- [ ] **Step 1: Locate the reconciliation entrypoint**

Run: `grep -rn "reconcile" apps/daemon/src/workflows | grep -vi test`
Note the function that runs at startup (it already materializes missing `step_result` activities per the prior spec).

- [ ] **Step 2: Write the failing test**

In `apps/daemon/src/workflows/reconcile.test.ts`, add:

```ts
it("re-asserts a confirmation pause for a non-terminal step with a stash", () => {
  const db = freshMigratedDb();
  // seed: a non-terminal step run with pending_completion_json set, a live worker
  // session present, but NO paused activity (simulating a crash after stashing,
  // before/with the activity lost).
  const stepRunId = seedNonTerminalStashedStep(db); // local helper inserting the rows

  reconcileWorkflows(db, bus); // the real reconciliation entrypoint from Step 1

  const act = db
    .prepare("SELECT status, source_kind FROM activities WHERE step_run_id = ?")
    .get(stepRunId) as { status: string; source_kind: string } | undefined;
  expect(act?.status).toBe("paused_for_input");
  expect(act?.source_kind).toBe("step_confirmation_pending");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test src/workflows/reconcile.test.ts -t "re-asserts a confirmation"`
Expected: FAIL — no paused activity re-created.

- [ ] **Step 4: Implement reconciliation**

In the reconciliation function, after the existing `step_result` reconciliation, add a scan for stashed non-terminal steps and re-assert their checkpoint:

```ts
const stashed = db
  .prepare(
    `SELECT sr.id AS step_run_id, sr.pending_completion_json AS stash
     FROM workflow_step_runs sr
     WHERE sr.pending_completion_json IS NOT NULL AND sr.finished_at IS NULL`
  )
  .all() as { step_run_id: string; stash: string }[];

for (const s of stashed) {
  let summary = "Step complete — review and Continue or send revisions.";
  try {
    const parsed = JSON.parse(s.stash) as { scoring: StepResultScoringProposal | null };
    summary = summarizeScoring(parsed.scoring ?? undefined);
  } catch {
    /* keep default summary */
  }
  // openOrUpdateLive returns the existing paused activity untouched; otherwise
  // create one and pause it for confirmation.
  openOrUpdateLive(
    { db, bus },
    {
      goalId: /* from the run */ "",
      workflowRunId: /* from the run */ "",
      stepRunId: s.step_run_id,
      agentSessionId: null,
      sourceKind: "step_started",
      currentText: summary,
      workCategory: null
    }
  );
  pauseForConfirmation({ db, bus }, { stepRunId: s.step_run_id, summary });
}
```

> Fetch `goalId`/`workflowRunId` for each stashed step from its run row (join `workflow_step_runs` → `workflow_runs`). Export `summarizeScoring` from `service.ts` (or move it to a small shared module `orchestrator/scoring-summary.ts`) so reconciliation and the gate share one implementation — do not duplicate it. If the worker session is gone, the existing worker-exit recovery (`onWorkflowSessionCompleted`) already handles eventual completion; this task only restores the visible checkpoint.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test src/workflows/reconcile.test.ts -t "re-asserts a confirmation"`
Expected: PASS.

- [ ] **Step 6: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows apps/daemon/src/workflows/orchestrator/scoring-summary.ts
git commit -m "feat(daemon): re-assert confirmation checkpoint on restart"
```

---

## Phase 8 — Desktop

### Task 16: API client — settings + confirm-step

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/api.test.ts` (follow the file's existing fetch-mock pattern):

```ts
it("getSettings returns the supervision mode", async () => {
  mockFetchJson({ supervisionMode: "supervised" }); // existing helper style
  const s = await getSettings();
  expect(s.supervisionMode).toBe("supervised");
});

it("putSettings sends the mode", async () => {
  const spy = mockFetchJson({ supervisionMode: "unsupervised" });
  await putSettings({ supervisionMode: "unsupervised" });
  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining("/v1/settings"),
    expect.objectContaining({ method: "PUT" })
  );
});

it("confirmStep posts to confirm-step", async () => {
  const spy = mockFetchJson({ ok: true });
  await confirmStep("run-1");
  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining("/v1/workflows/runs/run-1/confirm-step"),
    expect.objectContaining({ method: "POST" })
  );
});
```

> Match `mockFetchJson` to whatever `api.test.ts` already uses for stubbing `fetch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test src/api.test.ts -t "Settings"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the client functions**

In `apps/desktop/src/api.ts`, follow the existing `loadConfig()` + `requestJson`/`requestVoid` helpers (lines ~191, 281, 299). Add:

```ts
import type { AppSettings, PutSettingsRequest } from "@orca/contracts";

export async function getSettings(): Promise<AppSettings> {
  const { baseUrl, token } = await loadConfig();
  return requestJson<AppSettings>(`${baseUrl}/v1/settings`, {
    method: "GET",
    headers: authHeaders(token)
  });
}

export async function putSettings(body: PutSettingsRequest): Promise<AppSettings> {
  const { baseUrl, token } = await loadConfig();
  return requestJson<AppSettings>(`${baseUrl}/v1/settings`, {
    method: "PUT",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function confirmStep(runId: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(`${baseUrl}/v1/workflows/runs/${runId}/confirm-step`, {
    method: "POST",
    headers: authHeaders(token)
  });
}
```

> Confirm the exact signatures of `requestJson` / `requestVoid` / `authHeaders` in `api.ts` and match them (argument order may differ). Re-export the contract types via the existing `export type { ... }` block (line ~123) if other modules import them from `api.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test src/api.test.ts -t "Settings"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): api client for settings + confirm-step"
```

---

### Task 17: Settings modal — Supervised/Unsupervised selector

**Files:**
- Modify: `apps/desktop/src/settings/SettingsModal.tsx` (`OrchestrationTab`, lines 143-180; remove `AUTONOMY_LEVELS`)
- Test: `apps/desktop/src/settings/SettingsModal.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as api from "../api";
import { SettingsModal } from "./SettingsModal";

describe("SettingsModal supervision", () => {
  beforeEach(() => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ supervisionMode: "supervised" });
    vi.spyOn(api, "putSettings").mockResolvedValue({ supervisionMode: "unsupervised" });
  });

  it("shows the current mode and persists a change", async () => {
    render(<SettingsModal onClose={() => {}} agents={[]} onToggleAgent={() => {}} />);
    // navigate to Orchestration tab
    fireEvent.click(screen.getByText("Orchestration"));
    await waitFor(() => screen.getByTestId("supervision-supervised"));
    fireEvent.click(screen.getByTestId("supervision-unsupervised"));
    await waitFor(() =>
      expect(api.putSettings).toHaveBeenCalledWith({ supervisionMode: "unsupervised" })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test src/settings/SettingsModal.test.tsx`
Expected: FAIL — selector/testids absent.

- [ ] **Step 3: Replace the static autonomy list**

In `SettingsModal.tsx`, delete the `AUTONOMY_LEVELS` constant (143-149) and rewrite `OrchestrationTab` (151-180):

```tsx
import { useEffect, useState } from "react";
import { getSettings, putSettings } from "../api";
import type { SupervisionMode } from "@orca/contracts";

const SUPERVISION_OPTIONS: { mode: SupervisionMode; name: string; desc: string }[] = [
  {
    mode: "supervised",
    name: "Supervised",
    desc: "Pause after each step so you can review the result and refine it before continuing."
  },
  {
    mode: "unsupervised",
    name: "Unsupervised",
    desc: "Run steps to completion automatically without pausing."
  }
];

function OrchestrationTab() {
  const [mode, setMode] = useState<SupervisionMode | null>(null);

  useEffect(() => {
    let active = true;
    void getSettings().then((s) => {
      if (active) setMode(s.supervisionMode);
    });
    return () => {
      active = false;
    };
  }, []);

  async function choose(next: SupervisionMode) {
    if (next === mode) return;
    setMode(next);
    try {
      await putSettings({ supervisionMode: next });
    } catch {
      // revert on failure
      const s = await getSettings();
      setMode(s.supervisionMode);
    }
  }

  return (
    <section>
      <div className="settings-section-label">Supervision</div>
      <div className="settings-level-list">
        {SUPERVISION_OPTIONS.map((o) => {
          const active = mode === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              data-testid={`supervision-${o.mode}`}
              className={"settings-level" + (active ? " settings-level--active" : "")}
              onClick={() => choose(o.mode)}
            >
              <div className="settings-level-body">
                <div className="settings-level-name">{o.name}</div>
                <div className="settings-level-desc">{o.desc}</div>
              </div>
              {active && <CheckIcon size={14} color="var(--accent)" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

> Keep the existing `CheckIcon` import. Reuse the existing `settings-level*` CSS classes (already styled). If `CheckIcon` was only used by the deleted list, it is still used here, so leave the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test src/settings/SettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/settings/SettingsModal.tsx apps/desktop/src/settings/SettingsModal.test.tsx
git commit -m "feat(desktop): supervised/unsupervised settings selector"
```

---

### Task 18: Checkpoint card in the Activity Thread

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (the `ActivityCard` switch, ~line 80)
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (reuse `.thinking-bubble` styling)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx` (add a case)

- [ ] **Step 1: Write the failing test**

```tsx
it("renders a confirmation checkpoint card with a Continue button", () => {
  const onContinue = vi.fn();
  render(
    <ActivityCard
      activity={{
        id: "a1",
        goalId: "g1",
        workflowRunId: "r1",
        stepRunId: "s1",
        agentSessionId: "sess1",
        turnOrdinal: 1,
        status: "paused_for_input",
        currentText: "Completeness 90% · Ready for handoff — Continue or send revisions.",
        finalSummary: null,
        sourceKind: "step_confirmation_pending",
        workCategory: null,
        confidence: null,
        createdAt: "t",
        updatedAt: "t",
        completedAt: null
      }}
      onContinue={onContinue}
    />
  );
  expect(screen.getByText(/Completeness 90%/)).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("step-confirm-continue"));
  expect(onContinue).toHaveBeenCalledWith("r1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test src/orchestrator/ActivityThread.test.tsx -t "checkpoint"`
Expected: FAIL — no confirmation branch.

- [ ] **Step 3: Implement the card**

In `ActivityThread.tsx`, add a `StepConfirmationCard` and branch in `ActivityCard`. Extend `ActivityCard`'s props with an optional `onContinue`:

```tsx
export function StepConfirmationCard({
  activity,
  onContinue
}: {
  activity: Activity;
  onContinue?: (runId: string) => void;
}) {
  return (
    <div className="thinking-bubble step-confirm-card" data-testid="step-confirm-card">
      <div className="step-confirm-summary">{activity.currentText}</div>
      <div className="step-confirm-actions">
        <button
          type="button"
          data-testid="step-confirm-continue"
          className="step-confirm-continue-btn"
          onClick={() => onContinue?.(activity.workflowRunId)}
        >
          Continue
        </button>
        <span className="step-confirm-hint">Type in chat to send revisions to the agent.</span>
      </div>
    </div>
  );
}
```

Update `ActivityCard`:

```tsx
export function ActivityCard({
  activity,
  onContinue
}: {
  activity: Activity;
  onContinue?: (runId: string) => void;
}) {
  if (activity.sourceKind === "step_confirmation_pending") {
    return <StepConfirmationCard activity={activity} onContinue={onContinue} />;
  }
  if (activity.sourceKind === "step_result") {
    return <StepResultCard activity={activity} />;
  }
  return (
    <div className="activity-summary" data-testid="activity-summary">
      {activity.finalSummary}
    </div>
  );
}
```

Also include the confirmation activity in the render filter at the top of the file (line ~23 `isMeaningfulCompleted(...) || sourceKind === "step_result"`):

```tsx
return (
  isMeaningfulCompleted(activity) ||
  activity.sourceKind === "step_result" ||
  activity.sourceKind === "step_confirmation_pending"
);
```

Add minimal CSS to `orca-chat.css` (reuse the bubble look):

```css
.step-confirm-card .step-confirm-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.step-confirm-continue-btn {
  background: var(--accent);
  color: var(--accent-contrast, #0b0b0b);
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}
.step-confirm-hint {
  color: var(--text-3);
  font-size: 12px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test src/orchestrator/ActivityThread.test.tsx -t "checkpoint"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): step confirmation checkpoint card"
```

---

### Task 19: Wire Continue through OrcaChat

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (pass `onContinue` to the activity list)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx` (add a case)

- [ ] **Step 1: Write the failing test**

```tsx
it("clicking Continue on a checkpoint calls confirmStep and refetches", async () => {
  const confirmSpy = vi.spyOn(api, "confirmStep").mockResolvedValue();
  // render OrcaChat with an activities fixture containing a step_confirmation_pending
  // activity for run "r1" (follow the existing OrcaChat.test.tsx fixture/mocks)
  renderOrcaChatWithActivities([confirmationActivity("r1")]);

  fireEvent.click(await screen.findByTestId("step-confirm-continue"));
  await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith("r1"));
});
```

> Reuse the existing OrcaChat test harness (how it mocks `api` and seeds activities). `confirmationActivity` is a small local fixture builder.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test src/orchestrator/OrcaChat.test.tsx -t "Continue"`
Expected: FAIL — Continue not wired.

- [ ] **Step 3: Wire the handler**

In `OrcaChat.tsx`, import `confirmStep` from `../api`, define a handler that calls it then triggers the existing activities refetch, and pass it where `ActivityCard`s are rendered:

```tsx
import { confirmStep } from "../api";

const handleContinue = useCallback(
  async (runId: string) => {
    await confirmStep(runId);
    // trigger the existing silent refetch of activities / workflow state
    await refreshActivities(); // reuse the component's existing refetch fn name
  },
  [refreshActivities]
);
```

Pass it down to each `ActivityCard` / `ActivityThread` render:

```tsx
<ActivityCard activity={activity} onContinue={handleContinue} />
```

> Match `refreshActivities` to the actual refetch function in `OrcaChat.tsx` (the component already silently refetches on `activity.changed`; reuse that). If activities are rendered via an `ActivityThread` wrapper component, thread `onContinue` through its props too.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test src/orchestrator/OrcaChat.test.tsx -t "Continue"`
Expected: PASS.

- [ ] **Step 5: Full desktop suite + typecheck**

Run: `pnpm --filter @orca/desktop test && pnpm --filter @orca/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): wire Continue to confirm-step + refetch"
```

---

## Final verification

- [ ] **Build everything:** `pnpm -r build`
- [ ] **Typecheck:** `pnpm -r typecheck`
- [ ] **Full test suite:** `pnpm -r test`
- [ ] **Manual smoke (optional, via the `run` skill):** create a goal (defaults to supervised), let a step complete, confirm the checkpoint card appears with a score, click Continue, verify the next step starts; then type feedback at a checkpoint and verify the worker revises and the checkpoint reappears; flip to Unsupervised in Settings and verify steps stop pausing.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** setting storage (T4,T7), API + modal (T8,T16,T17), gate hold (T10), Continue (T11), refine loop + activity resume (T9,T13), revision signal capture (T3,T6,T12,T13), switch-to-unsupervised (T14), restart re-assert (T15), checkpoint card (T18,T19). All spec sections map to tasks.
- **`summarizeScoring` is shared** between the gate (T10) and reconciliation (T15) — T15 instructs extracting it to `orchestrator/scoring-summary.ts` so there is one implementation.
- **Harness reuse:** every daemon orchestrator test says to copy the sibling `service.*.test.ts` harness rather than invent one. Do that first; the placeholders (`seedRunAtApproval`, `/* drive ... */`) are the only spots needing real wiring from the existing tests.
- **Contracts rebuild:** after Tasks 1-3, run `pnpm --filter @orca/contracts build` before daemon/desktop tasks (the daemon imports compiled `dist`).
