# Workflow Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the delegate seam: a 4th graph node type (`delegate`) that spawns a child `WorkflowRun` of an independently-versioned template on the same goal, with an isolated state space (explicit `reads`/`writes`), a delegation stack (parent parks in a new `delegating` status), and full four-axis integration (verdict-gated join, belief-divergence + conflict policy, budget spanning the composition, auditable launch decision, `delegate_spawn`/`delegate_join` harness transitions).

**Architecture:** Composition is control-plane `DispatchEngine` logic. A delegate node, on entry, resolves `reads`, snapshots workspace version, creates a child run (reusing `startWorkflowRun`), seeds the child's namespace with an entry artifact (the resolved reads), and parks the parent in `delegating`. The child runs through the entire existing engine. On the child's terminal step, a join (detected via `parent_composition_id`) verdict-gates on the child's terminal evidence, maps `writes` back as the delegate node's `step_output`, runs belief-divergence + optional re-verify, rolls up cost, and resumes the parent. Isolation is automatic because context assembly is per-run; the only new state seed is the entry artifact.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Fastify, better-sqlite3, Vitest, React + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-01-workflow-composition-design.md` (approved). Read it before starting — especially §3 (contract), §4 (lifecycle), and the four-axis integration (I1–I8, A1/A2/B/C/D).

## Global Constraints

- **Control-plane only.** Spawn/join is `DispatchEngine` logic. The workspace snapshot rides the existing `probeWorkspaceForSession`/`VersionProbe` resolver (execution-plane-movable behind `RunnerPort`). No `sessions/ pty/ tmux/ adapters/` changes.
- **Isolation invariant.** A child run's steps see only the mapped `reads` (seeded as one entry `step_output` artifact) — never the parent blackboard. Context assembly (`buildStepExecutionInput`) already scopes by `stepRunId`; do not broaden it.
- **Verdict-gated join (A1).** A child terminal step with a non-`passed` `EvidenceFacet.verdict` is a child failure (propagate/block), NOT a clean join.
- **Additive only.** New node type, template `inputs`, `delegating` status, `parent_composition_id` column, `CompositionFacet`, two boundaries — all additive; no existing contract response reshaped, no existing status removed. The existing `idx_workflow_runs_active_per_goal` partial index is **unchanged** (`delegating` is outside its predicate).
- **Deterministic core.** The engine routes/persists/gates; no new LLM call is introduced by composition (the child's own steps use the LLM as they already do).
- Constants (set here): `MAX_DELEGATION_DEPTH = 5`.
- Test runners: `cd packages/contracts && pnpm vitest run <path>`; `cd apps/daemon && pnpm vitest run <path>`; `cd apps/desktop && pnpm vitest run <path>`.
- Commit after every task. Branch is `phase5e-composition` (already created off `main`; the spec is on it). Do not commit to `main`.

---

## File structure

**Contracts (modified):**
- `packages/contracts/src/workflows/index.ts` — `delegate` node type + delegate node fields; `WorkflowTemplate.inputs`; `WorkflowRunStatus` gains `delegating`; `WorkflowRun.parentCompositionId`; `WorkflowRunComposition` schema.
- `packages/contracts/src/harness/index.ts` — `CompositionFacet` + `defineFacet` registration; boundary key union gains `delegate_spawn`/`delegate_join`.

**Daemon (new module `apps/daemon/src/workflows/composition/`):**
- `store.ts` — composition-row CRUD + lineage queries.
- `reads-writes.ts` — pure `resolveReads` / `mapWrites` helpers.
- `spawn.ts` — `spawnChildRun` (control-plane spawn).
- `join.ts` — `joinChildRun` (verdict-gate, writes-back, divergence, re-verify, cost, resume).
- `depth.ts` — `delegationDepth`, `MAX_DELEGATION_DEPTH`, cycle/DAG check helpers.

**Daemon (modified):**
- `apps/daemon/migrations/0050_workflow_compositions.sql` — new.
- `apps/daemon/src/harness-transitions/emit.ts` — `emitDelegateSpawn`/`emitDelegateJoin`.
- `apps/daemon/src/workflows/graph/validate-graph.ts` — delegate-node + cross-template validation.
- `apps/daemon/src/workflows/steps/usecases.ts` — terminal branch: child → join instead of goal-yield.
- `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` — delegate-node entry → spawn; wire join resume.
- `apps/daemon/src/harness-state/cost-rollup.ts` — include descendant child-run costs.
- `apps/daemon/src/workflows/guardrails/*` (budget scope) — parent budget spans the composition.
- `apps/daemon/src/workflows/templates/catalog.ts` — one composed built-in pair.

**Desktop (modified):** `apps/desktop/src/api.ts`; `apps/desktop/src/goal-detail/workflow/*` (delegate node visual + delegation breadcrumb + nested run view).

**Docs (modified):** `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`.

---

### Task 1: Contracts — delegate node, template `inputs`, `delegating` status, composition schema

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/workflows/composition.test.ts` (new)

**Interfaces:**
- Produces: `WorkflowGraphNode` with `type` including `"delegate"` + fields `childTemplateId`/`childTemplateVersion`/`reads`/`writes`/`validationRequired`/`requiresLaunchApproval`; `WorkflowTemplate.inputs`; `WorkflowRunStatus` incl. `"delegating"`; `WorkflowRun.parentCompositionId`; `WorkflowRunComposition`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/workflows/composition.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { WorkflowGraphNode, WorkflowRunStatus, WorkflowRunComposition } from "./index.js";

describe("composition contracts", () => {
  it("parses a delegate node with reads/writes", () => {
    const node = WorkflowGraphNode.parse({
      id: "d1", type: "delegate", name: "Review",
      childTemplateId: "orca/code-review", childTemplateVersion: 3,
      reads: { diff_ref: "change_ref" }, writes: { review_findings: "findings" },
      validationRequired: false, requiresLaunchApproval: false,
    });
    expect(node.type).toBe("delegate");
    expect(node.childTemplateId).toBe("orca/code-review");
  });

  it("accepts the delegating run status", () => {
    expect(WorkflowRunStatus.safeParse("delegating").success).toBe(true);
  });

  it("round-trips a WorkflowRunComposition", () => {
    const c = {
      id: "c1", goalId: "g", parentRunId: "r1", childRunId: "r2", delegateNodeId: "d1",
      spawnSeq: 0, reads: { diff_ref: "change_ref" }, writes: { review_findings: "findings" },
      depth: 1, status: "active" as const, costRollupUsd: null,
      createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null,
    };
    expect(WorkflowRunComposition.parse(c)).toMatchObject({ id: "c1", status: "active" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/workflows/composition.test.ts`
Expected: FAIL — `delegate` not in the node enum / `WorkflowRunComposition` not exported.

- [ ] **Step 3: Extend the contracts**

In `packages/contracts/src/workflows/index.ts`:

(a) In `WorkflowGraphNode` (the `.object({...})` at ~line 300), change `type: z.enum(["step", "gate", "splitter"])` to include `"delegate"`, and add the delegate fields (all optional; a refinement below requires them when `type === "delegate"`):

```typescript
    type: z.enum(["step", "gate", "splitter", "delegate"]),
    // ... existing fields ...
    // Delegate nodes: spawn a child WorkflowRun of another template.
    childTemplateId: Id100.optional(),
    childTemplateVersion: z.number().int().nonnegative().optional(),
    reads: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).optional(),   // { childInputKey: parentKeyName }
    writes: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).optional(),  // { parentOutputKey: childOutputKey }
    validationRequired: z.boolean().optional(),
    requiresLaunchApproval: z.boolean().optional(),
```

Add a `.superRefine` after the node object (or extend an existing refinement) so a `delegate` node requires `childTemplateId` + `childTemplateVersion`:

```typescript
// after the WorkflowGraphNode object definition, wrap with a refinement:
export const WorkflowGraphNode = WorkflowGraphNodeBase.superRefine((n, ctx) => {
  if (n.type === "delegate" && (!n.childTemplateId || n.childTemplateVersion === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegate node requires childTemplateId + childTemplateVersion" });
  }
});
```
(Rename the current `.strict()` object to `WorkflowGraphNodeBase` and export the refined `WorkflowGraphNode`; keep the inferred type name `WorkflowGraphNode`.)

(b) `WorkflowTemplate` (~line 353): add after `steps`:

```typescript
    inputs: WorkflowStepOutputSchema.optional().default([]),   // typed entry inputs (I5)
```
(`WorkflowStepOutputSchema` is already imported/used in this file for step `outputSchema`.)

(c) `WorkflowRunStatus`: add `"delegating"` to the enum.

(d) `WorkflowRun` (~line 398): add `parentCompositionId: z.string().nullable().default(null)`.

(e) Add the composition schema at the end of the file:

```typescript
export const WorkflowRunComposition = z.object({
  id: z.string(),
  goalId: z.string(),
  parentRunId: z.string(),
  childRunId: z.string(),
  delegateNodeId: z.string(),
  spawnSeq: z.number().int().nonnegative(),
  reads: z.record(z.string(), z.string()),
  writes: z.record(z.string(), z.string()),
  depth: z.number().int().nonnegative(),
  status: z.enum(["active", "completed", "failed", "cancelled"]),
  costRollupUsd: z.number().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
}).strict();
export type WorkflowRunComposition = z.infer<typeof WorkflowRunComposition>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contracts && pnpm vitest run src/workflows/composition.test.ts` — Expected: PASS.
Also run the full workflows contract suite to confirm no regression: `cd packages/contracts && pnpm vitest run src/workflows`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/composition.test.ts
git commit -m "feat(contracts): delegate node, template inputs, delegating status, composition schema"
```

---

### Task 2: Contracts — `CompositionFacet` + `delegate_spawn`/`delegate_join` boundaries

**Files:**
- Modify: `packages/contracts/src/harness/index.ts`
- Test: `packages/contracts/src/harness/composition-facet.test.ts` (new)

**Interfaces:**
- Consumes: the `FacetSpec`/`defineFacet` registry (`harness/index.ts:186-208`).
- Produces: `CompositionFacet` schema; `HARNESS_FACETS` includes `{ key: "composition", column: "composition_json" }`; `HarnessTransitionBoundary` union includes `delegate_spawn`/`delegate_join`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/harness/composition-facet.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CompositionFacet, HARNESS_FACETS, HarnessTransitionBoundary } from "./index.js";

describe("composition facet", () => {
  it("parses a join composition facet with verdict + scope", () => {
    const f = CompositionFacet.parse({
      childRunId: "r2", childTemplateId: "orca/code-review", childTemplateVersion: 3,
      readsKeys: ["diff_ref"], writesKeys: ["review_findings"], depth: 1, costRollupUsd: 0.12,
      childVerdict: "passed", childUntestedRegions: [], childResidualRisk: [],
      beliefDivergence: { diverged: false }, verifyResult: { ran: false, vetoed: false },
    });
    expect(f.childVerdict).toBe("passed");
  });

  it("registers the composition facet + delegate boundaries", () => {
    expect(HARNESS_FACETS.some((x) => x.key === "composition")).toBe(true);
    expect(HarnessTransitionBoundary.safeParse("delegate_spawn").success).toBe(true);
    expect(HarnessTransitionBoundary.safeParse("delegate_join").success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && pnpm vitest run src/harness/composition-facet.test.ts` — Expected: FAIL.

- [ ] **Step 3: Add the facet + boundary**

In `packages/contracts/src/harness/index.ts`:

(a) Widen the `FacetSpec.key` union and the `HarnessTransitionBoundary` enum:
```typescript
export type FacetSpec = { key: "risk" | "evidence" | "stateDeps" | "telemetry" | "composition"; column: string; schema: z.ZodTypeAny; };
// and where HarnessTransitionBoundary is defined:
export const HarnessTransitionBoundary = z.enum([
  "step_launch", "step_complete", "tool_gate", "mark_done", "delegate_spawn", "delegate_join",
]);
```
(Find the existing `HarnessTransitionBoundary` enum and add the two values — keep all existing values in order.)

(b) Define + register the facet (near the other `defineFacet(...)` calls):
```typescript
export const CompositionFacet = z.object({
  childRunId: z.string(),
  childTemplateId: z.string(),
  childTemplateVersion: z.number().int(),
  readsKeys: z.array(z.string()),
  writesKeys: z.array(z.string()),
  depth: z.number().int(),
  costRollupUsd: z.number().nullable(),
  childVerdict: z.enum(["passed", "failed", "partial"]).nullable().optional(),
  childUntestedRegions: z.array(z.string()).optional(),
  childResidualRisk: z.array(z.string()).optional(),
  beliefDivergence: z.object({ diverged: z.boolean(), details: z.string().optional() }).nullable().optional(),
  verifyResult: z.object({ ran: z.boolean(), vetoed: z.boolean(), reason: z.string().optional() }).nullable().optional(),
}).strict();
export type CompositionFacet = z.infer<typeof CompositionFacet>;

defineFacet({ key: "composition", column: "composition_json", schema: CompositionFacet });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/contracts && pnpm vitest run src/harness/composition-facet.test.ts` — Expected: PASS.
Run the harness contract suite for regressions: `cd packages/contracts && pnpm vitest run src/harness`.

Note: the `composition_json` column is added to `harness_transitions` in Task 3's migration.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/composition-facet.test.ts
git commit -m "feat(contracts): CompositionFacet + delegate_spawn/delegate_join boundaries"
```

---

### Task 3: Migration + composition store

**Files:**
- Create: `apps/daemon/migrations/0050_workflow_compositions.sql`, `apps/daemon/src/workflows/composition/store.ts`
- Test: `apps/daemon/src/workflows/composition/store.test.ts`

**Interfaces:**
- Produces:
  - `insertComposition(db, c: WorkflowRunComposition, workspaceSnapshotJson?: string | null): void`
  - `getCompositionById(db, id): WorkflowRunComposition | null`
  - `getCompositionByChildRun(db, childRunId): WorkflowRunComposition | null`
  - `listChildCompositions(db, parentRunId): WorkflowRunComposition[]`
  - `nextSpawnSeq(db, parentRunId, delegateNodeId): number`
  - `updateCompositionStatus(db, id, patch: { status; costRollupUsd?; finishedAt?; workspaceSnapshotJson? }): void`
  - `descendantRunIds(db, rootRunId): string[]` (root + all transitive child runs, for cost/cancel)

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0050_workflow_compositions.sql`:

```sql
CREATE TABLE workflow_run_compositions (
  id                              TEXT PRIMARY KEY,
  goal_id                         TEXT NOT NULL REFERENCES goals(id),
  parent_run_id                   TEXT NOT NULL REFERENCES workflow_runs(id),
  child_run_id                    TEXT NOT NULL REFERENCES workflow_runs(id),
  delegate_node_id                TEXT NOT NULL,
  spawn_seq                       INTEGER NOT NULL DEFAULT 0,
  reads_json                      TEXT NOT NULL,
  writes_json                     TEXT NOT NULL,
  parent_workspace_snapshot_json  TEXT,
  depth                           INTEGER NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled')),
  cost_rollup_usd                 REAL,
  created_at                      TEXT NOT NULL,
  finished_at                     TEXT
);
CREATE UNIQUE INDEX idx_compositions_parent_node_seq
  ON workflow_run_compositions (parent_run_id, delegate_node_id, spawn_seq);
CREATE INDEX idx_compositions_child ON workflow_run_compositions (child_run_id);
CREATE INDEX idx_compositions_parent ON workflow_run_compositions (parent_run_id);

ALTER TABLE workflow_runs ADD COLUMN parent_composition_id TEXT;

-- Widen the run status CHECK to include 'delegating'.
-- (SQLite can't ALTER a CHECK; the workflow_runs status CHECK is enforced in app code as well.
--  If migration 0010's CHECK is a table constraint, recreate is heavy — instead rely on the
--  contract enum + app writes. Confirm whether the DB CHECK rejects 'delegating': if it does,
--  this migration must rebuild workflow_runs. See Step 1b.)

-- Add the composition facet column to the harness transition spine.
ALTER TABLE harness_transitions ADD COLUMN composition_json TEXT;
```

- [ ] **Step 1b: Confirm the status CHECK**

Run: `grep -n "status" apps/daemon/migrations/0010_workflows.sql`. If `workflow_runs.status` has a `CHECK (status IN (...))` **table constraint** that omits `delegating`, SQLite requires a table rebuild to change it. In that case, add to `0050`: create `workflow_runs_new` with the widened CHECK (`...,'delegating'`), `INSERT INTO workflow_runs_new SELECT ...`, drop old, rename, and recreate the indexes (`idx_workflow_runs_active_per_goal` and `goals.active_workflow_run_id` FK). If the status is validated only in app code (no DB CHECK), no rebuild is needed — the contract enum in Task 1 suffices. **Do the grep first and choose the branch; record which in the report.**

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/workflows/composition/store.test.ts` (reuse the standard daemon test-DB boilerplate — mkdtemp + openDatabase + runMigrations; copy the `createConfig`/`openTestDb` helpers from `apps/daemon/src/learning/store.test.ts`). Seed a goal + two workflow_runs, then:

```typescript
import type { WorkflowRunComposition } from "@orca/contracts";
import { insertComposition, getCompositionByChildRun, listChildCompositions, nextSpawnSeq, updateCompositionStatus, descendantRunIds } from "./store.js";

function comp(over: Partial<WorkflowRunComposition> = {}): WorkflowRunComposition {
  return { id: "c1", goalId: "g", parentRunId: "r1", childRunId: "r2", delegateNodeId: "d1",
    spawnSeq: 0, reads: { a: "b" }, writes: { c: "d" }, depth: 1, status: "active",
    costRollupUsd: null, createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null, ...over };
}

describe("composition store", () => {
  it("inserts + reads by child, lists by parent, computes next spawn seq", () => {
    insertComposition(db, comp());
    expect(getCompositionByChildRun(db, "r2")?.id).toBe("c1");
    expect(listChildCompositions(db, "r1")).toHaveLength(1);
    expect(nextSpawnSeq(db, "r1", "d1")).toBe(1);
  });
  it("updates status + cost and computes descendant run ids", () => {
    insertComposition(db, comp());                                  // r1 -> r2
    insertComposition(db, comp({ id: "c2", parentRunId: "r2", childRunId: "r3", depth: 2 }));  // r2 -> r3
    updateCompositionStatus(db, "c1", { status: "completed", costRollupUsd: 0.5, finishedAt: "2026-07-01T01:00:00.000Z" });
    expect(getCompositionByChildRun(db, "r2")?.status).toBe("completed");
    expect(new Set(descendantRunIds(db, "r1"))).toEqual(new Set(["r1", "r2", "r3"]));
  });
});
```
(Seed `workflow_runs` rows `r1,r2,r3` in the test's `seed()` so the FKs hold.)

- [ ] **Step 3: Write the store**

Create `apps/daemon/src/workflows/composition/store.ts`:

```typescript
import type Database from "better-sqlite3";
import { WorkflowRunComposition } from "@orca/contracts";

interface Row {
  id: string; goal_id: string; parent_run_id: string; child_run_id: string; delegate_node_id: string;
  spawn_seq: number; reads_json: string; writes_json: string; parent_workspace_snapshot_json: string | null;
  depth: number; status: string; cost_rollup_usd: number | null; created_at: string; finished_at: string | null;
}

function rowTo(r: Row): WorkflowRunComposition {
  return WorkflowRunComposition.parse({
    id: r.id, goalId: r.goal_id, parentRunId: r.parent_run_id, childRunId: r.child_run_id,
    delegateNodeId: r.delegate_node_id, spawnSeq: r.spawn_seq, reads: JSON.parse(r.reads_json),
    writes: JSON.parse(r.writes_json), depth: r.depth, status: r.status,
    costRollupUsd: r.cost_rollup_usd, createdAt: r.created_at, finishedAt: r.finished_at,
  });
}

export function insertComposition(db: Database.Database, c: WorkflowRunComposition, workspaceSnapshotJson: string | null = null): void {
  db.prepare(
    `INSERT INTO workflow_run_compositions
      (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json,
       parent_workspace_snapshot_json, depth, status, cost_rollup_usd, created_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(c.id, c.goalId, c.parentRunId, c.childRunId, c.delegateNodeId, c.spawnSeq,
    JSON.stringify(c.reads), JSON.stringify(c.writes), workspaceSnapshotJson, c.depth, c.status,
    c.costRollupUsd, c.createdAt, c.finishedAt);
}

export function getCompositionById(db: Database.Database, id: string): WorkflowRunComposition | null {
  const r = db.prepare(`SELECT * FROM workflow_run_compositions WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowTo(r) : null;
}
export function getCompositionByChildRun(db: Database.Database, childRunId: string): WorkflowRunComposition | null {
  const r = db.prepare(`SELECT * FROM workflow_run_compositions WHERE child_run_id = ?`).get(childRunId) as Row | undefined;
  return r ? rowTo(r) : null;
}
export function listChildCompositions(db: Database.Database, parentRunId: string): WorkflowRunComposition[] {
  return (db.prepare(`SELECT * FROM workflow_run_compositions WHERE parent_run_id = ? ORDER BY created_at ASC`).all(parentRunId) as Row[]).map(rowTo);
}
export function nextSpawnSeq(db: Database.Database, parentRunId: string, delegateNodeId: string): number {
  const r = db.prepare(`SELECT COALESCE(MAX(spawn_seq), -1) AS m FROM workflow_run_compositions WHERE parent_run_id = ? AND delegate_node_id = ?`)
    .get(parentRunId, delegateNodeId) as { m: number };
  return r.m + 1;
}
export function readWorkspaceSnapshot(db: Database.Database, id: string): string | null {
  const r = db.prepare(`SELECT parent_workspace_snapshot_json FROM workflow_run_compositions WHERE id = ?`).get(id) as { parent_workspace_snapshot_json: string | null } | undefined;
  return r?.parent_workspace_snapshot_json ?? null;
}
export function updateCompositionStatus(
  db: Database.Database, id: string,
  patch: { status: WorkflowRunComposition["status"]; costRollupUsd?: number | null; finishedAt?: string | null },
): void {
  const cur = db.prepare(`SELECT status, cost_rollup_usd, finished_at FROM workflow_run_compositions WHERE id = ?`).get(id) as
    { status: string; cost_rollup_usd: number | null; finished_at: string | null } | undefined;
  if (!cur) return;
  db.prepare(`UPDATE workflow_run_compositions SET status = ?, cost_rollup_usd = ?, finished_at = ? WHERE id = ?`)
    .run(patch.status,
      patch.costRollupUsd !== undefined ? patch.costRollupUsd : cur.cost_rollup_usd,
      patch.finishedAt !== undefined ? patch.finishedAt : cur.finished_at, id);
}

// root + all transitive child runs (for cost roll-up + cancel cascade).
export function descendantRunIds(db: Database.Database, rootRunId: string): string[] {
  const out = new Set<string>([rootRunId]);
  const stack = [rootRunId];
  while (stack.length) {
    const parent = stack.pop()!;
    const kids = db.prepare(`SELECT child_run_id FROM workflow_run_compositions WHERE parent_run_id = ?`).all(parent) as { child_run_id: string }[];
    for (const k of kids) if (!out.has(k.child_run_id)) { out.add(k.child_run_id); stack.push(k.child_run_id); }
  }
  return [...out];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0050_workflow_compositions.sql apps/daemon/src/workflows/composition/store.ts apps/daemon/src/workflows/composition/store.test.ts
git commit -m "feat(daemon): composition migration 0050 + store (lineage, spawn_seq)"
```

---

### Task 4: `reads`/`writes` resolver + depth/DAG helpers

**Files:**
- Create: `apps/daemon/src/workflows/composition/reads-writes.ts`, `apps/daemon/src/workflows/composition/depth.ts`
- Test: `apps/daemon/src/workflows/composition/reads-writes.test.ts`, `apps/daemon/src/workflows/composition/depth.test.ts`

**Interfaces:**
- Produces:
  - `resolveReads(reads: Record<string,string>, parentOutputs: Record<string, unknown>): Record<string, unknown>` — child entry object.
  - `mapWrites(writes: Record<string,string>, childTerminalOutput: Record<string, unknown>): Record<string, unknown>` — parent artifact body.
  - `MAX_DELEGATION_DEPTH = 5`
  - `delegationDepth(db, parentRunId): number` — depth of a run in the delegation stack (0 for a root run).
  - `delegationTargets(template): { childTemplateId: string; version: number }[]` — a template's delegate node targets.

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/workflows/composition/reads-writes.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveReads, mapWrites } from "./reads-writes.js";

describe("reads/writes", () => {
  it("resolveReads maps parent output keys into child entry keys", () => {
    expect(resolveReads({ diff_ref: "change_ref" }, { change_ref: "abc", other: 1 }))
      .toEqual({ diff_ref: "abc" });
  });
  it("resolveReads yields undefined for a missing parent key", () => {
    expect(resolveReads({ diff_ref: "change_ref" }, {})).toEqual({ diff_ref: undefined });
  });
  it("mapWrites maps child terminal output keys into parent keys", () => {
    expect(mapWrites({ review_findings: "findings" }, { findings: ["x"], noise: 2 }))
      .toEqual({ review_findings: ["x"] });
  });
});
```

Create `apps/daemon/src/workflows/composition/depth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MAX_DELEGATION_DEPTH, delegationTargets } from "./depth.js";

describe("depth/targets", () => {
  it("MAX_DELEGATION_DEPTH is 5", () => { expect(MAX_DELEGATION_DEPTH).toBe(5); });
  it("delegationTargets extracts child template refs from delegate nodes", () => {
    const tpl = { graph: { nodes: [
      { id: "s1", type: "step" }, { id: "d1", type: "delegate", childTemplateId: "child", childTemplateVersion: 2 },
    ] } } as never;
    expect(delegationTargets(tpl)).toEqual([{ childTemplateId: "child", version: 2 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/reads-writes.test.ts src/workflows/composition/depth.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the modules**

Create `apps/daemon/src/workflows/composition/reads-writes.ts`:

```typescript
export function resolveReads(reads: Record<string, string>, parentOutputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [childKey, parentKey] of Object.entries(reads)) out[childKey] = parentOutputs[parentKey];
  return out;
}

export function mapWrites(writes: Record<string, string>, childTerminalOutput: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [parentKey, childKey] of Object.entries(writes)) out[parentKey] = childTerminalOutput[childKey];
  return out;
}
```

Create `apps/daemon/src/workflows/composition/depth.ts`:

```typescript
import type Database from "better-sqlite3";
import type { WorkflowTemplate } from "@orca/contracts";

export const MAX_DELEGATION_DEPTH = 5;

export function delegationTargets(template: Pick<WorkflowTemplate, "graph">): { childTemplateId: string; version: number }[] {
  const nodes = template.graph?.nodes ?? [];
  const out: { childTemplateId: string; version: number }[] = [];
  for (const n of nodes) {
    if (n.type === "delegate" && n.childTemplateId && n.childTemplateVersion !== undefined) {
      out.push({ childTemplateId: n.childTemplateId, version: n.childTemplateVersion });
    }
  }
  return out;
}

// Depth of parentRunId within the delegation stack (0 = a root run with no parent composition).
export function delegationDepth(db: Database.Database, parentRunId: string): number {
  let depth = 0;
  let runId: string | null = parentRunId;
  const seen = new Set<string>();
  while (runId && !seen.has(runId)) {
    seen.add(runId);
    const row = db.prepare(`SELECT parent_composition_id FROM workflow_runs WHERE id = ?`).get(runId) as { parent_composition_id: string | null } | undefined;
    const pcid = row?.parent_composition_id ?? null;
    if (!pcid) break;
    const comp = db.prepare(`SELECT parent_run_id FROM workflow_run_compositions WHERE id = ?`).get(pcid) as { parent_run_id: string } | undefined;
    if (!comp) break;
    depth += 1;
    runId = comp.parent_run_id;
  }
  return depth;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/reads-writes.test.ts src/workflows/composition/depth.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/composition/reads-writes.ts apps/daemon/src/workflows/composition/depth.ts apps/daemon/src/workflows/composition/reads-writes.test.ts apps/daemon/src/workflows/composition/depth.test.ts
git commit -m "feat(daemon): composition reads/writes resolver + depth/target helpers"
```

---

### Task 5: Graph validation — delegate node + cross-template DAG

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts`
- Test: `apps/daemon/src/workflows/graph/validate-graph.composition.test.ts` (new)

**Interfaces:**
- Consumes: existing `validateGraph(...)` (`validate-graph.ts:9`) + a template resolver `getTemplateById(db, id)`; `delegationTargets` (Task 4).
- Produces: `validateGraph` accepts an optional `resolveChild(templateId): WorkflowTemplate | null` and enforces delegate-node + cross-template rules; a new exported `validateDelegationAcyclic(db, template): string[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/graph/validate-graph.composition.test.ts`. Build a parent template with a delegate node targeting a child template stub, and assert:
- valid when `reads` keys ⊆ child `inputs`, `writes` child-keys ⊆ child terminal `outputSchema`, one outgoing edge;
- violation when `reads` references a child input the child doesn't declare;
- violation when `writes` references a child output the terminal step doesn't produce;
- violation when the delegate node has ≠1 outgoing edge;
- `validateDelegationAcyclic` returns a violation when template A delegates B and B delegates A.

```typescript
import { describe, expect, it } from "vitest";
import { validateGraph } from "./validate-graph.js";
// Construct parent + child template fixtures inline; pass resolveChild returning the child by id.
// (Model the fixtures on WorkflowTemplate shape: steps[], graph{nodes,edges,positions}, inputs[].)
// Assert validateGraph(parent, { resolveChild }) returns [] for the valid case and a non-empty
// array containing the expected substring for each violation case.
```
(Write the four concrete cases with full fixtures; keep them minimal — one step + one delegate node + a terminal step in the parent, and a child with one `inputs` field + one terminal step output field.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/graph/validate-graph.composition.test.ts` — Expected: FAIL.

- [ ] **Step 3: Extend validation**

In `validate-graph.ts`, add an optional second arg `opts?: { resolveChild?: (templateId: string) => WorkflowTemplateT | null }`. In the per-node loop, add a `case "delegate"` branch that pushes violations when:
- the node lacks `childTemplateId`/`childTemplateVersion` (belt-and-suspenders with the contract refinement);
- the node's outgoing edges ≠ 1, or an outgoing edge carries a `port`;
- `opts.resolveChild` is provided and returns null for `childTemplateId` (unresolved child) — skip the key checks if the resolver is absent (author-time may validate structure only);
- (child resolved) any `reads` key (childInputKey) not in the child's `inputs` field keys;
- (child resolved) any `writes` child-key not in the child's **terminal** step `outputSchema` keys (find the child's terminal step via its own graph's `terminal: true` node → step's `outputSchema`).
- Feed the `writes` `parentOutputKey`s into the same forward key-availability fixpoint that `validateSchemaReferences` uses (so downstream `{{...}}` refs to delegate outputs validate), and require each `reads` `parentKeyName` to be available on the delegate node's incoming paths.

Add `validateDelegationAcyclic(db, template)`:
```typescript
export function validateDelegationAcyclic(db: Database.Database, template: WorkflowTemplateT): string[] {
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (tplId: string, tpl: WorkflowTemplateT | null): string[] => {
    if (!tpl) return [];
    if (stack.has(tplId)) return [`delegation cycle detected at template ${tplId}`];
    if (seen.has(tplId)) return [];
    seen.add(tplId); stack.add(tplId);
    const out: string[] = [];
    for (const t of delegationTargets(tpl)) out.push(...visit(t.childTemplateId, getTemplateById(db, t.childTemplateId)));
    stack.delete(tplId);
    return out;
  };
  return visit(template.id, template);
}
```
Call `validateDelegationAcyclic` from the template create/update usecase (`workflows/templates/usecases.ts`) alongside `validateGraph`, so a cyclic or over-deep composed template is rejected at author/install time. (Grep for where `validateGraph` is already called on template create/update and add the acyclic check beside it, with `resolveChild = (id) => getTemplateById(db, id)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/graph` — Expected: PASS (new + existing graph tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.composition.test.ts apps/daemon/src/workflows/templates/usecases.ts
git commit -m "feat(daemon): delegate-node + cross-template DAG validation"
```

---

### Task 6: `emitDelegateSpawn` / `emitDelegateJoin`

**Files:**
- Modify: `apps/daemon/src/harness-transitions/emit.ts`
- Test: `apps/daemon/src/harness-transitions/emit.composition.test.ts` (new)

**Interfaces:**
- Consumes: `defineBoundary` (`emit.ts:22`), `recordHarnessTransition`.
- Produces: `emitDelegateSpawn = defineBoundary("delegate_spawn", ["composition"])`, `emitDelegateJoin = defineBoundary("delegate_join", ["composition"])`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/harness-transitions/emit.composition.test.ts` — seed a goal + run + step-run, call `emitDelegateSpawn` with a `CompositionFacet`, and assert a `harness_transitions` row with `boundary='delegate_spawn'` and a parsed `composition` facet is persisted (mirror the existing `emit` test's DB assertions).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/harness-transitions/emit.composition.test.ts` — Expected: FAIL.

- [ ] **Step 3: Add the boundaries**

In `emit.ts`, beside the existing `defineBoundary(...)` calls:
```typescript
export const emitDelegateSpawn = defineBoundary("delegate_spawn", ["composition"] as const);
export const emitDelegateJoin = defineBoundary("delegate_join", ["composition"] as const);
```
Confirm `recordHarnessTransition`/`RecordTransitionInput` writes the `composition` facet into `composition_json` — the facet registry (Task 2) drives the column mapping, so if the emit path iterates `HARNESS_FACETS` for columns it works automatically; if it enumerates facet keys explicitly, add `composition` there. (Grep `recordHarnessTransition` for how it maps facet keys → columns; extend if explicit.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/harness-transitions` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-transitions/emit.ts apps/daemon/src/harness-transitions/emit.composition.test.ts
git commit -m "feat(daemon): delegate_spawn/delegate_join harness boundaries"
```

---

### Task 7: Spawn — `spawnChildRun`

**Files:**
- Create: `apps/daemon/src/workflows/composition/spawn.ts`
- Test: `apps/daemon/src/workflows/composition/spawn.test.ts`

**Interfaces:**
- Consumes: `startWorkflowRun` (`runs/usecases.ts:100`), `createStepOutputArtifact`/`createArtifact` (`orchestrator/ledger-commit.ts:84`, `artifacts/usecases.ts`), `probeWorkspaceForSession` (`harness-state/workspace-version.ts:56`), `emitDelegateSpawn` (Task 6), the composition store + `resolveReads` + `delegationDepth`/`MAX_DELEGATION_DEPTH` (Tasks 3/4), `recordGoalDecision` (grep the audited-GoalDecision writer used for gate relaxation).
- Produces: `spawnChildRun(deps, args): { childRunId: string; compositionId: string }` — where `deps = { db, bus, now, idFactory }` and `args = { goalId, parentRun, delegateNode, parentOutputs, workspaceSnapshotJson }`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/composition/spawn.test.ts`. Seed a goal + parent run + a delegate node + an installed child template (with `inputs: [{key:'diff_ref',...}]` and a terminal step). Call `spawnChildRun` with `parentOutputs = { change_ref: 'abc' }` and a delegate node `reads: { diff_ref: 'change_ref' }`. Assert:
- a child `workflow_runs` row exists (status `active`) with `parent_composition_id` set;
- a composition row exists (`parent_run_id`=parent, `depth`=1, status `active`);
- the parent run row is `delegating`;
- `goals.active_workflow_run_id` = child run id;
- a `step_output` artifact in the CHILD run whose body parses to `{ diff_ref: 'abc' }`;
- a `harness_transitions` row `boundary='delegate_spawn'`;
- exceeding `MAX_DELEGATION_DEPTH` throws `DelegationDepthError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/spawn.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write `spawn.ts`**

```typescript
import type Database from "better-sqlite3";
import type { EventBus } from "../../events/bus.js";   // match the real EventBus import path
import { startWorkflowRun } from "../runs/usecases.js";
import { createArtifact } from "../artifacts/usecases.js";
import { insertComposition, nextSpawnSeq } from "./store.js";
import { resolveReads } from "./reads-writes.js";
import { delegationDepth, MAX_DELEGATION_DEPTH } from "./depth.js";
import { emitDelegateSpawn } from "../../harness-transitions/emit.js";

export class DelegationDepthError extends Error {}

export interface SpawnDeps { db: Database.Database; bus: EventBus; now: () => string; idFactory: () => string; }

export function spawnChildRun(
  deps: SpawnDeps,
  args: {
    goalId: string;
    parentRun: { id: string };
    delegateNode: { id: string; childTemplateId: string; childTemplateVersion: number; reads: Record<string,string>; writes: Record<string,string> };
    parentOutputs: Record<string, unknown>;
    workspaceSnapshotJson: string | null;
  },
): { childRunId: string; compositionId: string } {
  const { db, now, idFactory } = deps;

  const depth = delegationDepth(db, args.parentRun.id) + 1;
  if (depth > MAX_DELEGATION_DEPTH) throw new DelegationDepthError(`delegation depth ${depth} exceeds ${MAX_DELEGATION_DEPTH}`);

  // 1. Create the child run (own snapshot of the pinned child template).
  const child = startWorkflowRun({ db, bus: deps.bus, now, idFactory }, { goalId: args.goalId, templateId: args.delegateNode.childTemplateId });

  // 2. Composition row + parent link.
  const compositionId = idFactory();
  const seq = nextSpawnSeq(db, args.parentRun.id, args.delegateNode.id);
  insertComposition(db, {
    id: compositionId, goalId: args.goalId, parentRunId: args.parentRun.id, childRunId: child.id,
    delegateNodeId: args.delegateNode.id, spawnSeq: seq, reads: args.delegateNode.reads, writes: args.delegateNode.writes,
    depth, status: "active", costRollupUsd: null, createdAt: now(), finishedAt: null,
  }, args.workspaceSnapshotJson);
  db.prepare(`UPDATE workflow_runs SET parent_composition_id = ? WHERE id = ?`).run(compositionId, child.id);

  // 3. Seed the child's isolated state: the resolved reads as a synthetic entry artifact (C — persisted resolved values).
  const entry = resolveReads(args.delegateNode.reads, args.parentOutputs);
  createArtifact(db, now, {
    goalId: args.goalId, workflowRunId: child.id, stepRunId: null, type: "step_output",
    title: "delegation entry inputs", body: JSON.stringify(entry), source: "orchestrator",
    linkedSessionId: null, linkedTaskId: null, linkedContextPackageId: null,
  }, idFactory, []);

  // 4. Park the parent; child becomes the active leaf.
  db.prepare(`UPDATE workflow_runs SET status = 'delegating' WHERE id = ?`).run(args.parentRun.id);
  db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run(child.id, args.goalId);

  // 5. Inspectable (I7).
  emitDelegateSpawn({ db, bus: deps.bus, now, idFactory }, {
    goalId: args.goalId, workflowRunId: args.parentRun.id, workflowStepRunId: null,
    composition: {
      childRunId: child.id, childTemplateId: args.delegateNode.childTemplateId, childTemplateVersion: args.delegateNode.childTemplateVersion,
      readsKeys: Object.keys(args.delegateNode.reads), writesKeys: Object.keys(args.delegateNode.writes), depth, costRollupUsd: null,
    },
  });

  return { childRunId: child.id, compositionId };
}
```
**Integration notes for the implementer:**
- Confirm the real `EventBus` import path and `createArtifact` signature (Task-extraction shows `createArtifact(db, now, input, idFactory, stagedEvents)` with `stepRunId` accepting null — the seed artifact has no step run). If `stepRunId` is `NOT NULL` in `workflow_artifacts`, attach it to the child's *first* step run instead (create the initial step first, then seed) — adjust and note in the report.
- The `emit*` input shape (`goalId`/`workflowRunId`/`workflowStepRunId` + facet key) must match `RecordTransitionInput`; mirror an existing `emitStepLaunch` call site for the exact field names.
- **Governed launch (B) + workspace snapshot (I3/C/D)** are threaded in by the *caller* (Task 8, the dispatch-engine delegate-entry): the caller probes the workspace, records the `GoalDecision`, and — under `human_review` with `requiresLaunchApproval` — parks for confirm BEFORE calling `spawnChildRun`. `spawnChildRun` itself is the mechanical spawn; keep the policy in the engine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/spawn.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/composition/spawn.ts apps/daemon/src/workflows/composition/spawn.test.ts
git commit -m "feat(daemon): spawnChildRun (isolated seed, delegating park, depth guard, delegate_spawn)"
```

---

### Task 8: Join — `joinChildRun` (verdict-gate, writes-back, divergence, re-verify, cost, resume)

**Files:**
- Create: `apps/daemon/src/workflows/composition/join.ts`
- Test: `apps/daemon/src/workflows/composition/join.test.ts`

**Interfaces:**
- Consumes: the composition store + `mapWrites` (Tasks 3/4), `createStepOutputArtifact` (attribute to the parent delegate node's step-run surrogate — see notes), `buildGoalCostRollup` (`harness-state/cost-rollup.ts:18`) over `descendantRunIds`, `buildStepCompleteStateFacet`/`probeWorkspaceForSession` for divergence, `emitDelegateJoin`.
- Produces: `joinChildRun(deps, childRunId): { parentRunId: string; outcome: "joined" | "propagated_failure" }`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/composition/join.test.ts`. Seed a composition (`c1: r_parent -> r_child`, parent `delegating`), give the child a terminal step run whose `step_result_json`/terminal `EvidenceFacet` verdict = `passed` and a terminal `step_output` artifact `{ findings: ['x'] }`; delegate `writes: { review_findings: 'findings' }`. Call `joinChildRun` and assert:
- a `step_output` artifact attributed to the parent's delegate node with body `{ review_findings: ['x'] }`;
- child run → `completed`; composition row → `completed` with `costRollupUsd` set;
- parent run → `active`; `goals.active_workflow_run_id` = parent;
- a `harness_transitions` row `boundary='delegate_join'` carrying `childVerdict='passed'`;
- **verdict gate:** when the child terminal verdict is `failed`, `joinChildRun` returns `outcome='propagated_failure'`, parent → `blocked` with the child's reason, and NO writes artifact is created.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/join.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write `join.ts`**

Implement the join per spec §4.3 in order: (1) read child terminal `EvidenceFacet.verdict` (from the child's terminal `step_complete` transition, or the terminal step's `step_result_json`); if not `passed` → set parent `blocked` with the child's reason, composition → `failed`, emit `delegate_join` with the verdict, return `propagated_failure`. (2) Read the child terminal `step_output` artifact, `mapWrites` → create a `step_output` artifact attributed to the parent delegate node. (3) belief-divergence: compare the composition-row workspace snapshot vs a fresh probe → `beliefDivergence`. (4) if `validationRequired`, run the sensor veto (reuse the Executable-axis validation path) → `verifyResult`; on veto set parent `blocked`. (5) cost roll-up: `sum(buildGoalCostRollup(db, goalId, runId) for runId in descendantRunIds(child))` → composition `costRollupUsd`. (6) child → `completed`, parent → `active`, `active_workflow_run_id` → parent, cursor advances from the delegate node's single outgoing edge (reuse `resolveStepNext`/the existing advance path treating the delegate node like a step source). (7) `emitDelegateJoin` with the full facet.

**Integration notes:**
- Attributing the writes artifact "to the delegate node": `createStepOutputArtifact` expects a `stepRun`. The delegate node has no step run. Two options — (a) create a lightweight `workflow_step_runs` row for the delegate node (status `passed`, `step_template_id = delegateNodeId`) so downstream `{{...}}`/prior-output assembly finds it uniformly (RECOMMENDED — keeps the blackboard uniform); or (b) write the artifact with `stepRunId = null` + a `delegate_node_id` link. Prefer (a); confirm the `workflow_step_runs` NOT NULL columns and mirror a normal terminal step-run insert. Record the choice.
- Advancing the parent cursor from a delegate node: mirror how `advanceToNextStepOrGate` resolves + moves the cursor for a step node (`resolveStepNext(graph, delegateNodeId)`); the delegate node has one outgoing edge, so it routes like a passed step.
- Verdict source: prefer the child's terminal `step_complete` `EvidenceFacet.verdict`; fall back to the terminal step's `step_result_json` evaluation status. Name exactly which you read in the report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/join.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/composition/join.ts apps/daemon/src/workflows/composition/join.test.ts
git commit -m "feat(daemon): joinChildRun (verdict-gate, writes-back, divergence, cost, resume)"
```

---

### Task 9: Wire spawn + join into the engine (delegate-node entry, terminal interception, governed launch, cost/cancel)

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`, `apps/daemon/src/workflows/steps/usecases.ts`, `apps/daemon/src/harness-state/cost-rollup.ts`, the budget-scope call site, the run-cancel path.
- Test: `apps/daemon/src/workflows/composition/engine.integration.test.ts` (new)

**Interfaces:**
- Consumes: `spawnChildRun` (Task 7), `joinChildRun` (Task 8), `getCompositionByChildRun`/`descendantRunIds` (Task 3), `probeWorkspaceForSession`, the GoalDecision writer.
- Produces: engine routing such that (a) reaching a `delegate` node spawns a child; (b) a child run's terminal step triggers `joinChildRun` instead of the goal-yield; (c) budget scope + mark_done cost span descendants; (d) cancel cascades.

- [ ] **Step 1: Write the failing integration test**

Create `apps/daemon/src/workflows/composition/engine.integration.test.ts`: install a parent template (step → delegate → terminal) + a child template (single terminal step), start a run on a goal, drive it to the delegate node, and assert end-to-end: child run spawns, parent `delegating`; complete the child's terminal step and assert the parent resumes `active` with the delegate node's `writes` artifact present and the run reaching its own terminal. Add a cancel test: cancelling the goal/parent cascades the child to `cancelled`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/engine.integration.test.ts` — Expected: FAIL.

- [ ] **Step 3: Wire the engine**

(a) **Delegate-node entry (`dispatch-engine.ts`).** Where the cursor advances to a node and dispatches by `current_node_kind` (mirror the gate/splitter dispatch branches — grep `current_node_kind` / `evaluateAndParkSplitter` / `parkForGateApproval`), add a `delegate` branch: gather the parent's current outputs (the same prior-outputs map used for step context), `probeWorkspaceForSession` for the parent's active workspace → `workspaceSnapshotJson`, record an auditable `GoalDecision` (title "Delegate to {childTemplate} v{n}", the resolved reads), and — if `operating_mode = human_review` AND `node.requiresLaunchApproval` — park for a launch confirm (reuse the gate-park machinery, resolved by a new decision route or the existing decideGate-style resume); otherwise call `spawnChildRun(...)`.

(b) **Terminal interception (`steps/usecases.ts:366` terminal branch).** Before returning `{ kind: "completed-terminal" }`, check whether the run has a `parent_composition_id`; if so, call `joinChildRun(deps, runId)` and return a new result kind `{ kind: "joined-to-parent", parentRunId }` (or route the engine to resume the parent). The engine's caller then continues advancing the *parent* run.

(c) **Budget scope (I2).** Find where `ctx.budgetSpentUsd` is computed for the guardrail evaluator (grep `budgetSpentUsd` — likely a pre-dispatch pass building the guardrail ctx). For the parent workflow scope, sum spend across `descendantRunIds(db, parentRootRunId)` (root = the top of the delegation stack for this run) using `buildGoalCostRollup` per run. So a child step's cost counts against the parent's cap.

(d) **mark_done cost (I2).** In `harness-state/cost-rollup.ts` `buildGoalCostRollup`, when called for the goal's mark_done, include descendant child-run costs: either loop `descendantRunIds` and sum, or add an overload `buildGoalCostRollupAcross(db, goalId, runIds[])`. Mirror the existing summation; add a test asserting a child step's cost is included in the parent mark_done roll-up.

(e) **Cancel cascade.** In the run/goal cancel path (grep `status = 'cancelled'` in `runs/usecases.ts`), after cancelling a run, cancel its descendant child runs (`descendantRunIds`) and mark their composition rows `cancelled`.

**Integration notes:** this task is the riskiest — it threads four existing subsystems. Keep each sub-change (a–e) behind its own assertion in the integration test. If any existing engine invariant fights the change (e.g. the advance loop assumes the active run never changes identity mid-advance), STOP and report with the exact conflict rather than forcing it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition src/workflows/orchestrator src/harness-state` — Expected: PASS (composition + no orchestrator/harness-state regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/harness-state/cost-rollup.ts apps/daemon/src/workflows/runs/usecases.ts apps/daemon/src/workflows/composition/engine.integration.test.ts
git commit -m "feat(daemon): wire delegate spawn/join into engine (entry, terminal, budget, cancel)"
```

---

### Task 10: Resume + failure-propagation hardening

**Files:**
- Modify: the daemon resume/bootstrap path (grep `resume` in `workflows/orchestrator/`), `dispatch-engine.ts`.
- Test: `apps/daemon/src/workflows/composition/resume.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `resume.test.ts`: build a goal with a `delegating` parent + active child (via the store + runs), simulate a fresh engine/resume pass, and assert the active leaf (child) is the resumable run and the parent stays dormant `delegating`. Add: when a child run is set `failed`, a resume/advance pass sets the parent `blocked` with the child's reason and the composition → `failed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/resume.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Ensure the resume path treats a `delegating` run as dormant (skip it; it has no active step) and resumes the active leaf (the child, found via `goals.active_workflow_run_id`). Add child-terminal-failure propagation: when a child run reaches `failed`, `joinChildRun`'s failure branch (Task 8) sets the parent `blocked` — ensure the resume/advance path invokes that branch. (Reuse the crash-retry/resume machinery; the delegation stack is reconstructed from `parent_composition_id` + composition rows.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/composition/resume.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator apps/daemon/src/workflows/composition/resume.test.ts
git commit -m "feat(daemon): composition resume (dormant delegating parent) + failure propagation"
```

---

### Task 11: Desktop — client + delegate node visual + delegation breadcrumb/nested view

**Files:**
- Modify: `apps/desktop/src/api.ts`, `apps/desktop/src/goal-detail/workflow/*` (the workflow graph panel).
- Test: `apps/desktop/src/goal-detail/workflow/composition.test.tsx` (new)

**Interfaces:**
- Consumes: `WorkflowRunComposition`, the run/graph projections the panel already fetches.
- Produces: the delegate node renders distinctly; a delegation breadcrumb + nested child-run graph render when a run is `delegating`.

- [ ] **Step 1: Write the failing test**

Create `composition.test.tsx`: render the workflow panel with a graph containing a `delegate` node and a `delegating` parent run + an active child run; assert (a) the delegate node renders with the child template label + a "Delegating…" chip; (b) a breadcrumb shows *Parent › Child* and the child run's graph is rendered; (c) navigating up shows the parent with the delegate node highlighted. Mock the API/projection calls the panel uses (mirror the existing workflow-panel test setup).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/goal-detail/workflow/composition.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement**

- Add a `getRunCompositions(goalId)` (or extend the run projection fetch) client fn in `api.ts` mirroring the existing metrics/learning client pattern (`loadConfig`/`authHeaders`/`parseResponse`) — the daemon exposes the composition rows via the run projection (add a route if none exists; grep the workflow run projection route).
- In the workflow graph renderer, add the `delegate` node case (distinct shape/icon + `→ {childTemplate} v{n}` label + `reads`/`writes` badges + a state chip derived from the composition status).
- Add the delegation breadcrumb + nested-run rendering: when the selected run is a delegating parent (or the active leaf has a `parentCompositionId`), render the breadcrumb and the active child's graph; clicking a crumb switches the rendered run. Keep the existing step-card/session/context-preview UI unchanged for child steps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/goal-detail/workflow` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/goal-detail/workflow
git commit -m "feat(desktop): delegate node visual + delegation breadcrumb/nested run view"
```

---

### Task 12: Composed built-in + docs

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (one composed built-in pair), `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`.
- Test: `apps/daemon/src/workflows/templates/catalog.composition.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `catalog.composition.test.ts`: install the composed built-in pair from the catalog and assert (a) both templates install; (b) the parent's delegate node's `reads`/`writes` validate against the child's `inputs`/terminal outputs (call `validateGraph` + `validateDelegationAcyclic`); (c) the pair is acyclic.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && pnpm vitest run src/workflows/templates/catalog.composition.test.ts` — Expected: FAIL.

- [ ] **Step 3: Author the composed built-in + docs**

- In `catalog.ts`, add a small **child** template that declares `inputs` (e.g. one field) + a terminal step producing one output field, and a **parent** template with a step → `delegate` (targeting the child, mapping `reads`/`writes`) → terminal. Keep both minimal; follow the existing `BUILTIN_TEMPLATE_CATALOG` entry shape (display metadata + steps + graph + `inputs`). This is the end-to-end dogfood.
- **ORCA.md §5/§14:** document the 4th node type (`delegate`), the `delegating` status + delegation stack, isolated child state, the `reads`/`writes` typed interface, and the four-axis integration.
- **FUTURE_WORK.md 5.1:** mark **landed** (single-child delegate seam); record deferred: fan-out, outcome-port branching, semantic-merge, workspace file-rollback, per-child runner, MAS-level failure attribution.
- **FUTURE_ARCHITECTURE.md:** composition realized as control-plane + runner-agnostic; the typed template interface as the marketplace-composable-unit seam.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && pnpm vitest run src/workflows/templates/catalog.composition.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.composition.test.ts ORCA.md FUTURE_WORK.md FUTURE_ARCHITECTURE.md
git commit -m "feat(daemon): composed built-in pair + docs for workflow composition"
```

---

## Verification (run after all tasks)

- [ ] `cd packages/contracts && pnpm vitest run` — contracts green.
- [ ] `cd apps/daemon && pnpm vitest run src/workflows src/harness-transitions src/harness-state` — engine + composition + no regressions.
- [ ] `cd apps/desktop && pnpm vitest run src/goal-detail/workflow` — desktop green.
- [ ] `pnpm -r typecheck` — whole workspace typechecks (note: a pre-existing `apps/daemon/src/metrics/aggregate.test.ts` tsc failure predates this branch — do not attribute it to E; confirm no NEW errors in `src/workflows`).
- [ ] Manual smoke (browser proxy): `pnpm dev:browser`, install the composed built-in, run a goal through the delegate node, confirm the breadcrumb + nested child run render, the child sees only the mapped reads, and the parent resumes with the mapped writes.
