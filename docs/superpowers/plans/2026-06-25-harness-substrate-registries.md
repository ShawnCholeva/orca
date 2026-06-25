# Harness Substrate Registries (Phase 0.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the harness facet/boundary/sensor vocabulary behind three self-registering registries (`defineFacet`/`defineBoundary`/`defineSensor`) with load-time + test conformance guards, expose it via `GET /v1/harness/registry`, fix the unvalidated write path, and fire the dormant `mark_done` terminal.

**Architecture:** Each registry is a module-level array populated by a `define*` helper and exported as `HARNESS_FACETS`/`HARNESS_BOUNDARIES`/`HARNESS_SENSORS`. Runtime wiring (projection serialize/parse, typed emitters, sensor detection) loops over the registry instead of hand-listed parallel arrays. Contract Zod types stay **hand-written**; conformance guards assert registry ≡ contract ≡ DB/enum. No mapped-type codegen.

**Tech Stack:** TypeScript, Zod, better-sqlite3, Fastify, vitest. pnpm workspace monorepo (`@orca/contracts`, `@orca/daemon`).

## Global Constraints

- **`@orca/contracts` resolves to built `dist`** (`exports` → `./dist/index.js`). After ANY change to `packages/contracts/src/**`, run `pnpm --filter @orca/contracts build` before the daemon can typecheck/test against the new exports. (`@orca/contracts`'s own tests run against src and do not need a build.)
- **No mapped-type contract generation.** `HarnessTransition`, `HarnessTransitionBoundary`, `WorkflowSensorKind` stay hand-written. Registries drive runtime wiring only; guards keep them in sync.
- **Phase 0 = no behavior change**, with two deliberate, approved exceptions: (1) validate-on-write **throws** on invalid facet; (2) `mark_done` fires on human-accepted completion carrying a minimal `TelemetryFacet`.
- **Emitters are the only sanctioned write path.** `recordHarnessTransition` becomes an internal implementation detail of the emit factory (not deleted — the emitters call it — but no new direct callers).
- **Swallow-and-log** any emit at completion so a transition failure never breaks goal completion.
- Single-file test command: `pnpm --filter @orca/daemon test -- <path-substr>` ; contracts: `pnpm --filter @orca/contracts test -- <path-substr>`. Typecheck: `pnpm --filter @orca/<pkg> typecheck`.
- Commit after each task. We are on `main` — the executor should create a feature branch before Task 1 (e.g. `feat/harness-registries`).

---

### Task 1: `defineFacet` registry + projection/usecases rewrite + facet conformance guard

**Files:**
- Modify: `packages/contracts/src/harness/index.ts` (add registry after `StateDepsFacet`, before `HarnessTransition` ~line 184)
- Modify: `apps/daemon/src/harness-transitions/projection.ts` (COLS/INSERT/serialize/parse → registry loops)
- Modify: `apps/daemon/src/harness-transitions/usecases.ts` (row build → registry loop)
- Create: `apps/daemon/src/harness-transitions/conformance.ts`
- Create: `apps/daemon/src/harness-transitions/conformance.test.ts`
- Modify: `apps/daemon/src/index.ts:77` (load-time guard call after `runMigrations`)

**Interfaces:**
- Produces: `HARNESS_FACETS: readonly FacetSpec[]` where `FacetSpec = { key: "risk"|"evidence"|"stateDeps"|"telemetry"; column: string; schema: z.ZodTypeAny }`; `type FacetKey = FacetSpec["key"]`; both exported from `@orca/contracts`.
- Produces: `assertFacetConformance(db: Database.Database): void` and `assertHarnessRegistryConformance(db: Database.Database): void` from `harness-transitions/conformance.ts`.

- [ ] **Step 1: Write the failing contracts test for the facet registry**

Create/append to `packages/contracts/src/harness/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HarnessTransition, HARNESS_FACETS } from "./index.js";

describe("HARNESS_FACETS registry", () => {
  const ENVELOPE_KEYS = ["boundary", "createdAt", "goalId", "id", "workflowRunId", "workflowStepRunId"];

  it("registers exactly the facet fields of HarnessTransition", () => {
    const shapeKeys = Object.keys(HarnessTransition.shape).sort();
    const facetKeys = shapeKeys.filter((k) => !ENVELOPE_KEYS.includes(k));
    expect(HARNESS_FACETS.map((f) => f.key).sort()).toEqual(facetKeys);
  });

  it("maps each facet key to its snake_case _json column", () => {
    expect(HARNESS_FACETS.map((f) => [f.key, f.column])).toEqual([
      ["risk", "risk_json"],
      ["evidence", "evidence_json"],
      ["stateDeps", "state_deps_json"],
      ["telemetry", "telemetry_json"],
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/contracts test -- src/harness/index.test.ts`
Expected: FAIL — `HARNESS_FACETS` is not exported.

- [ ] **Step 3: Add the facet registry to the contract**

In `packages/contracts/src/harness/index.ts`, insert immediately after the `StateDepsFacet` type export (after line 184) and before the `HarnessTransition` comment block:

```ts
// ── Facet registry ────────────────────────────────────────────────────────────
// Single source for the closed facet vocabulary. Projection + usecases loop over
// this instead of hand-listing each facet. `HarnessTransition` below stays
// hand-written (no codegen); a conformance guard (daemon) asserts they agree.
export type FacetSpec = {
  key: "risk" | "evidence" | "stateDeps" | "telemetry";
  column: string;
  schema: z.ZodTypeAny;
};
export type FacetKey = FacetSpec["key"];

const FACET_REGISTRY: FacetSpec[] = [];
function defineFacet(spec: FacetSpec): FacetSpec {
  FACET_REGISTRY.push(spec);
  return spec;
}

defineFacet({ key: "risk", column: "risk_json", schema: RiskFacet });
defineFacet({ key: "evidence", column: "evidence_json", schema: EvidenceFacet });
defineFacet({ key: "stateDeps", column: "state_deps_json", schema: StateDepsFacet });
defineFacet({ key: "telemetry", column: "telemetry_json", schema: TelemetryFacet });

export const HARNESS_FACETS: readonly FacetSpec[] = FACET_REGISTRY;
```

- [ ] **Step 4: Run the contracts test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- src/harness/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Build contracts so the daemon sees the new exports**

Run: `pnpm --filter @orca/contracts build`
Expected: exit 0.

- [ ] **Step 6: Rewrite the projection to loop over the registry**

Replace the body of `apps/daemon/src/harness-transitions/projection.ts` lines 2–84 (keep `import type Database`) so that COLS, INSERT, parse-back, and serialize all derive from `HARNESS_FACETS`:

```ts
import type Database from "better-sqlite3";
import { HarnessTransition, HARNESS_FACETS } from "@orca/contracts";

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

const ENVELOPE_COLS = ["id", "goal_id", "workflow_run_id", "workflow_step_run_id", "boundary"];
const FACET_COLS = HARNESS_FACETS.map((f) => f.column);
const ALL_COLS = [...ENVELOPE_COLS, ...FACET_COLS, "created_at"];
const COLS = ALL_COLS.join(", ");
const PLACEHOLDERS = ALL_COLS.map(() => "?").join(", ");

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
        `INSERT INTO harness_transitions (${COLS}) VALUES (${PLACEHOLDERS})`
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
  const facets: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    facets[f.key] = parseFacet(row[f.column as keyof TransitionRow] as string | null);
  }
  return HarnessTransition.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    workflowStepRunId: row.workflow_step_run_id,
    boundary: row.boundary,
    ...facets,
    createdAt: row.created_at,
  });
}

export function insertTransition(db: Database.Database, row: HarnessTransition): void {
  const stmts = ensureStmts(db);
  const facetArgs = HARNESS_FACETS.map((f) => {
    const v = (row as Record<string, unknown>)[f.key];
    return v == null ? null : JSON.stringify(v);
  });
  stmts.insert.run(
    row.id,
    row.goalId,
    row.workflowRunId,
    row.workflowStepRunId,
    row.boundary,
    ...facetArgs,
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

- [ ] **Step 7: Rewrite the usecases row-build to loop over the registry, and validate-on-write**

In `apps/daemon/src/harness-transitions/usecases.ts`, replace the row literal (lines 56–67) and the insert (line 71) so the facets are assigned via the registry **and the row is validated before persistence**. Update imports to add `HARNESS_FACETS` (a value import) and keep the facet type imports.

Change the import block (lines 2–10) to:

```ts
import {
  HARNESS_FACETS,
  HarnessTransition,
  type DomainEvent,
  type EvidenceFacet,
  type HarnessTransitionBoundary,
  type RiskFacet,
  type StateDepsFacet,
  type TelemetryFacet,
} from "@orca/contracts";
```

Replace lines 56–71 (the `const row` literal through `insertTransition(ctx.db, row)`) with:

```ts
  const facetFields: Record<string, unknown> = {};
  for (const f of HARNESS_FACETS) {
    facetFields[f.key] = (input as Record<string, unknown>)[f.key] ?? null;
  }
  // Validate-on-write: the choke point all emitters funnel through. Parsing here
  // (not in each emitter) means every write is validated and throws on invalid,
  // and the persisted form equals the validated form. Closes the prior gap where
  // the write path returned an unvalidated in-memory row.
  const row: HarnessTransition = HarnessTransition.parse({
    id: idFactory(),
    goalId: input.goalId,
    workflowRunId: input.workflowRunId ?? null,
    workflowStepRunId: input.workflowStepRunId ?? null,
    boundary: input.boundary,
    ...facetFields,
    createdAt: now,
  });

  const toPublish: DomainEvent[] = [];
  ctx.db.transaction(() => {
    insertTransition(ctx.db, row);
```

(Leave the rest of `recordHarnessTransition` — the event insert and `return row` — unchanged.)

- [ ] **Step 8: Write the failing daemon conformance test**

Create `apps/daemon/src/harness-transitions/conformance.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { assertFacetConformance } from "./conformance.js";

const dirs: string[] = [];
function config(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node", "x.js"],
    getAuthToken: () => "t",
  };
}
function migratedDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-conformance-"));
  dirs.push(dir);
  const db = openDatabase(config(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
afterEach(() => { closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("assertFacetConformance", () => {
  it("passes on a migrated database", () => {
    const db = migratedDb();
    expect(() => assertFacetConformance(db)).not.toThrow();
  });

  it("throws when the harness_transitions table is missing a facet column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE harness_transitions (id TEXT, goal_id TEXT)");
    expect(() => assertFacetConformance(db)).toThrow(/risk_json/);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/conformance`
Expected: FAIL — `./conformance.js` does not exist.

- [ ] **Step 10: Implement the conformance guard**

Create `apps/daemon/src/harness-transitions/conformance.ts`:

```ts
import type Database from "better-sqlite3";
import { HarnessTransition, HARNESS_FACETS } from "@orca/contracts";

const ENVELOPE_KEYS = new Set([
  "id", "goalId", "workflowRunId", "workflowStepRunId", "boundary", "createdAt",
]);

/**
 * Assert the facet registry stays in lockstep with the contract and the DB:
 *  - registry keys === the non-envelope fields of HarnessTransition
 *  - every registry column exists on the harness_transitions table
 * Throws loud on drift (called at daemon load + in tests).
 */
export function assertFacetConformance(db: Database.Database): void {
  const shapeKeys = Object.keys(HarnessTransition.shape);
  const contractFacetKeys = shapeKeys.filter((k) => !ENVELOPE_KEYS.has(k)).sort();
  const registryKeys = HARNESS_FACETS.map((f) => f.key).slice().sort();
  if (JSON.stringify(contractFacetKeys) !== JSON.stringify(registryKeys)) {
    throw new Error(
      `Harness facet drift: registry [${registryKeys}] != contract facet fields [${contractFacetKeys}]`
    );
  }

  const cols = new Set(
    (db.prepare("PRAGMA table_info(harness_transitions)").all() as { name: string }[]).map((r) => r.name)
  );
  for (const f of HARNESS_FACETS) {
    if (!cols.has(f.column)) {
      throw new Error(`Harness facet drift: column '${f.column}' (facet '${f.key}') missing from harness_transitions`);
    }
  }
}

/** Aggregator invoked once at daemon startup. Extended by later tasks. */
export function assertHarnessRegistryConformance(db: Database.Database): void {
  assertFacetConformance(db);
}
```

- [ ] **Step 11: Run the conformance test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/conformance`
Expected: PASS (both cases).

- [ ] **Step 12: Wire the load-time guard into daemon startup**

In `apps/daemon/src/index.ts`, add an import near the other harness imports:

```ts
import { assertHarnessRegistryConformance } from './harness-transitions/conformance.js';
```

And immediately after the `runMigrations(db, migrationsDir);` call (line 77), add:

```ts
    assertHarnessRegistryConformance(db);
```

- [ ] **Step 13: Run the existing harness-transitions suite + typecheck to confirm no regression**

Run: `pnpm --filter @orca/daemon test -- harness-transitions`
Expected: PASS (existing `usecases.test.ts` record + round-trip still green).

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0.

- [ ] **Step 14: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts \
  apps/daemon/src/harness-transitions/projection.ts apps/daemon/src/harness-transitions/usecases.ts \
  apps/daemon/src/harness-transitions/conformance.ts apps/daemon/src/harness-transitions/conformance.test.ts \
  apps/daemon/src/index.ts
git commit -m "feat(harness): defineFacet registry + registry-driven projection + facet conformance guard"
```

---

### Task 2: `defineBoundary` emit factory + replace the 5 emit sites + boundary conformance

**Files:**
- Create: `apps/daemon/src/harness-transitions/emit.ts`
- Create: `apps/daemon/src/harness-transitions/emit.test.ts`
- Modify: `apps/daemon/src/permission-gate.ts` (use `emitToolGate`)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (use `emitStepComplete` ×3, `emitStepLaunch` ×1)
- Modify: `apps/daemon/src/harness-transitions/conformance.ts` (add `assertBoundaryConformance`)
- Modify: `apps/daemon/src/harness-transitions/conformance.test.ts` (add a boundary case)

**Interfaces:**
- Consumes: `recordHarnessTransition`, `HarnessTransitionCtx` from `./usecases.js`.
- Produces: `emitToolGate`, `emitStepComplete`, `emitStepLaunch`, `emitMarkDone` (each `(ctx: HarnessTransitionCtx, input) => HarnessTransition`), and `HARNESS_BOUNDARIES: { key: HarnessTransitionBoundary; facets: readonly FacetKey[] }[]` from `./emit.js`.
- Produces: `assertBoundaryConformance(): void` from `./conformance.js`.

Emitter input shapes (what later tasks/sites pass):
- `emitToolGate(ctx, { goalId, workflowRunId?, workflowStepRunId?, risk? })`
- `emitStepComplete(ctx, { goalId, workflowRunId?, workflowStepRunId?, evidence?, stateDeps?, telemetry? })`
- `emitStepLaunch(ctx, { goalId, workflowRunId?, workflowStepRunId?, stateDeps? })`
- `emitMarkDone(ctx, { goalId, workflowRunId?, workflowStepRunId?, telemetry? })`

- [ ] **Step 1: Write the failing emit-factory test**

Create `apps/daemon/src/harness-transitions/emit.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { listTransitionsByGoal, resetPreparedStatements, type HarnessTransitionCtx } from "./usecases.js";
import { resetPreparedStatements as resetProjStmts } from "./projection.js";
import { emitStepComplete, emitMarkDone, HARNESS_BOUNDARIES } from "./emit.js";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
function seedGoal(db: Database.Database, id: string) {
  db.prepare(`INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
    VALUES (?, 'G', '', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`).run(id);
}
let db: Database.Database; let ctx: HarnessTransitionCtx; let n = 0;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-emit-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  n = 0; ctx = { db, bus: new EventBus(), now: () => "2026-05-01T00:00:00.000Z", idFactory: () => `id-${++n}` };
});
afterEach(() => { closeDatabase(); resetPreparedStatements(); resetProjStmts(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("emit factory", () => {
  it("emitStepComplete records the step_complete boundary", () => {
    seedGoal(db, "g1");
    emitStepComplete(ctx, { goalId: "g1", workflowRunId: "r1", workflowStepRunId: "s1" });
    const items = listTransitionsByGoal(db, "g1");
    expect(items).toHaveLength(1);
    expect(items[0]!.boundary).toBe("step_complete");
  });

  it("emitMarkDone records a mark_done transition carrying telemetry", () => {
    seedGoal(db, "g1");
    emitMarkDone(ctx, {
      goalId: "g1", workflowRunId: "r1",
      telemetry: {
        cost: null, latency_ms: null, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [],
        human_interventions: [{ kind: "mark_done_approval", ref: "rec-1" }],
        outcome: { status: "succeeded", failure_code: null },
      },
    });
    const items = listTransitionsByGoal(db, "g1");
    expect(items[0]!.boundary).toBe("mark_done");
    expect(items[0]!.telemetry?.outcome.status).toBe("succeeded");
    expect(items[0]!.telemetry?.human_interventions[0]!.kind).toBe("mark_done_approval");
  });

  it("registers every boundary with its declared facets", () => {
    const byKey = Object.fromEntries(HARNESS_BOUNDARIES.map((b) => [b.key, b.facets]));
    expect(byKey).toEqual({
      tool_gate: ["risk"],
      step_complete: ["evidence", "stateDeps", "telemetry"],
      step_launch: ["stateDeps"],
      mark_done: ["telemetry"],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/emit`
Expected: FAIL — `./emit.js` does not exist.

- [ ] **Step 3: Implement the emit factory**

Create `apps/daemon/src/harness-transitions/emit.ts`:

```ts
import type {
  EvidenceFacet, FacetKey, HarnessTransition, HarnessTransitionBoundary,
  RiskFacet, StateDepsFacet, TelemetryFacet,
} from "@orca/contracts";
import { recordHarnessTransition, type HarnessTransitionCtx } from "./usecases.js";

type FacetValues = {
  risk: RiskFacet;
  evidence: EvidenceFacet;
  stateDeps: StateDepsFacet;
  telemetry: TelemetryFacet;
};

type EmitInput<F extends FacetKey> = {
  goalId: string;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
} & { [K in F]?: FacetValues[K] | null };

export const HARNESS_BOUNDARIES: { key: HarnessTransitionBoundary; facets: readonly FacetKey[] }[] = [];

function defineBoundary<F extends readonly FacetKey[]>(
  key: HarnessTransitionBoundary,
  facets: F
): (ctx: HarnessTransitionCtx, input: EmitInput<F[number]>) => HarnessTransition {
  HARNESS_BOUNDARIES.push({ key, facets });
  return (ctx, input) => recordHarnessTransition(ctx, { ...input, boundary: key });
}

// The only sanctioned write path. Each emitter type-accepts only its declared
// facets; validate-on-write lives in recordHarnessTransition (the choke point).
export const emitToolGate = defineBoundary("tool_gate", ["risk"] as const);
export const emitStepComplete = defineBoundary("step_complete", ["evidence", "stateDeps", "telemetry"] as const);
export const emitStepLaunch = defineBoundary("step_launch", ["stateDeps"] as const);
export const emitMarkDone = defineBoundary("mark_done", ["telemetry"] as const);
```

- [ ] **Step 4: Run the emit test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/emit`
Expected: PASS (all three cases).

- [ ] **Step 5: Add the boundary conformance guard + test**

Append to `apps/daemon/src/harness-transitions/conformance.ts` — add an import and a function, and call it from the aggregator:

```ts
import { HarnessTransitionBoundary } from "@orca/contracts";
import { HARNESS_BOUNDARIES } from "./emit.js";
```

```ts
/** registry boundary keys === the HarnessTransitionBoundary enum (no dormant gaps). */
export function assertBoundaryConformance(): void {
  const enumValues = [...HarnessTransitionBoundary.options].sort();
  const registered = HARNESS_BOUNDARIES.map((b) => b.key).slice().sort();
  if (JSON.stringify(enumValues) !== JSON.stringify(registered)) {
    throw new Error(`Harness boundary drift: registry [${registered}] != enum [${enumValues}]`);
  }
}
```

Update the aggregator body to also call it:

```ts
export function assertHarnessRegistryConformance(db: Database.Database): void {
  assertFacetConformance(db);
  assertBoundaryConformance();
}
```

Append a case to `apps/daemon/src/harness-transitions/conformance.test.ts`:

```ts
import { assertBoundaryConformance } from "./conformance.js";

describe("assertBoundaryConformance", () => {
  it("passes — every boundary enum value has a registered emitter", () => {
    expect(() => assertBoundaryConformance()).not.toThrow();
  });
});
```

- [ ] **Step 6: Run the conformance test to verify the new case passes**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/conformance`
Expected: PASS.

- [ ] **Step 7: Replace the `permission-gate.ts` emit site**

In `apps/daemon/src/permission-gate.ts`, change the import (line 5) from `recordHarnessTransition` to the emitter:

```ts
import { emitToolGate } from "./harness-transitions/emit.js";
```

Replace the `recordHarnessTransition(...)` call (lines 34–48) with:

```ts
    emitToolGate(
      { db: ctx.db, bus: ctx.bus, now: ctx.now, idFactory: ctx.idFactory },
      {
        goalId: sessionRow.goal_id,
        risk: {
          risk_class: classification.riskClass,
          permission_tier: classification.permissionTier,
          classification_reasons: classification.reasons,
          gate_decision: gateDecision,
          hard_constraint_violations: classification.hardConstraintViolations,
          mode,
        },
      }
    );
```

- [ ] **Step 8: Replace the three `service.ts` `step_complete` sites and the `step_launch` site**

In `apps/daemon/src/workflows/orchestrator/service.ts`:

(a) Update the import of `recordHarnessTransition` to import the emitters instead. Find the existing import line for `recordHarnessTransition` (from `../../harness-transitions/usecases.js`) and replace it with:

```ts
import { emitStepComplete, emitStepLaunch } from "../../harness-transitions/emit.js";
```

(b) Site at line ~1767 — replace `recordHarnessTransition(` with `emitStepComplete(` and **delete the `boundary: "step_complete",` line** inside the input object. The ctx + facet args are otherwise identical:

```ts
          emitStepComplete(
            { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
            {
              goalId: ctx.run.goalId,
              workflowRunId: ctx.run.id,
              workflowStepRunId: ctx.stepRun.id,
              evidence: evidence ?? undefined,
              stateDeps: options.stateDepsByStepRunId?.[ctx.stepRun.id] ?? undefined,
              telemetry: buildTelemetry(
                this.otlpAccumulator,
                sessionId,
                evidenceStatus,
                vetoed ? "evidence_veto" : null,
                null,
                recommendationFeedbackInterventions(db, ctx.run.goalId)
              ),
            }
          );
```

(c) Site at line ~1846 (inside the `if (stateFacet && !execReq)` try/catch) — replace with `emitStepComplete` and drop the boundary line:

```ts
              emitStepComplete(
                { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
                {
                  goalId: ctx.run.goalId,
                  workflowRunId: ctx.run.id,
                  workflowStepRunId: ctx.stepRun.id,
                  stateDeps: stateFacet,
                }
              );
```

(d) Site at line ~2498 — replace with `emitStepComplete` and drop the boundary line:

```ts
        emitStepComplete(
          { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
          {
            goalId: run.goalId,
            workflowRunId: run.id,
            workflowStepRunId: stepRun.id,
            stateDeps: options.stateDepsByStepRunId?.[stepRun.id] ?? undefined,
            telemetry: buildTelemetry(
              this.otlpAccumulator,
              sessionRow?.id,
              "succeeded",
              null,
              null,
              recommendationFeedbackInterventions(db, run.goalId)
            ),
          }
        );
```

(e) Site at line ~3352 (inside `recordStepLaunchTransition`) — replace with `emitStepLaunch` and drop the boundary line:

```ts
      emitStepLaunch(
        { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
        {
          goalId: goal.id,
          workflowRunId: run.id,
          workflowStepRunId: stepRun.id,
          stateDeps: {
            read_set,
            write_set: [],
            assumptions: [],
            version_deps,
            conflict_policy: "escalate",
            conflicts: [],
          },
        }
      );
```

- [ ] **Step 9: Typecheck to confirm the emitters' types accept the existing call shapes**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0. (If a facet field is rejected, the emitter's declared facet list is wrong — re-check against Step 3.)

- [ ] **Step 10: Run the affected suites to confirm behavior is preserved**

Run: `pnpm --filter @orca/daemon test -- harness-transitions permission-gate`
Expected: PASS.

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS (the orchestrator suite is the behavior-preservation guard for the emit-site swap).

- [ ] **Step 11: Commit**

```bash
git add apps/daemon/src/harness-transitions/emit.ts apps/daemon/src/harness-transitions/emit.test.ts \
  apps/daemon/src/harness-transitions/conformance.ts apps/daemon/src/harness-transitions/conformance.test.ts \
  apps/daemon/src/permission-gate.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(harness): defineBoundary typed emit factory replaces string-literal transition sites"
```

---

### Task 3: Fire `mark_done` on human-accepted completion

**Files:**
- Modify: `apps/daemon/src/recommendations/usecases.ts` (`recordTerminalFeedback` — post-commit emit)
- Modify/Create test: `apps/daemon/src/recommendations/usecases.test.ts` (or a focused new test file) asserting a `mark_done` transition lands on accept-complete.

**Interfaces:**
- Consumes: `emitMarkDone` from `../harness-transitions/emit.js`; `listTransitionsByGoal` for the test assertion.

- [ ] **Step 1: Confirm the emit site and what's in scope**

Read `apps/daemon/src/recommendations/usecases.ts` around `recordTerminalFeedback` (≈478–540). Confirm: the `db.transaction(() => { ... })` block at ≈495 calls `applyWorkflowAcceptSideEffectsInTx` (which, for `complete_workflow_run`, flips the run to `completed`). `ctx` exposes `db`, `bus`, optional `now`, `idFactory`. `rec.goalId` and `rec.proposedAction` are in scope. The transaction's `toPublish` is published right after the block.

- [ ] **Step 2: Write the failing test — accepting a complete_workflow_run recommendation records a mark_done transition**

This mirrors the existing test `'accepting complete_workflow_run completes the final step and run'` (`apps/daemon/src/recommendations/usecases.test.ts:305`) exactly, then adds the `mark_done` assertions. Add `listTransitionsByGoal` to the imports and (inside the `describe('acceptRecommendation', ...)` block) this case. The helpers `freshDb`, `seedGoal`, `seedWorkflow`, `seedRec`, `acceptRecommendation`, `makeCtx` are all already defined in this file.

Add to the import block near the other daemon imports (it lives in a sibling dir):

```ts
import { listTransitionsByGoal } from '../harness-transitions/usecases.js';
```

Add the test case:

```ts
  it('fires a mark_done harness transition carrying telemetry on accept', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkflow(db, 'g1', { finalStep: true, outstanding: [] });
    seedRec(db, {
      goalId: 'g1',
      type: 'complete_workflow_run',
      workflowStepRunId: 'step-1',
      proposedActionJson: JSON.stringify({
        kind: 'complete_workflow_run',
        workflowRunId: 'run-1',
        workflowStepRunId: 'step-1',
      }),
    });

    acceptRecommendation(makeCtx(db), 'rec-1');

    const markDone = listTransitionsByGoal(db, 'g1').find((t) => t.boundary === 'mark_done');
    expect(markDone).toBeDefined();
    expect(markDone!.workflowRunId).toBe('run-1');
    expect(markDone!.telemetry?.outcome.status).toBe('succeeded');
    expect(markDone!.telemetry?.human_interventions).toEqual([
      { kind: 'mark_done_approval', ref: 'rec-1' },
    ]);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- recommendations/usecases`
Expected: FAIL — no `mark_done` transition is recorded.

- [ ] **Step 4: Emit `mark_done` after the transaction commits**

In `apps/daemon/src/recommendations/usecases.ts`, add the import:

```ts
import { emitMarkDone } from "../harness-transitions/emit.js";
import type { TelemetryFacet } from "@orca/contracts";
```

In `recordTerminalFeedback`, **after** the `db.transaction(() => { ... })()` block has executed and events are published (i.e. outside the transaction, where `recordHarnessTransition`'s own transaction is safe), add a guarded emit:

```ts
  // Human-authoritative completion crossed the harness ledger's terminal boundary.
  // Emitted post-commit because recordHarnessTransition opens its own transaction
  // and better-sqlite3 forbids nesting. Swallow-and-log: a transition failure must
  // never break completion. Deferred enrichments (cumulative write-set, Goal-total
  // cost roll-up) are tracked in FUTURE_WORK.md 2.7.
  if (action === "accept" && rec.proposedAction.kind === "complete_workflow_run") {
    try {
      const telemetry: TelemetryFacet = {
        cost: null, latency_ms: null, model: null,
        provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null,
        rejected_alternatives: [],
        human_interventions: [{ kind: "mark_done_approval", ref: rec.id }],
        outcome: { status: "succeeded", failure_code: null },
      };
      emitMarkDone(
        { db, bus, now: () => now, idFactory: idFn },
        { goalId: rec.goalId, workflowRunId: rec.proposedAction.workflowRunId, telemetry }
      );
    } catch (err) {
      console.error("emitMarkDone failed", err);
    }
  }
```

> Implementer note: place this **immediately after** the publish loop `for (const ev of toPublish) bus.publish(ev);` (`recommendations/usecases.ts:544`) and **before** the `return { recommendation: ..., feedback: ..., alreadyDone: false };` (line 545). `db`, `bus`, `now` (string), `idFn`, `action`, and `rec` are all in scope (destructured/computed at the top of `recordTerminalFeedback`, ≈486–488). The `if` guard narrows `rec.proposedAction` to the `complete_workflow_run` variant, so `.workflowRunId` is typed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- recommendations/usecases`
Expected: PASS.

- [ ] **Step 6: Run the full recommendations + orchestrator suites to confirm no regression**

Run: `pnpm --filter @orca/daemon test -- recommendations orchestrator`
Expected: PASS. Run `pnpm --filter @orca/daemon typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/recommendations/usecases.ts apps/daemon/src/recommendations/usecases.test.ts
git commit -m "feat(harness): fire mark_done terminal transition on human-accepted completion"
```

---

### Task 4: `defineSensor` registry + detect/runner rewrite + sensor conformance

**Files:**
- Modify: `apps/daemon/src/harness-sensors/detect.ts` (registry replaces `LABEL_TO_SCRIPT`)
- Modify: `apps/daemon/src/harness-sensors/runner.ts` (consume `HARNESS_SENSORS`)
- Create: `apps/daemon/src/harness-sensors/conformance.ts`
- Create: `apps/daemon/src/harness-sensors/conformance.test.ts`
- Modify: `apps/daemon/src/harness-transitions/conformance.ts` (aggregator calls sensor conformance)

**Interfaces:**
- Produces: `HARNESS_SENSORS: readonly SensorSpec[]` where `SensorSpec = { kind: WorkflowSensorKind; label: string; script: string }`, and `UNIMPLEMENTED_SENSOR_KINDS: readonly WorkflowSensorKind[]`, from `./detect.js`.
- Produces: `assertSensorConformance(): void` from `harness-sensors/conformance.ts`.

- [ ] **Step 1: Write the failing sensor conformance test**

Create `apps/daemon/src/harness-sensors/conformance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkflowSensorKind } from "@orca/contracts";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "./detect.js";
import { assertSensorConformance } from "./conformance.js";

describe("sensor registry conformance", () => {
  it("covers every WorkflowSensorKind as registered-or-unimplemented", () => {
    const covered = new Set<string>([
      ...HARNESS_SENSORS.map((s) => s.kind),
      ...UNIMPLEMENTED_SENSOR_KINDS,
    ]);
    for (const kind of WorkflowSensorKind.options) expect(covered.has(kind)).toBe(true);
    expect(() => assertSensorConformance()).not.toThrow();
  });

  it("declares integration and static as explicitly unimplemented", () => {
    expect([...UNIMPLEMENTED_SENSOR_KINDS].sort()).toEqual(["integration", "static"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-sensors/conformance`
Expected: FAIL — `HARNESS_SENSORS`/`UNIMPLEMENTED_SENSOR_KINDS`/`./conformance.js` don't exist.

- [ ] **Step 3: Convert `detect.ts` to the registry**

In `apps/daemon/src/harness-sensors/detect.ts`, replace the `LABEL_TO_SCRIPT` block (lines 12–19) with:

```ts
// Maps a guardrail `required` label to (sensor kind, package.json script name).
// Registry is the single source; runner.ts consumes it too. Ordered cheapest-first
// so the runner can fail fast.
export type SensorSpec = { kind: WorkflowSensorKind; label: string; script: string };

const SENSOR_REGISTRY: SensorSpec[] = [];
function defineSensor(spec: SensorSpec): SensorSpec {
  SENSOR_REGISTRY.push(spec);
  return spec;
}

defineSensor({ kind: "typecheck", label: "typecheck", script: "typecheck" });
defineSensor({ kind: "lint", label: "lint", script: "lint" });
defineSensor({ kind: "unit", label: "unit_tests", script: "test" });
defineSensor({ kind: "build", label: "build", script: "build" });

export const HARNESS_SENSORS: readonly SensorSpec[] = SENSOR_REGISTRY;

// Declared-but-unimplemented kinds. Listing them here (rather than silently
// omitting) is what the conformance guard checks — adding a new WorkflowSensorKind
// forces a register-or-defer decision instead of silent drift.
export const UNIMPLEMENTED_SENSOR_KINDS: readonly WorkflowSensorKind[] = ["integration", "static"];
```

Update `detectSensors` (lines 31–40) to loop over `HARNESS_SENSORS`:

```ts
export function detectSensors(workspacePath: string, required: string[]): DetectedSensor[] {
  const scripts = readScripts(workspacePath);
  const out: DetectedSensor[] = [];
  for (const entry of HARNESS_SENSORS) {
    if (!required.includes(entry.label)) continue;
    if (typeof scripts[entry.script] !== "string") continue;
    out.push({ kind: entry.kind, command: "npm", args: ["run", entry.script] });
  }
  return out;
}
```

- [ ] **Step 4: Update `runner.ts` to consume the registry**

In `apps/daemon/src/harness-sensors/runner.ts`, change the import (line 5):

```ts
import { detectSensors, HARNESS_SENSORS } from "./detect.js";
```

And the gap-loop (lines 52–56):

```ts
  const gaps: string[] = [];
  for (const entry of HARNESS_SENSORS) {
    if (!opts.required.includes(entry.label)) continue;
    if (!detectedLabels.has(entry.kind)) gaps.push(`${entry.label}: no matching script`);
  }
```

- [ ] **Step 5: Implement the sensor conformance guard**

Create `apps/daemon/src/harness-sensors/conformance.ts`:

```ts
import { WorkflowSensorKind } from "@orca/contracts";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "./detect.js";

/**
 * Every WorkflowSensorKind must be either registered (has a detector/script) or
 * explicitly declared unimplemented — and never both. Closes the integration/static
 * declared-but-dead drift; forces a decision when a kind is added.
 */
export function assertSensorConformance(): void {
  const registered = new Set(HARNESS_SENSORS.map((s) => s.kind));
  const unimplemented = new Set(UNIMPLEMENTED_SENSOR_KINDS);
  for (const kind of WorkflowSensorKind.options) {
    if (!registered.has(kind) && !unimplemented.has(kind)) {
      throw new Error(`Sensor drift: kind '${kind}' is neither registered nor declared unimplemented`);
    }
  }
  for (const kind of UNIMPLEMENTED_SENSOR_KINDS) {
    if (registered.has(kind)) {
      throw new Error(`Sensor drift: kind '${kind}' is both registered and declared unimplemented`);
    }
  }
}
```

- [ ] **Step 6: Run the sensor conformance + existing detect/runner suites**

Run: `pnpm --filter @orca/daemon test -- harness-sensors`
Expected: PASS (new conformance cases + existing `detect.test.ts` / `runner.test.ts` unchanged-behavior).

- [ ] **Step 7: Wire sensor conformance into the startup aggregator**

In `apps/daemon/src/harness-transitions/conformance.ts`, add the import and extend the aggregator:

```ts
import { assertSensorConformance } from "../harness-sensors/conformance.js";
```

```ts
export function assertHarnessRegistryConformance(db: Database.Database): void {
  assertFacetConformance(db);
  assertBoundaryConformance();
  assertSensorConformance();
}
```

- [ ] **Step 8: Typecheck + run conformance once more**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test -- conformance` → PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/harness-sensors/detect.ts apps/daemon/src/harness-sensors/runner.ts \
  apps/daemon/src/harness-sensors/conformance.ts apps/daemon/src/harness-sensors/conformance.test.ts \
  apps/daemon/src/harness-transitions/conformance.ts
git commit -m "feat(harness): defineSensor registry + sensor conformance closes integration/static drift"
```

---

### Task 5: `GET /v1/harness/registry` introspection route

**Files:**
- Modify: `apps/daemon/src/harness-transitions/routes.ts` (add the route)
- Create: `apps/daemon/src/harness-transitions/routes.test.ts` (or extend an existing route test) — assert the route returns the three registries.

**Interfaces:**
- Consumes: `HARNESS_FACETS` (`@orca/contracts`), `HARNESS_BOUNDARIES` (`./emit.js`), `HARNESS_SENSORS` + `UNIMPLEMENTED_SENSOR_KINDS` (`../harness-sensors/detect.js`).

- [ ] **Step 1: Write the failing route test**

Create `apps/daemon/src/harness-transitions/routes.test.ts` (follow the existing daemon HTTP test pattern — build a Fastify instance, register the routes, `inject`):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerHarnessTransitionRoutes } from "./routes.js";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
let db: Database.Database; let server: FastifyInstance;
beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-routes-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  server = Fastify(); registerHarnessTransitionRoutes(server, { db }); await server.ready();
});
afterEach(async () => { await server.close(); closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("GET /v1/harness/registry", () => {
  it("returns facets, boundaries, and sensors", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/harness/registry" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facets.map((f: { key: string }) => f.key).sort()).toEqual(["evidence", "risk", "stateDeps", "telemetry"]);
    expect(body.boundaries.map((b: { key: string }) => b.key).sort()).toEqual(["mark_done", "step_complete", "step_launch", "tool_gate"]);
    const sensorByKind = Object.fromEntries(body.sensors.map((s: { kind: string; status: string }) => [s.kind, s.status]));
    expect(sensorByKind.typecheck).toBe("implemented");
    expect(sensorByKind.integration).toBe("unimplemented");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/routes`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add the route**

In `apps/daemon/src/harness-transitions/routes.ts`, add imports at the top:

```ts
import { HARNESS_FACETS } from "@orca/contracts";
import { HARNESS_BOUNDARIES } from "./emit.js";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "../harness-sensors/detect.js";
```

Inside `registerHarnessTransitionRoutes`, after the existing `server.get("/v1/goals/:goalId/harness-transitions", ...)` registration, add:

```ts
  server.get("/v1/harness/registry", async () => {
    return {
      facets: HARNESS_FACETS.map((f) => ({ key: f.key, column: f.column })),
      boundaries: HARNESS_BOUNDARIES.map((b) => ({ key: b.key, facets: b.facets })),
      sensors: [
        ...HARNESS_SENSORS.map((s) => ({ kind: s.kind, label: s.label, script: s.script, status: "implemented" as const })),
        ...UNIMPLEMENTED_SENSOR_KINDS.map((kind) => ({ kind, label: null, script: null, status: "unimplemented" as const })),
      ],
    };
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-transitions/routes`
Expected: PASS.

- [ ] **Step 5: Full typecheck + daemon test sweep**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test` → PASS (full daemon suite; note the two acknowledged flakes `http-surface.test.ts` / `human-review.test.ts` may need an isolated re-run).
Run: `pnpm --filter @orca/contracts test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/harness-transitions/routes.ts apps/daemon/src/harness-transitions/routes.test.ts
git commit -m "feat(harness): GET /v1/harness/registry exposes the runtime-enumerable substrate"
```

---

## Notes for the executor

- **Build order matters.** Task 1 changes `@orca/contracts`; you MUST `pnpm --filter @orca/contracts build` (Task 1 Step 5) before any daemon typecheck/test sees `HARNESS_FACETS`/`FacetKey`. The same applies if you touch contracts again.
- **Behavior preservation** rests on the existing `orchestrator`, `recommendations`, `harness-transitions`, and `harness-sensors` suites — run them at each task boundary, not just at the end.
- **Validate-on-write** (Task 1 Step 7) now throws on invalid facets. All existing call sites pass valid facets, so existing tests stay green; if one goes red, it has surfaced a real producer bug — investigate, don't loosen the parse.
- **Line numbers drift** as you edit. The anchors here are from the 2026-06-24 tree; match on the quoted code, not the line number, if they've moved.
```
