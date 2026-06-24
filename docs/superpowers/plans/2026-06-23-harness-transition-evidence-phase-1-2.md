# HarnessTransition Spine + Evidence Facet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the engine-owned `HarnessTransition` record (Phase 1) and a deterministic sensor runner that grounds step completion in executed verification via an `EvidenceFacet` (Phase 2), per `docs/superpowers/specs/2026-06-23-harness-axes-design.md` §3 and §4.1.

**Architecture:** A new daemon subsystem `harness-transitions/` (usecases + projection + routes, mirroring `decisions/`) persists one append-only transition per consequential boundary, with four nullable JSON facet columns. Phase 2 adds `harness-sensors/` (detect + run real `typecheck`/`unit` commands in the workspace via the existing `runCheckCommand` substrate), attaches the result as the `evidence` facet on the `step_complete` transition, and adds a deterministic veto: a failing sensor verdict forces a revise instead of advancing — overriding the LLM judge.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3` (WAL), zod (`@orca/contracts`), Fastify, vitest. Node `child_process.execFile` for sensor execution.

## Global Constraints

- All new contracts follow the repo idiom: `export const X = z.<schema>; export type X = z.infer<typeof X>;`, object schemas use `.strict()`, timestamps are `z.string().datetime()`, ids are bounded non-empty strings.
- Daemon subsystem idiom (copy from `decisions/`): `interface XCtx { db; bus; now?: () => string; idFactory?: () => string }`; prepared-statement caching keyed on DB identity with an exported `resetPreparedStatements()`; `projection.ts` owns all table SQL + `rowToX()` via `Contract.parse(...)`; `usecases.ts` writes only the shared `events` insert; **stage events inside `db.transaction(...)()`, publish to `bus` only after commit**.
- Migrations: append the bare filename string to `migrationFiles` in `apps/daemon/src/migrations.ts`; create `apps/daemon/migrations/NNNN_<name>.sql` with a leading `-- NNNN_<name>.sql` comment + a short rationale comment; `TEXT`/`INTEGER` columns; JSON columns are `TEXT`; `created_at TEXT NOT NULL`; indexes named `idx_<table>_<purpose>`. Next free number is **0040**.
- New `DomainEventType` strings are added to the `z.enum([...])` in `packages/contracts/src/index.ts`. The validation events (`workflow.validation.run/passed/failed/skipped`) **already exist** — Phase 2 only emits them; do not re-add.
- Rebuild contracts before the daemon when contract types change: `pnpm --filter @orca/contracts build`.
- Test command per package: `pnpm --filter @orca/contracts test` / `pnpm --filter @orca/daemon test`. Tests use real on-disk SQLite (`openDatabase(createConfig(mkdtempSync(...)))` + `runMigrations(db, defaultMigrationsDir())`), a `SpyBus extends EventBus`, and reset every subsystem's prepared statements in `afterEach`.
- Do not touch unrelated dead code; the two-fence orca-output quirk and other audit findings are out of scope for this plan.

---

## File Structure

**Phase 1 — spine**
- Create `packages/contracts/src/harness/index.ts` — `HarnessTransitionBoundary`, facet placeholders, `HarnessTransition` contract.
- Modify `packages/contracts/src/index.ts` — add `export * from "./harness/index.js";` and the `harness.transition.recorded` event string.
- Create `apps/daemon/migrations/0040_harness_transitions.sql` — the table.
- Modify `apps/daemon/src/migrations.ts` — register `0040`.
- Create `apps/daemon/src/harness-transitions/projection.ts` — insert + list + `rowToTransition`.
- Create `apps/daemon/src/harness-transitions/usecases.ts` — `recordHarnessTransition`.
- Create `apps/daemon/src/harness-transitions/routes.ts` — `registerHarnessTransitionRoutes`.
- Create `apps/daemon/src/harness-transitions/usecases.test.ts` — subsystem tests.
- Modify `apps/daemon/src/server.ts` — register routes.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — emit a `step_complete` transition in `advanceToNextStep`.

**Phase 2 — evidence**
- Modify `packages/contracts/src/harness/index.ts` — real `WorkflowSensorKind`, `SensorResult`, `EvidenceFacet`; tighten `HarnessTransition.evidence`.
- Create `apps/daemon/src/harness-sensors/detect.ts` — map `package.json` scripts → sensors.
- Create `apps/daemon/src/harness-sensors/runner.ts` — run sensors, build `EvidenceFacet`.
- Create `apps/daemon/src/harness-sensors/detect.test.ts` and `runner.test.ts`.
- Modify `apps/daemon/src/workflows/guardrails/evaluator.ts` — consume `required`, add `advance_with_failing_checks` candidate action.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — run sensors + veto in `approve_step_complete`; emit validation events.
- Create `apps/daemon/src/workflows/orchestrator/requires-execution.ts` — `stepRequiresExecution(guardrails, stepTemplateId)`.

---

# Phase 1 — HarnessTransition spine

### Task 1: HarnessTransition contract + event type

**Files:**
- Create: `packages/contracts/src/harness/index.ts`
- Modify: `packages/contracts/src/index.ts` (add re-export + event string)
- Test: `packages/contracts/src/harness/index.test.ts`

**Interfaces:**
- Produces: `HarnessTransitionBoundary` (`z.enum(["step_launch","step_complete","tool_gate","mark_done"])`), `HarnessTransition` (object with `id, goalId, workflowRunId|null, workflowStepRunId|null, boundary, risk|null, evidence|null, stateDeps|null, telemetry|null, createdAt`). In Phase 1 the four facets are `z.record(z.unknown()).nullable()` (opaque); Phase 2 tightens `evidence`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/harness/index.test.ts
import { describe, expect, it } from "vitest";
import { HarnessTransition, HarnessTransitionBoundary } from "./index.js";

describe("HarnessTransition", () => {
  it("accepts a spine record with null facets", () => {
    const parsed = HarnessTransition.parse({
      id: "t1",
      goalId: "g1",
      workflowRunId: "r1",
      workflowStepRunId: "s1",
      boundary: "step_complete",
      risk: null,
      evidence: null,
      stateDeps: null,
      telemetry: null,
      createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(parsed.boundary).toBe("step_complete");
    expect(parsed.evidence).toBeNull();
  });

  it("rejects an unknown boundary", () => {
    expect(HarnessTransitionBoundary.safeParse("nope").success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    const r = HarnessTransition.safeParse({
      id: "t1", goalId: "g1", workflowRunId: null, workflowStepRunId: null,
      boundary: "tool_gate", risk: null, evidence: null, stateDeps: null,
      telemetry: null, createdAt: "2026-06-23T00:00:00.000Z", extra: 1,
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test`
Expected: FAIL — cannot find module `./index.js` in `harness/`.

- [ ] **Step 3: Write the contract**

```ts
// packages/contracts/src/harness/index.ts
import { z } from "zod";

export const HarnessTransitionBoundary = z.enum([
  "step_launch",
  "step_complete",
  "tool_gate",
  "mark_done",
]);
export type HarnessTransitionBoundary = z.infer<typeof HarnessTransitionBoundary>;

// Facets are opaque in Phase 1; later phases replace each `z.record` with a
// strict schema (Phase 2 tightens `evidence`).
export const HarnessTransition = z
  .object({
    id: z.string().min(1).max(128),
    goalId: z.string().min(1).max(128),
    workflowRunId: z.string().min(1).max(128).nullable(),
    workflowStepRunId: z.string().min(1).max(128).nullable(),
    boundary: HarnessTransitionBoundary,
    risk: z.record(z.unknown()).nullable(),
    evidence: z.record(z.unknown()).nullable(),
    stateDeps: z.record(z.unknown()).nullable(),
    telemetry: z.record(z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type HarnessTransition = z.infer<typeof HarnessTransition>;
```

- [ ] **Step 4: Add the re-export and the event type**

In `packages/contracts/src/index.ts`, add the re-export next to the existing submodule re-exports (after line 12 `export * from "./workflows/index.js";`):

```ts
export * from "./harness/index.js";
```

In the same file, inside the `DomainEventType = z.enum([...])` array, add this string immediately after the `"activity.changed"` entry (the last element):

```ts
  "activity.changed",
  "harness.transition.recorded"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @orca/contracts typecheck`
Expected: no errors.

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add HarnessTransition spine contract + event type"
```

---

### Task 2: Migration — `harness_transitions` table

**Files:**
- Create: `apps/daemon/migrations/0040_harness_transitions.sql`
- Modify: `apps/daemon/src/migrations.ts`

**Interfaces:**
- Produces: table `harness_transitions(id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)` + indexes `idx_harness_transitions_goal`, `idx_harness_transitions_step_run`.

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0040_harness_transitions.sql
-- The HarnessTransition spine: one engine-emitted record per consequential
-- boundary (step launch/complete, tool gate, mark-done). Each reliability axis
-- is a nullable JSON facet column, filled in over later phases. Append-only;
-- rows are never updated.
CREATE TABLE harness_transitions (
  id                   TEXT PRIMARY KEY,
  goal_id              TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id      TEXT,
  workflow_step_run_id TEXT,
  boundary             TEXT NOT NULL,
  risk_json            TEXT,
  evidence_json        TEXT,
  state_deps_json      TEXT,
  telemetry_json       TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_harness_transitions_goal
  ON harness_transitions(goal_id, created_at DESC);
CREATE INDEX idx_harness_transitions_step_run
  ON harness_transitions(workflow_step_run_id, created_at DESC);
```

- [ ] **Step 2: Register the migration**

In `apps/daemon/src/migrations.ts`, append to the END of the `migrationFiles` array (after `"0039_workflow_run_pending_split_route.sql"`):

```ts
  "0039_workflow_run_pending_split_route.sql",
  "0040_harness_transitions.sql",
] as const;
```

- [ ] **Step 3: Verify the migration applies**

Run: `pnpm --filter @orca/daemon test -- migrations`
Expected: existing migration tests PASS (the runner applies `0040` without error). If no migration-specific test exists, defer verification to Task 3's test (which runs all migrations).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/migrations/0040_harness_transitions.sql apps/daemon/src/migrations.ts
git commit -m "feat(daemon): add harness_transitions migration"
```

---

### Task 3: Projection — insert + list

**Files:**
- Create: `apps/daemon/src/harness-transitions/projection.ts`
- Test: covered by Task 4's `usecases.test.ts` (projection has no events; its insert/list are exercised through the usecase). A focused projection test is folded into Task 4 to avoid a near-duplicate harness.

**Interfaces:**
- Consumes: `HarnessTransition` from `@orca/contracts`.
- Produces: `insertTransition(db, row: HarnessTransition): void`; `listTransitionsByGoal(db, goalId: string, limit?: number): HarnessTransition[]`; `resetPreparedStatements(): void`.

- [ ] **Step 1: Write the projection**

```ts
// apps/daemon/src/harness-transitions/projection.ts
import type Database from "better-sqlite3";
import { HarnessTransition } from "@orca/contracts";

interface TransitionRow {
  id: string;
  goal_id: string;
  workflow_run_id: string | null;
  workflow_step_run_id: string | null;
  boundary: string;
  risk_json: string | null;
  evidence_json: string | null;
  state_deps_json: string | null;
  telemetry_json: string | null;
  created_at: string;
}

const COLS = `id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
  risk_json, evidence_json, state_deps_json, telemetry_json, created_at`;

let _db: Database.Database | null = null;
let _stmts: {
  insert: Database.Statement;
  listByGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insert: db.prepare(
        `INSERT INTO harness_transitions (
          id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      listByGoal: db.prepare(
        `SELECT ${COLS} FROM harness_transitions
         WHERE goal_id = ? ORDER BY created_at DESC, id ASC LIMIT ?`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function parseFacet(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function rowToTransition(row: TransitionRow): HarnessTransition {
  return HarnessTransition.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id,
    boundary: row.boundary,
    risk: parseFacet(row.risk_json),
    evidence: parseFacet(row.evidence_json),
    stateDeps: parseFacet(row.state_deps_json),
    telemetry: parseFacet(row.telemetry_json),
    createdAt: row.created_at,
  });
}

export function insertTransition(db: Database.Database, row: HarnessTransition): void {
  const stmts = ensureStmts(db);
  stmts.insert.run(
    row.id,
    row.goalId,
    row.workflowRunId,
    row.workflowStepRunId,
    row.boundary,
    row.risk === null ? null : JSON.stringify(row.risk),
    row.evidence === null ? null : JSON.stringify(row.evidence),
    row.stateDeps === null ? null : JSON.stringify(row.stateDeps),
    row.telemetry === null ? null : JSON.stringify(row.telemetry),
    row.createdAt
  );
}

export function listTransitionsByGoal(
  db: Database.Database,
  goalId: string,
  limit = 100
): HarnessTransition[] {
  const stmts = ensureStmts(db);
  const rows = stmts.listByGoal.all(goalId, limit) as TransitionRow[];
  return rows.map(rowToTransition);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors (verified fully once Task 4 imports it).

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/harness-transitions/projection.ts
git commit -m "feat(daemon): harness-transitions projection (insert + list)"
```

---

### Task 4: Usecase — `recordHarnessTransition`

**Files:**
- Create: `apps/daemon/src/harness-transitions/usecases.ts`
- Test: `apps/daemon/src/harness-transitions/usecases.test.ts`

**Interfaces:**
- Consumes: `insertTransition`, `listTransitionsByGoal` from `./projection.js`; `EventBus` from `../events.js`.
- Produces: `interface HarnessTransitionCtx { db; bus; now?; idFactory? }`; `RecordTransitionInput = { goalId; workflowRunId?: string | null; workflowStepRunId?: string | null; boundary: HarnessTransitionBoundary; risk?; evidence?; stateDeps?; telemetry? }`; `recordHarnessTransition(ctx, input): HarnessTransition`; re-exports `listTransitionsByGoal`, `resetPreparedStatements`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-transitions/usecases.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import {
  recordHarnessTransition,
  listTransitionsByGoal,
  resetPreparedStatements,
  type HarnessTransitionCtx,
} from "./usecases.js";
import { resetPreparedStatements as resetProjectionStmts } from "./projection.js";

const tempDirs: string[] = [];

class SpyBus extends EventBus {
  readonly captured: DomainEvent[] = [];
  override publish(event: DomainEvent): void {
    this.captured.push(event);
    super.publish(event);
  }
}

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-harness-transitions-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, now, now);
}

let db: Database.Database;
let bus: SpyBus;
let ctx: HarnessTransitionCtx;
let counter = 0;

beforeEach(() => {
  db = openTestDb();
  bus = new SpyBus();
  counter = 0;
  ctx = {
    db,
    bus,
    now: () => "2026-05-01T00:00:00.000Z",
    idFactory: () => `id-${++counter}`,
  };
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recordHarnessTransition", () => {
  it("persists a spine transition and emits harness.transition.recorded", () => {
    seedGoal(db, "goal-1");

    const t = recordHarnessTransition(ctx, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      workflowStepRunId: "step-1",
      boundary: "step_complete",
    });

    expect(t.boundary).toBe("step_complete");
    expect(t.evidence).toBeNull();

    const listed = listTransitionsByGoal(db, "goal-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(t.id);

    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe("harness.transition.recorded");
    expect(bus.captured[0]!.payload).toMatchObject({
      transitionId: t.id,
      goalId: "goal-1",
      boundary: "step_complete",
    });
  });

  it("round-trips a non-null facet", () => {
    seedGoal(db, "goal-1");
    const t = recordHarnessTransition(ctx, {
      goalId: "goal-1",
      boundary: "tool_gate",
      risk: { permission_tier: "sandbox_edit" },
    });
    const listed = listTransitionsByGoal(db, "goal-1");
    expect(listed[0]!.risk).toEqual({ permission_tier: "sandbox_edit" });
    expect(t.workflowRunId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/usecases`
Expected: FAIL — cannot find module `./usecases.js`.

- [ ] **Step 3: Write the usecase**

```ts
// apps/daemon/src/harness-transitions/usecases.ts
import type Database from "better-sqlite3";
import type {
  DomainEvent,
  HarnessTransition,
  HarnessTransitionBoundary,
} from "@orca/contracts";
import type { EventBus } from "../events.js";
import { insertTransition, listTransitionsByGoal } from "./projection.js";

export { listTransitionsByGoal };
export { resetPreparedStatements } from "./projection.js";

export interface HarnessTransitionCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export type RecordTransitionInput = {
  goalId: string;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  boundary: HarnessTransitionBoundary;
  risk?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
  stateDeps?: Record<string, unknown> | null;
  telemetry?: Record<string, unknown> | null;
};

let _db: Database.Database | null = null;
let _insertEvent: Database.Statement | null = null;

function ensureEventStmt(db: Database.Database): Database.Statement {
  if (db !== _db) {
    _db = db;
    _insertEvent = db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    );
  }
  return _insertEvent!;
}

export function recordHarnessTransition(
  ctx: HarnessTransitionCtx,
  input: RecordTransitionInput
): HarnessTransition {
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFactory = ctx.idFactory ?? (() => crypto.randomUUID());
  const insertEvent = ensureEventStmt(ctx.db);

  const row: HarnessTransition = {
    id: idFactory(),
    goalId: input.goalId,
    workflowRunId: input.workflowRunId ?? null,
    workflowStepRunId: input.workflowStepRunId ?? null,
    boundary: input.boundary,
    risk: input.risk ?? null,
    evidence: input.evidence ?? null,
    stateDeps: input.stateDeps ?? null,
    telemetry: input.telemetry ?? null,
    createdAt: now,
  };

  const toPublish: DomainEvent[] = [];
  ctx.db.transaction(() => {
    insertTransition(ctx.db, row);
    const eventId = idFactory();
    const payload = {
      transitionId: row.id,
      goalId: row.goalId,
      boundary: row.boundary,
      workflowStepRunId: row.workflowStepRunId,
    };
    const result = insertEvent.run(
      eventId,
      "harness.transition.recorded",
      row.goalId,
      JSON.stringify(payload),
      now
    );
    toPublish.push({
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "harness.transition.recorded",
      goalId: row.goalId,
      payload,
      createdAt: now,
    });
  })();

  for (const event of toPublish) ctx.bus.publish(event);
  return row;
}
```

> Note: `crypto.randomUUID()` is available as a global in Node 20+ (the repo's `.nvmrc` target). Tests always inject `idFactory`, so the global is only the production default.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/usecases`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-transitions/usecases.ts apps/daemon/src/harness-transitions/usecases.test.ts
git commit -m "feat(daemon): recordHarnessTransition usecase + tests"
```

---

### Task 5: Routes + server wiring

**Files:**
- Create: `apps/daemon/src/harness-transitions/routes.ts`
- Modify: `apps/daemon/src/server.ts`

**Interfaces:**
- Consumes: `listTransitionsByGoal` from `./usecases.js`; `daemonContext.now`, `daemonContext.idFactory`, `eventBus`, `db` in `server.ts`.
- Produces: `registerHarnessTransitionRoutes(server, deps)`; route `GET /v1/goals/:goalId/harness-transitions` → `{ items: HarnessTransition[] }`.

- [ ] **Step 1: Write the routes module**

```ts
// apps/daemon/src/harness-transitions/routes.ts
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listTransitionsByGoal } from "./usecases.js";

export interface HarnessTransitionRouteDeps {
  db: Database.Database;
}

interface GoalRow {
  id: string;
}

export function registerHarnessTransitionRoutes(
  server: FastifyInstance,
  deps: HarnessTransitionRouteDeps
): void {
  const { db } = deps;
  const stmtGetGoal = db.prepare<[string], GoalRow>("SELECT id FROM goals WHERE id = ?");

  server.get("/v1/goals/:goalId/harness-transitions", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
    }
    const items = listTransitionsByGoal(db, goalId);
    return { items };
  });
}
```

- [ ] **Step 2: Register in `server.ts`**

Add the import next to the other subsystem route imports (e.g. after the `registerConflictRoutes` import around line 182):

```ts
import { registerHarnessTransitionRoutes } from "./harness-transitions/routes.js";
```

Register it next to the conflicts registration (around line 2001-2008):

```ts
  registerHarnessTransitionRoutes(server, { db });
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/harness-transitions/routes.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): expose GET /v1/goals/:goalId/harness-transitions"
```

---

### Task 6: Emit a `step_complete` transition in `advanceToNextStep`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/advance-transition.test.ts`

**Interfaces:**
- Consumes: `recordHarnessTransition` from `../../harness-transitions/usecases.js`; the service's `db`, `options.bus`, `now`, `options.idFactory`, and the `run`/`stepRun` in scope at the advance site.
- Produces: a `harness_transitions` row with `boundary: "step_complete"` per completed step. Facets remain `null` in Phase 1.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/workflows/orchestrator/advance-transition.test.ts
// Verifies advanceToNextStep records a step_complete transition. Uses the
// existing orchestrator test harness helpers; if a shared setup module exists
// (e.g. ./test-helpers), import it instead of re-deriving the run.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { EventBus } from "../../events.js";
import { listTransitionsByGoal, resetPreparedStatements } from "../../harness-transitions/usecases.js";
import { resetPreparedStatements as resetTxProj } from "../../harness-transitions/projection.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-advance-tx-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetTxProj();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("advanceToNextStep records a step_complete transition", () => {
  it("inserts a transition row when a step completes", () => {
    // ARRANGE: build a workflow run sitting at a completable step using the
    // orchestrator's existing test factory (see other *.test.ts in this dir for
    // `startRun`/`seedRun` helpers) and call service.advanceToNextStep.
    // ACT + ASSERT:
    //   const txns = listTransitionsByGoal(db, goalId);
    //   expect(txns.some((t) => t.boundary === "step_complete")).toBe(true);
    // The implementer wires the existing harness; the assertion above is the
    // contract this task must satisfy.
    expect(true).toBe(true); // replace with the wired assertion above
  });
});
```

> The orchestrator dir already contains `*.test.ts` files that construct a run (the audit referenced `service.ts` heavily). The implementer MUST replace the placeholder assertion with a real run built via the existing in-dir test helpers, then assert a `step_complete` transition exists. Do not ship the `expect(true).toBe(true)` line.

- [ ] **Step 2: Run test to verify it fails (after wiring the real assertion)**

Run: `pnpm --filter @orca/daemon test -- advance-transition`
Expected: FAIL — no transition row yet.

- [ ] **Step 3: Emit the transition in `advanceToNextStep`**

In `apps/daemon/src/workflows/orchestrator/service.ts`, add the import near the other subsystem imports at the top:

```ts
import { recordHarnessTransition } from "../../harness-transitions/usecases.js";
```

In the `advanceToNextStep` method, immediately AFTER the `await this.commitAdvanceOrComplete(...)` call and BEFORE the `const after = getWorkflowRunById(db, runId);` line, insert:

```ts
    // Record the engine-owned step-completion transition (spine; facets filled
    // by later phases). Self-contained record+publish — not part of the step's
    // atomic commit, so a failure here must never roll back the advance.
    try {
      recordHarnessTransition(
        { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
        {
          goalId: run.goalId,
          workflowRunId: run.id,
          workflowStepRunId: stepRun.id,
          boundary: "step_complete",
        }
      );
    } catch (err) {
      console.error("recordHarnessTransition failed", err);
    }
```

> `EventBus` and `getWorkflowRunById` are already imported in `service.ts` (used elsewhere in this method). `run`, `stepRun`, `now`, and `options` are all in scope at this point per the verbatim method body.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- advance-transition`
Expected: PASS.

- [ ] **Step 5: Run the full daemon suite (no regressions)**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS (existing orchestrator tests unaffected — the transition record is additive and failure-isolated).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/advance-transition.test.ts
git commit -m "feat(daemon): emit step_complete HarnessTransition on advance"
```

**End of Phase 1.** The spine records and serves transitions; facets are null. Phase 2 fills `evidence` and adds the veto.

---

# Phase 2 — Executable / EvidenceFacet

### Task 7: EvidenceFacet contract

**Files:**
- Modify: `packages/contracts/src/harness/index.ts`
- Test: `packages/contracts/src/harness/index.test.ts` (extend)

**Interfaces:**
- Produces: `WorkflowSensorKind` (`z.enum(["typecheck","lint","unit","integration","build","static"])`), `SensorResult`, `EvidenceFacet` (`{ sensorsRun, verdict, untestedRegions, residualRisk, oracleAdequacy }`). Tighten `HarnessTransition.evidence` from `z.record(z.unknown())` to `EvidenceFacet`.

- [ ] **Step 1: Extend the failing test**

Append to `packages/contracts/src/harness/index.test.ts`:

```ts
import { EvidenceFacet, HarnessTransition as HT } from "./index.js";

describe("EvidenceFacet", () => {
  it("accepts a failed verdict with one sensor", () => {
    const f = EvidenceFacet.parse({
      sensorsRun: [
        { kind: "unit", command: "pnpm test", exitCode: 1, durationMs: 1200,
          result: "failed", summary: "1 failing", artifactRef: null },
      ],
      verdict: "failed",
      untestedRegions: [],
      residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: ["typecheck did not run"] },
    });
    expect(f.verdict).toBe("failed");
  });

  it("is accepted as the evidence facet on a transition", () => {
    const t = HT.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: "s",
      boundary: "step_complete",
      risk: null,
      evidence: {
        sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
        oracleAdequacy: { sufficient: true, gaps: [] },
      },
      stateDeps: null, telemetry: null, createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(t.evidence?.verdict).toBe("passed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/contracts test`
Expected: FAIL — `EvidenceFacet` is not exported.

- [ ] **Step 3: Add the schemas and tighten the facet**

In `packages/contracts/src/harness/index.ts`, add ABOVE the `HarnessTransition` declaration:

```ts
export const WorkflowSensorKind = z.enum([
  "typecheck",
  "lint",
  "unit",
  "integration",
  "build",
  "static",
]);
export type WorkflowSensorKind = z.infer<typeof WorkflowSensorKind>;

export const SensorResult = z
  .object({
    kind: WorkflowSensorKind,
    command: z.string().min(1).max(512),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    result: z.enum(["passed", "failed", "skipped"]),
    summary: z.string().max(4000),
    artifactRef: z.string().max(256).nullable(),
  })
  .strict();
export type SensorResult = z.infer<typeof SensorResult>;

export const EvidenceFacet = z
  .object({
    sensorsRun: z.array(SensorResult).max(32),
    verdict: z.enum(["passed", "failed", "partial"]),
    untestedRegions: z.array(z.string().max(512)).max(64).default([]),
    residualRisk: z.array(z.string().max(512)).max(64).default([]),
    oracleAdequacy: z
      .object({
        sufficient: z.boolean(),
        gaps: z.array(z.string().max(256)).max(32).default([]),
      })
      .strict(),
  })
  .strict();
export type EvidenceFacet = z.infer<typeof EvidenceFacet>;
```

Then change the `evidence` line inside the `HarnessTransition` object from:

```ts
    evidence: z.record(z.unknown()).nullable(),
```
to:
```ts
    evidence: EvidenceFacet.nullable(),
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/contracts test`
Expected: PASS (all contract tests). Then `pnpm --filter @orca/contracts build` so the daemon sees the new exports.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts
git commit -m "feat(contracts): EvidenceFacet schema; tighten HarnessTransition.evidence"
```

---

### Task 8: Sensor detection from `package.json`

**Files:**
- Create: `apps/daemon/src/harness-sensors/detect.ts`
- Test: `apps/daemon/src/harness-sensors/detect.test.ts`

**Interfaces:**
- Produces: `type DetectedSensor = { kind: WorkflowSensorKind; command: string; args: string[] }`; `detectSensors(workspacePath: string, required: string[]): DetectedSensor[]`. Maps `required` labels (`"typecheck"`, `"unit_tests"`) to `package.json` scripts (`typecheck`, `test`). Returns sensors **cheapest-first** (typecheck before unit). A required label with no matching script is omitted (caller records the gap).

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-sensors/detect.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSensors } from "./detect.js";

const dirs: string[] = [];
function workspaceWith(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-detect-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("detectSensors", () => {
  it("maps required labels to package.json scripts, cheapest-first", () => {
    const ws = workspaceWith({ typecheck: "tsc --noEmit", test: "vitest run" });
    const sensors = detectSensors(ws, ["unit_tests", "typecheck"]);
    expect(sensors.map((s) => s.kind)).toEqual(["typecheck", "unit"]);
    expect(sensors[0]!.command).toBe("npm");
    expect(sensors[0]!.args).toEqual(["run", "typecheck"]);
  });

  it("omits a required label that has no matching script", () => {
    const ws = workspaceWith({ test: "vitest run" });
    const sensors = detectSensors(ws, ["typecheck", "unit_tests"]);
    expect(sensors.map((s) => s.kind)).toEqual(["unit"]);
  });

  it("returns nothing when there is no package.json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-detect-empty-"));
    dirs.push(dir);
    expect(detectSensors(dir, ["typecheck"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-sensors/detect`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the detector**

```ts
// apps/daemon/src/harness-sensors/detect.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowSensorKind } from "@orca/contracts";

export type DetectedSensor = {
  kind: WorkflowSensorKind;
  command: string;
  args: string[];
};

// Maps a guardrail `required` label to (sensor kind, package.json script name).
// Ordered cheapest-first so the runner can fail fast.
const LABEL_TO_SCRIPT: Array<{ label: string; kind: WorkflowSensorKind; script: string }> = [
  { label: "typecheck", kind: "typecheck", script: "typecheck" },
  { label: "lint", kind: "lint", script: "lint" },
  { label: "unit_tests", kind: "unit", script: "test" },
  { label: "build", kind: "build", script: "build" },
];

function readScripts(workspacePath: string): Record<string, string> {
  try {
    const raw = readFileSync(path.join(workspacePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export function detectSensors(workspacePath: string, required: string[]): DetectedSensor[] {
  const scripts = readScripts(workspacePath);
  const out: DetectedSensor[] = [];
  for (const entry of LABEL_TO_SCRIPT) {
    if (!required.includes(entry.label)) continue;
    if (typeof scripts[entry.script] !== "string") continue;
    out.push({ kind: entry.kind, command: "npm", args: ["run", entry.script] });
  }
  return out;
}
```

> `npm run <script>` is used (not `pnpm`) so detection is package-manager-agnostic; `npm` is present wherever `pnpm` is. If a workspace needs a different runner, the P2 override seam (spec §7) supplies it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-sensors/detect`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-sensors/detect.ts apps/daemon/src/harness-sensors/detect.test.ts
git commit -m "feat(daemon): detect verification sensors from package.json"
```

---

### Task 9: Sensor runner → EvidenceFacet

**Files:**
- Create: `apps/daemon/src/harness-sensors/runner.ts`
- Test: `apps/daemon/src/harness-sensors/runner.test.ts`

**Interfaces:**
- Consumes: `runCheckCommand` from `../readiness/exec.js`; `detectSensors` from `./detect.js`; `EvidenceFacet`, `SensorResult` types from `@orca/contracts`.
- Produces: `runSensors(opts: { workspacePath: string; required: string[]; timeoutMs?: number }): Promise<EvidenceFacet>`. Runs detected sensors cheapest-first, **fail-fast** (stops after the first failing sensor), summarizes output to ≤4000 chars, computes `verdict` (`failed` if any failed, else `passed`; `partial` if some required label had no sensor) and `oracleAdequacy` (`sufficient` = every required label produced a `passed` sensor).

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-sensors/runner.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSensors } from "./runner.js";

const dirs: string[] = [];
// A workspace whose `typecheck`/`test` scripts are deterministic node exits.
function workspace(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-runner-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("runSensors", () => {
  it("passes when the sensor command exits 0", async () => {
    const ws = workspace({ typecheck: "node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck"] });
    expect(ev.verdict).toBe("passed");
    expect(ev.sensorsRun).toHaveLength(1);
    expect(ev.sensorsRun[0]!.result).toBe("passed");
    expect(ev.oracleAdequacy.sufficient).toBe(true);
  }, 20000);

  it("fails and stops fast when a cheap sensor exits non-zero", async () => {
    const ws = workspace({
      typecheck: "node -e \"process.exit(1)\"",
      test: "node -e \"process.exit(0)\"",
    });
    const ev = await runSensors({ workspacePath: ws, required: ["unit_tests", "typecheck"] });
    expect(ev.verdict).toBe("failed");
    // Fail-fast: typecheck (cheapest) ran and failed; unit never ran.
    expect(ev.sensorsRun.map((s) => s.kind)).toEqual(["typecheck"]);
    expect(ev.oracleAdequacy.sufficient).toBe(false);
  }, 20000);

  it("is partial with a gap when a required label has no script", async () => {
    const ws = workspace({ typecheck: "node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck", "unit_tests"] });
    expect(ev.verdict).toBe("partial");
    expect(ev.oracleAdequacy.sufficient).toBe(false);
    expect(ev.oracleAdequacy.gaps.join(" ")).toContain("unit_tests");
  }, 20000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-sensors/runner`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the runner**

```ts
// apps/daemon/src/harness-sensors/runner.ts
import type { EvidenceFacet, SensorResult } from "@orca/contracts";
import { runCheckCommand } from "../readiness/exec.js";
import { inheritCredEnv } from "../readiness/exec.js";
import { detectSensors } from "./detect.js";

const SENSOR_TIMEOUT_MS = 180_000; // tests/typecheck need far longer than the 5s readiness default
const SUMMARY_MAX = 4000;

function summarize(stdout: string, stderr: string): string {
  const tail = (stderr + "\n" + stdout).trim();
  return tail.length > SUMMARY_MAX ? tail.slice(tail.length - SUMMARY_MAX) : tail;
}

export async function runSensors(opts: {
  workspacePath: string;
  required: string[];
  timeoutMs?: number;
}): Promise<EvidenceFacet> {
  const sensors = detectSensors(opts.workspacePath, opts.required);
  const detectedLabels = new Set(sensors.map((s) => s.kind));
  const sensorsRun: SensorResult[] = [];

  let failed = false;
  for (const sensor of sensors) {
    const res = await runCheckCommand(sensor.command, sensor.args, {
      cwd: opts.workspacePath,
      timeoutMs: opts.timeoutMs ?? SENSOR_TIMEOUT_MS,
      env: inheritCredEnv(),
    });
    const result: SensorResult["result"] = res.timedOut
      ? "failed"
      : res.exitCode === 0
        ? "passed"
        : "failed";
    sensorsRun.push({
      kind: sensor.kind,
      command: `${sensor.command} ${sensor.args.join(" ")}`,
      exitCode: res.exitCode ?? null,
      durationMs: res.durationMs,
      result,
      summary: summarize(res.stdout, res.stderr),
      artifactRef: null, // P2.5: offload full output; summary suffices for the veto
    });
    if (result === "failed") {
      failed = true;
      break; // fail-fast: a cheap failure pre-empts the expensive sensors
    }
  }

  // A required label maps to a sensor kind via detect.ts's LABEL_TO_SCRIPT.
  const requiredKinds: Array<{ label: string; kind: SensorResult["kind"] }> = [
    { label: "typecheck", kind: "typecheck" },
    { label: "lint", kind: "lint" },
    { label: "unit_tests", kind: "unit" },
    { label: "build", kind: "build" },
  ];
  const gaps: string[] = [];
  for (const rk of requiredKinds) {
    if (!opts.required.includes(rk.label)) continue;
    if (!detectedLabels.has(rk.kind)) gaps.push(`${rk.label}: no matching script`);
  }

  const missingRequired = gaps.length > 0;
  const verdict: EvidenceFacet["verdict"] = failed
    ? "failed"
    : missingRequired
      ? "partial"
      : "passed";

  const passedAllRequired =
    !failed &&
    !missingRequired &&
    sensorsRun.every((s) => s.result === "passed");

  return {
    sensorsRun,
    verdict,
    untestedRegions: [],
    residualRisk: [],
    oracleAdequacy: { sufficient: passedAllRequired, gaps },
  };
}
```

> `runCheckCommand`'s 256 KiB `MAX_BUFFER` is small for verbose suites; if a sensor trips `failureKind: "max_buffer"` its `exitCode` is `undefined` → treated as `failed` (conservative). Raising `MAX_BUFFER` is a P2.5 follow-up tracked in the spec, not this task.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-sensors/runner`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-sensors/runner.ts apps/daemon/src/harness-sensors/runner.test.ts
git commit -m "feat(daemon): sensor runner produces EvidenceFacet (cheapest-first, fail-fast)"
```

---

### Task 10: `stepRequiresExecution` helper

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/requires-execution.ts`
- Test: `apps/daemon/src/workflows/orchestrator/requires-execution.test.ts`

**Interfaces:**
- Consumes: `WorkflowGuardrailConfig[]` (the run template's guardrails).
- Produces: `stepRequiresExecution(guardrails, stepTemplateId): { required: string[] } | null` — returns the `required` labels if a `validation_rule` guardrail's `appliesToSteps` includes the step, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/workflows/orchestrator/requires-execution.test.ts
import { describe, expect, it } from "vitest";
import type { WorkflowGuardrailConfig } from "@orca/contracts";
import { stepRequiresExecution } from "./requires-execution.js";

const guardrails: WorkflowGuardrailConfig[] = [
  {
    id: "validation_required",
    kind: "validation_rule",
    label: "Require tests/typecheck",
    configJson: { appliesToSteps: ["execution"], required: ["unit_tests", "typecheck"] },
  },
];

describe("stepRequiresExecution", () => {
  it("returns required labels for a covered step", () => {
    expect(stepRequiresExecution(guardrails, "execution")).toEqual({
      required: ["unit_tests", "typecheck"],
    });
  });
  it("returns null for an uncovered step", () => {
    expect(stepRequiresExecution(guardrails, "research")).toBeNull();
  });
  it("returns null when there is no validation_rule guardrail", () => {
    expect(stepRequiresExecution([], "execution")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- requires-execution`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
// apps/daemon/src/workflows/orchestrator/requires-execution.ts
import { z } from "zod";
import type { WorkflowGuardrailConfig } from "@orca/contracts";

const ValidationRuleConfig = z.object({
  appliesToSteps: z.array(z.string()).optional(),
  required: z.array(z.string()).optional(),
});

export function stepRequiresExecution(
  guardrails: WorkflowGuardrailConfig[],
  stepTemplateId: string
): { required: string[] } | null {
  for (const g of guardrails) {
    if (g.kind !== "validation_rule") continue;
    const cfg = ValidationRuleConfig.safeParse(g.configJson);
    if (!cfg.success) continue;
    const applies = cfg.data.appliesToSteps ?? [];
    if (applies.includes(stepTemplateId)) {
      return { required: cfg.data.required ?? [] };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- requires-execution`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/requires-execution.ts apps/daemon/src/workflows/orchestrator/requires-execution.test.ts
git commit -m "feat(daemon): stepRequiresExecution from validation_rule guardrail"
```

---

### Task 11: Evidence veto in `approve_step_complete` + validation events

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/evidence-veto.test.ts`

**Interfaces:**
- Consumes: `runSensors` from `../../harness-sensors/runner.js`; `stepRequiresExecution` from `./requires-execution.js`; the run's workspace path (resolve via the existing workspace lookup the service already uses to spawn step agents); `this.reviseStep`; `appendWorkflowEvent`.
- Produces: when the active step requires execution, sensors run BEFORE the supervision branch; a `failed`/`partial` verdict short-circuits to `reviseStep` (deterministic veto) with sensor summaries as feedback; on `passed`, completion proceeds unchanged. Emits `workflow.validation.run` always, then `workflow.validation.passed` or `workflow.validation.failed`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/workflows/orchestrator/evidence-veto.test.ts
// Builds a run parked at a requires-execution step whose workspace has a
// failing `typecheck` script, drives the approve_step_complete path, and
// asserts the step does NOT advance and a revise is issued. Reuse the existing
// orchestrator test helpers in this directory to construct the run/session.
import { describe, expect, it } from "vitest";

describe("evidence veto", () => {
  it("vetoes completion when a required sensor fails", async () => {
    // ARRANGE: run at step "execution"; workspace package.json has
    //   { scripts: { typecheck: "node -e \"process.exit(1)\"" } }
    // ACT: invoke the mediator action approve_step_complete for that step.
    // ASSERT:
    //   - run.currentStepRunId is unchanged (no advance)
    //   - a revise message / revise_attempts bump occurred
    //   - listTransitionsByGoal(...) includes a step_complete transition whose
    //     evidence.verdict === "failed"
    expect(true).toBe(true); // replace with wired assertions above
  });

  it("allows completion when required sensors pass", async () => {
    // Same setup but typecheck exits 0 → step advances; evidence.verdict==="passed".
    expect(true).toBe(true); // replace with wired assertions above
  });
});
```

> The implementer wires these against the directory's existing run-construction helpers (same ones Task 6 used) and replaces the placeholder assertions. Do not ship `expect(true).toBe(true)`.

- [ ] **Step 2: Run to verify it fails (after wiring)**

Run: `pnpm --filter @orca/daemon test -- evidence-veto`
Expected: FAIL — completion currently advances regardless of sensors.

- [ ] **Step 3: Add imports**

In `service.ts`, add near the other imports:

```ts
import { runSensors } from "../../harness-sensors/runner.js";
import { stepRequiresExecution } from "./requires-execution.js";
import { appendWorkflowEvent } from "../events.js";
```

> If `appendWorkflowEvent` is already imported in `service.ts`, do not re-add it.

- [ ] **Step 4: Insert the veto at the top of the `approve_step_complete` case**

In the `case "approve_step_complete": {` block, AFTER the existing `interview` open-questions check and BEFORE `const finishedAt = now();`, insert:

```ts
        // Deterministic evidence gate: for steps that require execution, run the
        // sensor ladder in the workspace and veto the LLM's approval if the
        // verdict is not "passed". Runs before the supervision branch so it
        // applies to both supervised and unsupervised completions.
        const execReq = stepRequiresExecution(template.guardrails, ctx.stepTpl.id);
        if (execReq) {
          const workspacePath = this.resolveWorkspacePath(db, ctx.run);
          const evidence = workspacePath
            ? await runSensors({ workspacePath, required: execReq.required })
            : null;

          const evStaged: DomainEvent[] = [];
          evStaged.push(
            appendWorkflowEvent(
              db,
              "workflow.validation.run",
              { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
              now(),
              options.idFactory
            )
          );

          // Record the evidence facet on the step_complete transition regardless
          // of outcome (inspectability), then decide advance vs veto.
          recordHarnessTransition(
            { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
            {
              goalId: ctx.run.goalId,
              workflowRunId: ctx.run.id,
              workflowStepRunId: ctx.stepRun.id,
              boundary: "step_complete",
              evidence: evidence ?? undefined,
            }
          );

          if (evidence && evidence.verdict !== "passed") {
            evStaged.push(
              appendWorkflowEvent(
                db,
                "workflow.validation.failed",
                { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
                now(),
                options.idFactory
              )
            );
            this.publish(options.bus, evStaged);
            const failingSummary = evidence.sensorsRun
              .filter((s) => s.result === "failed")
              .map((s) => `- ${s.kind} (\`${s.command}\`): ${s.summary.slice(0, 600)}`)
              .join("\n");
            const gapSummary =
              evidence.oracleAdequacy.gaps.length > 0
                ? `\nMissing required checks: ${evidence.oracleAdequacy.gaps.join(", ")}`
                : "";
            return this.reviseStep(
              db,
              now,
              ctx,
              sessionId,
              `Required verification did not pass. Fix these and re-run, then re-emit completion:\n${failingSummary}${gapSummary}`,
              options
            );
          }
          evStaged.push(
            appendWorkflowEvent(
              db,
              "workflow.validation.passed",
              { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
              now(),
              options.idFactory
            )
          );
          this.publish(options.bus, evStaged);
        }
```

> This reuses `recordHarnessTransition`, `EventBus`, `DomainEvent`, and `this.publish` already imported/available in `service.ts` (Task 6 added `recordHarnessTransition`). When the evidence gate emits its own `step_complete` transition here, remove the Phase-1 unconditional emission in `advanceToNextStep` for requires-execution steps to avoid a duplicate — see Step 5.

- [ ] **Step 5: De-duplicate the transition emission**

In `advanceToNextStep` (Task 6's insertion), guard the Phase-1 emission so it only fires for steps WITHOUT an evidence gate (the gated steps emit their transition in Task 11 Step 4). Change the Task 6 block to:

```ts
    const advExecReq = stepRequiresExecution(loadRunTemplate(db, run)?.guardrails ?? [], stepRun.step_template_id);
    if (!advExecReq) {
      try {
        recordHarnessTransition(
          { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
          {
            goalId: run.goalId,
            workflowRunId: run.id,
            workflowStepRunId: stepRun.id,
            boundary: "step_complete",
          }
        );
      } catch (err) {
        console.error("recordHarnessTransition failed", err);
      }
    }
```

> `loadRunTemplate` and `stepRun.step_template_id` are already used in `advanceToNextStep` per the verbatim body; import `stepRequiresExecution` is added in Step 3.

- [ ] **Step 6: Add the workspace resolver if absent**

If `service.ts` has no `resolveWorkspacePath(db, run)` helper, add a private method that returns the run's primary workspace path (mirror however `spawnStepAgent` obtains the `cwd` it passes to the launcher — reuse that exact lookup). If the run has no workspace, return `null` (the veto is skipped and the step completes as today — a non-git/no-workspace goal can't run sensors).

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- evidence-veto`
Expected: PASS.

- [ ] **Step 8: Full suite (no regressions)**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/evidence-veto.test.ts
git commit -m "feat(daemon): deterministic evidence veto on step completion + validation events"
```

---

### Task 12: Activate the `validation_rule` guardrail at launch (consume `required`)

**Files:**
- Modify: `apps/daemon/src/workflows/guardrails/evaluator.ts`
- Test: `apps/daemon/src/workflows/guardrails/evaluator.test.ts` (extend; file exists)

**Interfaces:**
- Consumes: existing `GuardrailContext`, `parseValidationRuleConfig`.
- Produces: the `validation_rule` branch also handles a new `candidateAction` kind `{ kind: "advance_with_failing_checks" }` → `require_approval` when the step is covered. The `skip_validation` behavior is unchanged. This lets a future caller route an admitted-failing advance through approval rather than silently; `required` is now read (it was dormant).

> Scope note: this task wires the guardrail's *capability*; the evidence veto in Task 11 is the primary enforcement. Adding the candidate-action kind makes the dormant `required` config meaningful and unblocks the Governed phase. No caller is forced to emit the new action yet.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/workflows/guardrails/evaluator.test.ts`:

```ts
import { evaluateGuardrailRequiresApproval } from "./evaluator.js";
import type { WorkflowGuardrailConfig } from "@orca/contracts";

const validationGuardrail: WorkflowGuardrailConfig = {
  id: "validation_required",
  kind: "validation_rule",
  label: "Require tests/typecheck",
  configJson: { appliesToSteps: ["execution"], required: ["unit_tests", "typecheck"] },
};

describe("validation_rule advance_with_failing_checks", () => {
  it("requires approval to advance a covered step with failing checks", () => {
    const result = evaluateGuardrailRequiresApproval([validationGuardrail], {
      goalId: "g", workflowRunId: "r", stepRunId: "s", stepTemplateId: "execution",
      candidateAction: { kind: "advance_with_failing_checks" },
    });
    expect(result).toBe("require_approval");
  });

  it("allows advancing an uncovered step", () => {
    const result = evaluateGuardrailRequiresApproval([validationGuardrail], {
      goalId: "g", workflowRunId: "r", stepRunId: "s", stepTemplateId: "research",
      candidateAction: { kind: "advance_with_failing_checks" },
    });
    expect(result).toBe("allow");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- guardrails/evaluator`
Expected: FAIL — `advance_with_failing_checks` is not a valid `candidateAction` kind (type error) and the branch doesn't handle it.

- [ ] **Step 3: Extend the candidate-action union and the branch**

In `evaluator.ts`, add the new kind to the `GuardrailContext.candidateAction` union:

```ts
  candidateAction:
    | { kind: "launch_workflow_session"; operatorId: string }
    | { kind: "advance_step" }
    | { kind: "mark_run_complete" }
    | { kind: "skip_validation" }
    | { kind: "advance_with_failing_checks" }
    | { kind: "select_operator"; operatorId: string }
    | { kind: "use_raw_terminal_output" };
```

In the `case "validation_rule":` branch, replace the body so it consumes `required` and handles both actions:

```ts
    case "validation_rule": {
      const cfg = parseValidationRuleConfig(guardrail.configJson);
      const appliesToStep =
        ctx.stepTemplateId !== undefined &&
        (cfg.appliesToSteps ?? []).includes(ctx.stepTemplateId);
      const gatedKinds = new Set(["skip_validation", "advance_with_failing_checks"]);
      if (gatedKinds.has(ctx.candidateAction.kind) && appliesToStep) {
        return {
          guardrailId: guardrail.id,
          kind: guardrail.kind,
          result: "require_approval",
          message:
            ctx.candidateAction.kind === "skip_validation"
              ? "validation skip requires explicit reason"
              : `advancing with failing/again required checks (${cfg.required.join(", ")}) requires approval`,
        };
      }
      return { guardrailId: guardrail.id, kind: guardrail.kind, result: "allow" };
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- guardrails/evaluator`
Expected: PASS (new + existing guardrail tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/guardrails/evaluator.ts apps/daemon/src/workflows/guardrails/evaluator.test.ts
git commit -m "feat(daemon): activate validation_rule guardrail (consume required; advance_with_failing_checks)"
```

**End of Phase 2.** Step completion for execution steps is now grounded in executed sensors with a deterministic veto, recorded as an `EvidenceFacet` on the step-completion transition, with the validation events finally emitted.

---

## Self-Review

**Spec coverage (against `2026-06-23-harness-axes-design.md`):**
- §3 HarnessTransition spine (record, 4 boundaries, engine-owned, additive) → Tasks 1–6. (Phase 1 emits at the `step_complete` boundary; the other three boundaries — `step_launch`, `tool_gate`, `mark_done` — are emitted by the Governed/later phases, per the roadmap; the contract supports them now.)
- §4.1 EvidenceFacet, daemon sensor runner, cheapest-first fail-fast, deterministic veto, oracle-adequacy, activate `validation_rule`, emit `workflow.validation.passed` → Tasks 7–12.
- §4.1 artifact offload (`artifact_ref`) → deferred to P2.5 (noted in Task 9; `artifactRef` is `null` for now). Flagged, not silently dropped.
- §7 sensor auto-detect from `package.json`, override seam → Task 8 (override seam is the documented P2 follow-up).

**Placeholder scan:** Two tests (Task 6, Task 11) carry `expect(true).toBe(true)` with explicit instructions to replace them against the orchestrator dir's existing run-construction helpers — unavoidable because those helpers' exact names live in files outside this plan's verbatim set. Every other step ships complete code. The implementer MUST wire those two before committing; the assertions to satisfy are written out.

**Type consistency:** `HarnessTransition`/`EvidenceFacet`/`SensorResult` field names are identical across contract (Task 1/7), projection (Task 3), usecase (Task 4), and the veto (Task 11). `WorkflowSensorKind` values (`typecheck|lint|unit|integration|build|static`) match between `detect.ts`, `runner.ts`, and the contract. `recordHarnessTransition` signature is identical in Task 4, Task 6, and Task 11. The `candidateAction` union extension in Task 12 matches the verbatim union from the recon.

**Known integration risks to verify during execution:** (1) `resolveWorkspacePath` may not exist — Task 11 Step 6 instructs mirroring `spawnStepAgent`'s cwd lookup. (2) The supervised completion path stashes `pending_completion_json` and completes later (recon flagged line ~2012); because the veto runs BEFORE the supervision branch, a failing verdict vetoes before any stash is written — confirm in the Task 11 test that a supervised-mode run also vetoes. (3) `appendWorkflowEvent` enforces a 4096-byte payload cap — the validation event payloads here are tiny, so they fit.
