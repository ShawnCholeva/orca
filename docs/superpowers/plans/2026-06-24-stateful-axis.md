# Stateful Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the last opaque facet (`stateDeps`) into a strict `StateDepsFacet` carrying derived read/write-sets + structured assumptions + version_deps + conflict_policy + detected conflicts; deterministically detect state conflicts (read/write-set overlap) and belief-divergence across concurrent sessions; and surface them (escalate to human review, or warn) per policy — feeding Inspectable's `state_consistency` metric.

**Architecture:** `read_set` is derived from the inputs the existing context fingerprint already hashes (no agent cooperation). `write_set` is derived at step completion from a bounded `git diff --name-status` + the memory/decision rows the step's session created. A pure deterministic detector compares a completing transition's write_set against concurrent transitions' read/write-sets (and recorded-vs-current versions for belief-divergence); a pluggable `ConflictJudge` seam (no-op default = "every overlap is real") gates it for a future LLM judge. Detected conflicts are recorded on the facet; `conflict_policy="escalate"` pauses via the existing human-review gate, `"auto"` emits a non-blocking warning. No locks, no auto-merge.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `better-sqlite3` (WAL), zod (`@orca/contracts`), Fastify, vitest.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-06-24-stateful-axis-design.md`. Recon shapes: `.superpowers/sdd/stateful-recon-notes.md`.
- **Controller schema refinement (beyond §4.1):** `StateDepsFacet` adds a `conflicts: []` field (default empty) — the detector records detected conflicts there at record time, and Inspectable's `state_consistency` reads `conflicts.length === 0`. This is the faithful realization of §4.3-4 ("a detected conflict is recorded on the facet"); the §4.1 schema just didn't enumerate the field.
- Contracts idiom: `export const X = z.<schema>; export type X = z.infer<typeof X>;`, objects `.strict()`, datetimes `z.string().datetime()`, bounded strings. `StateDepsFacet` mirrors `EvidenceFacet`/`RiskFacet`/`TelemetryFacet` style (`harness/index.ts:34-135`).
- **Contract-tightening lesson (Phases 2/3/4):** tightening `HarnessTransition.stateDeps` REQUIRES the SAME task to update `RecordTransitionInput.stateDeps` (`harness-transitions/usecases.ts:30`), run `pnpm --filter @orca/daemon typecheck`, and `pnpm --filter @orca/contracts build`.
- **Detect-and-surface, NO auto-merge** (D2): conflict → record on facet + escalate (existing human-review gate) or warn (event), per `conflict_policy`. Never merge/pick-winner.
- **Deterministic only; pluggable `ConflictJudge` seam, no-op default** (D4): overlap detection is pure code; the seam mirrors the existing `ctx.conflictDetector` injection (`conflicts/usecases.ts:475`). NO LLM call this plan.
- **No agent step-output schema/instruction change** (D3): read_set/write_set/version_deps derived; assumptions consume the execution step's EXISTING free-text `assumptions[]`.
- Fail-closed defaults (unknown → safe; default `conflict_policy="escalate"`). Daemon subsystem idiom: prepared-stmt caching + `resetPreparedStatements()`; stage events in a txn then publish.
- Migrations: **next free number is `0043`** (only if a task needs a new table/column — most of this plan needs NONE; `state_deps_json` already exists). If added, append to `migrationFiles` in `migrations.ts` + the **4** `toEqual` enumerations in `apps/daemon/src/migrations.test.ts` (and check `apps/daemon/test/migrations-0006.test.ts`).
- Test: `pnpm --filter @orca/daemon test` / `pnpm --filter @orca/contracts test` (vitest, real on-disk SQLite + SpyBus + injected now/idFactory; reset touched prepared statements in afterEach). Known flakes (NOT regressions): `http-surface.test.ts`, `human-review.test.ts` (15s timeout).
- Branch: create `feat/stateful-axis` off `main`.

## Design decisions (locked)

- **D1** Scope: Stateful core P1+P2 (experiential memory = Phase 6, OUT).
- **D2** Conflict response: detect + surface; escalate-or-warn per policy; no auto-merge.
- **D3** read_set/write_set/version_deps DERIVED (no agent change); assumptions consume existing free-text.
- **D4** Deterministic detection + no-op `ConflictJudge` seam (no LLM this plan).
- **D5** Optimistic concurrency (no locks).

---

# Phase P1 — StateDepsFacet contract + read_set, recorded at step launch

### Task 1: `StateDepsFacet` contract + `RecordTransitionInput` alignment + reconcile the Inspectable metric

**Files:**
- Modify: `packages/contracts/src/harness/index.ts`
- Modify: `packages/contracts/src/harness/index.test.ts`
- Modify: `apps/daemon/src/harness-transitions/usecases.ts`
- Modify: `apps/daemon/src/harness-metrics/usecases.ts` (reconcile `state_consistency`)

**Interfaces:**
- Produces: `StateDepReadEntry`, `StateDepWriteEntry`, `StateAssumption`, `StateVersionDep`, `StateConflict`, `ConflictPolicy`, `StateDepsFacet`. Tightens `HarnessTransition.stateDeps` to `StateDepsFacet.nullable()`.

- [ ] **Step 1: Write the failing test** — append to `packages/contracts/src/harness/index.test.ts`:

```ts
import { StateDepsFacet, ConflictPolicy } from "./index.js";

describe("StateDepsFacet", () => {
  it("accepts a populated facet", () => {
    const f = StateDepsFacet.parse({
      read_set: [{ kind: "memory_item", ref: "m1", version: "2026-06-24T00:00:00.000Z" }],
      write_set: [{ kind: "file", ref: "src/x.ts", change_kind: "modified" }],
      assumptions: [{ statement: "config is valid", source_ref: null, verified: false }],
      version_deps: [{ ref: "ws1", observed_version: "main@abc" }],
      conflict_policy: "escalate",
      conflicts: [],
    });
    expect(f.write_set[0].change_kind).toBe("modified");
    expect(f.conflicts).toEqual([]);
  });
  it("defaults conflicts/assumptions/etc. to empty arrays", () => {
    const f = StateDepsFacet.parse({ conflict_policy: "auto" });
    expect(f.read_set).toEqual([]);
    expect(f.conflicts).toEqual([]);
  });
  it("rejects an unknown conflict_policy", () => {
    expect(ConflictPolicy.safeParse("yolo").success).toBe(false);
  });
  it("is accepted as the stateDeps facet on a transition", () => {
    const t = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null, boundary: "step_launch",
      risk: null, evidence: null, telemetry: null,
      stateDeps: { conflict_policy: "escalate" },
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(t.stateDeps?.conflict_policy).toBe("escalate");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @orca/contracts test` → FAIL (`StateDepsFacet`/`ConflictPolicy` not exported).

- [ ] **Step 3: Add the schemas + tighten the facet** — in `packages/contracts/src/harness/index.ts`, ABOVE the `HarnessTransition` declaration (before line ~137):

```ts
export const StateRefKind = z.enum(["file", "memory_item", "decision", "task", "workspace_version"]);
export type StateRefKind = z.infer<typeof StateRefKind>;

export const StateChangeKind = z.enum(["created", "modified", "deleted"]);
export type StateChangeKind = z.infer<typeof StateChangeKind>;

export const ConflictPolicy = z.enum(["auto", "escalate"]);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

export const StateConflictKind = z.enum(["write_write", "read_stale", "belief_divergence"]);
export type StateConflictKind = z.infer<typeof StateConflictKind>;

export const StateDepReadEntry = z.object({
  kind: StateRefKind, ref: z.string().max(512), version: z.string().max(256).nullable(),
}).strict();
export type StateDepReadEntry = z.infer<typeof StateDepReadEntry>;

export const StateDepWriteEntry = z.object({
  kind: StateRefKind, ref: z.string().max(512), change_kind: StateChangeKind,
}).strict();
export type StateDepWriteEntry = z.infer<typeof StateDepWriteEntry>;

export const StateAssumption = z.object({
  statement: z.string().max(1024), source_ref: z.string().max(512).nullable(), verified: z.boolean(),
}).strict();
export type StateAssumption = z.infer<typeof StateAssumption>;

export const StateVersionDep = z.object({
  ref: z.string().max(512), observed_version: z.string().max(256),
}).strict();
export type StateVersionDep = z.infer<typeof StateVersionDep>;

export const StateConflict = z.object({
  kind: StateConflictKind,
  with_transition_id: z.string().max(128).nullable(),
  refs: z.array(z.string().max(512)).max(64).default([]),
}).strict();
export type StateConflict = z.infer<typeof StateConflict>;

export const StateDepsFacet = z.object({
  read_set: z.array(StateDepReadEntry).max(256).default([]),
  write_set: z.array(StateDepWriteEntry).max(256).default([]),
  assumptions: z.array(StateAssumption).max(64).default([]),
  version_deps: z.array(StateVersionDep).max(64).default([]),
  conflict_policy: ConflictPolicy,
  conflicts: z.array(StateConflict).max(64).default([]),
}).strict();
export type StateDepsFacet = z.infer<typeof StateDepsFacet>;
```

Change the `stateDeps` line inside `HarnessTransition` (line 148) from `stateDeps: z.record(z.unknown()).nullable(),` to `stateDeps: StateDepsFacet.nullable(),`. Update the comment at lines 137-138 so it no longer lists `stateDeps` as opaque (ALL four facets are now strict).

- [ ] **Step 4: Align the daemon input type** — in `apps/daemon/src/harness-transitions/usecases.ts`: add `StateDepsFacet` to the type-only `@orca/contracts` import (line ~2-9); change `RecordTransitionInput.stateDeps` (line 30) from `Record<string, unknown> | null` to `StateDepsFacet | null`.

- [ ] **Step 5: Reconcile the Inspectable metric** — in `apps/daemon/src/harness-metrics/usecases.ts`, the `state_consistency` branch (lines 51-61): replace the guessed cast `(t.stateDeps as { conflict?: boolean }).conflict !== true` with the real field `t.stateDeps!.conflicts.length === 0` (the `withStateDeps` filter already guarantees `stateDeps !== null`). Update the stale comment at lines 51-52 to "sourced from the Stateful axis; a transition is consistent when it recorded no conflicts."

```ts
  const state_consistency: Metric =
    withStateDeps.length === 0
      ? { value: null, reason: "no transitions carry a StateDepsFacet" }
      : {
          value:
            withStateDeps.filter((t) => t.stateDeps!.conflicts.length === 0).length /
            withStateDeps.length,
        };
```

- [ ] **Step 6: Build + verify** — `pnpm --filter @orca/contracts test` (GREEN) → `pnpm --filter @orca/contracts build` → `pnpm --filter @orca/daemon typecheck` (CLEAN) → `pnpm --filter @orca/daemon test -- harness-metrics/usecases` (GREEN; if the metric's existing fixtures seeded stateDeps with the old guessed shape, update them to a valid `StateDepsFacet` with `conflicts: []`).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts apps/daemon/src/harness-transitions/usecases.ts apps/daemon/src/harness-metrics/usecases.ts
git commit -m "feat(contracts): StateDepsFacet (last opaque facet) + reconcile state_consistency metric"
```

---

### Task 2: `deriveReadSet` — read_set from the context inputs (pure)

**Files:**
- Create: `apps/daemon/src/harness-state/read-set.ts`
- Test: `apps/daemon/src/harness-state/read-set.test.ts`

**Interfaces:**
- Produces: `deriveReadSet(input: { memory: {id,updatedAt}[]; decisions: {id,updatedAt}[]; summaries: {id,created_at}[]; refinement: {goalId,refinedAt}|null; workspace: {id,branch,dirty}|null }): { read_set: StateDepReadEntry[]; version_deps: StateVersionDep[] }`.

The shape mirrors exactly the inputs `buildContextAssemblyInput` hashes (`context/input.ts:184-215`). This is a PURE transform of those inputs into facet entries — no DB, so it's unit-testable and reused by whatever calls it at launch.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-state/read-set.test.ts
import { describe, expect, it } from "vitest";
import { deriveReadSet } from "./read-set.js";

describe("deriveReadSet", () => {
  it("maps memory/decision/summary/refinement/workspace inputs to read_set + version_deps", () => {
    const r = deriveReadSet({
      memory: [{ id: "m1", updatedAt: "2026-06-24T00:00:00.000Z" }],
      decisions: [{ id: "d1", updatedAt: "2026-06-24T00:01:00.000Z" }],
      summaries: [{ id: "s1", created_at: "2026-06-24T00:02:00.000Z" }],
      refinement: { goalId: "g", refinedAt: "2026-06-24T00:03:00.000Z" },
      workspace: { id: "ws1", branch: "main", dirty: false },
    });
    expect(r.read_set).toContainEqual({ kind: "memory_item", ref: "m1", version: "2026-06-24T00:00:00.000Z" });
    expect(r.read_set).toContainEqual({ kind: "decision", ref: "d1", version: "2026-06-24T00:01:00.000Z" });
    expect(r.read_set).toContainEqual({ kind: "workspace_version", ref: "ws1", version: "main:false" });
    expect(r.version_deps).toContainEqual({ ref: "ws1", observed_version: "main:false" });
  });
  it("handles empty inputs", () => {
    const r = deriveReadSet({ memory: [], decisions: [], summaries: [], refinement: null, workspace: null });
    expect(r.read_set).toEqual([]);
    expect(r.version_deps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @orca/daemon test -- harness-state/read-set` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/daemon/src/harness-state/read-set.ts
import type { StateDepReadEntry, StateVersionDep } from "@orca/contracts";

export interface ReadSetInput {
  memory: Array<{ id: string; updatedAt: string }>;
  decisions: Array<{ id: string; updatedAt: string }>;
  summaries: Array<{ id: string; created_at: string }>;
  refinement: { goalId: string; refinedAt: string } | null;
  workspace: { id: string; branch: string | null; dirty: boolean | null } | null;
}

export function deriveReadSet(input: ReadSetInput): { read_set: StateDepReadEntry[]; version_deps: StateVersionDep[] } {
  const read_set: StateDepReadEntry[] = [];
  const version_deps: StateVersionDep[] = [];
  for (const m of input.memory) read_set.push({ kind: "memory_item", ref: m.id, version: m.updatedAt });
  for (const d of input.decisions) read_set.push({ kind: "decision", ref: d.id, version: d.updatedAt });
  for (const s of input.summaries) read_set.push({ kind: "task", ref: s.id, version: s.created_at });
  if (input.refinement) read_set.push({ kind: "decision", ref: input.refinement.goalId, version: input.refinement.refinedAt });
  if (input.workspace) {
    const wv = `${input.workspace.branch ?? ""}:${input.workspace.dirty?.toString() ?? ""}`;
    read_set.push({ kind: "workspace_version", ref: input.workspace.id, version: wv });
    version_deps.push({ ref: input.workspace.id, observed_version: wv });
  }
  return { read_set, version_deps };
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @orca/daemon test -- harness-state/read-set` (PASS).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-state/read-set.ts apps/daemon/src/harness-state/read-set.test.ts
git commit -m "feat(daemon): deriveReadSet — read_set + version_deps from context inputs (pure)"
```

---

### Task 3: Emit a `step_launch` HarnessTransition carrying read_set (RECON-FIRST)

> **RECON-FIRST.** The exact step-launch hook in the orchestrator (where `buildContextAssemblyInput` is called per step, with `goalId`/`workflowStepRunId`/`workspaceId` in scope) is not pinned. Recon `context/usecases.ts:191` (the function enclosing the `buildContextAssemblyInput` call) and the orchestrator step-launch path BEFORE writing. If the launch site doesn't cleanly have a `workflowStepRunId` + the context inputs together, STOP and report NEEDS_CONTEXT with what you found.

**Files:**
- Modify: the step-launch site (recon: near `context/usecases.ts:191` / the orchestrator step-start path)
- Test: a new or extended orchestrator/context test asserting a `step_launch` transition with a read_set facet is recorded.

**Interfaces:**
- Consumes: `deriveReadSet` (Task 2), `recordHarnessTransition` (`harness-transitions/usecases.js`), the per-goal `conflict_policy` (default `"escalate"` — see note).

- [ ] **Step 1: Recon + write the failing test** — confirm the launch hook; write a test that drives a step launch and asserts `listTransitionsByGoal(db, goalId).find(t => t.boundary === "step_launch")?.stateDeps?.read_set` is non-empty and `conflict_policy` is set. (Mirror the existing harness-transition emission tests, e.g. the Inspectable `service.agent-step` style.)

- [ ] **Step 2: Run to verify it fails** — the focused test FAILS (no step_launch transition emitted today; recon confirmed `step_launch` is enum-valid but unwired).

- [ ] **Step 3: Implement** — at the step-launch site, after the context inputs are assembled, call `deriveReadSet(...)` with the same memory/decision/summary/refinement/workspace data `buildContextAssemblyInput` used, then `recordHarnessTransition(ctx, { goalId, workflowRunId, workflowStepRunId, boundary: "step_launch", stateDeps: { ...deriveReadSet(...), write_set: [], assumptions: [], conflict_policy, conflicts: [] } })`. Wrap in try/catch logging (mirror the existing `recordHarnessTransition (tool_gate) failed` pattern at `permission-gate.ts:49`) — a telemetry/state-record failure must never break the step launch.

> **`conflict_policy` source:** default to the constant `"escalate"` (fail-safe) for P1. (A per-goal column mirroring `operating_mode` is a deliberate non-goal of this plan unless recon shows a per-goal field already exists; if you add one, that's a migration `0043` + its snapshot-test updates — only if genuinely needed. Default-constant is sufficient for P1/P2.)

- [ ] **Step 4: Run to verify it passes** — focused test + `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(daemon): emit step_launch HarnessTransition with derived read_set"
```

**End of P1.** read_set is recorded on a `step_launch` transition; `state_consistency` now has data (all-consistent until P2 detects conflicts).

---

# Phase P2 — write_set, deterministic conflict + belief-divergence, escalate/warn

### Task 4: `deriveWriteSet` — git diff + created rows (bounded)

**Files:**
- Create: `apps/daemon/src/harness-state/write-set.ts`
- Test: `apps/daemon/src/harness-state/write-set.test.ts`

**Interfaces:**
- Produces: `deriveWriteSet(db, { workspacePath, sessionId }): StateDepWriteEntry[]` — file entries from a bounded `git diff --name-status` over `workspacePath`, plus memory/decision rows created by the step's session (JOIN `sessions.workflow_step_run_id` is NOT needed here — use `source_session_id = sessionId` directly on `goal_memory_items`/`goal_decisions`). Fail-safe: git unavailable/timeout → file entries omitted (not an error); the created-rows query still runs.

- [ ] **Step 1: Write the failing test** — seed `goal_memory_items`/`goal_decisions` rows with `source_session_id = 's1'`; stub/inject the git-diff function to return a fixed name-status list (inject it so the test is deterministic without a real repo). Assert the write_set contains `{kind:"file", ref:<path>, change_kind:"modified"}` for diffed files and `{kind:"memory_item", ref:<id>, change_kind:"created"}` / `{kind:"decision", ...}` for the seeded rows.

```ts
// apps/daemon/src/harness-state/write-set.test.ts (sketch — use the standard openTestDb harness)
import { deriveWriteSet } from "./write-set.js";
// inject a fake git differ: (cwd) => [{ status: "M", path: "src/x.ts" }]
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @orca/daemon test -- harness-state/write-set` → FAIL.

- [ ] **Step 3: Implement** — a bounded `git diff --name-status` mirroring `workspaces/inspect.ts:25-37` (`execFile("git", ["diff","--name-status"], { cwd, timeout: 2000, maxBuffer: 1_048_576, encoding: "utf8" })`) wrapped to resolve `[]` on any error/timeout; parse each line `"<STATUS>\t<path>"` → `change_kind` (`A`→created, `M`→modified, `D`→deleted; default modified). Then `SELECT id FROM goal_memory_items WHERE source_session_id = ?` → `{kind:"memory_item", ref:id, change_kind:"created"}` and the same for `goal_decisions` → `{kind:"decision", ...}`. Make the git-differ INJECTABLE (a function param defaulting to the real bounded call) so the test is deterministic. Pure over (db, injected differ).

- [ ] **Step 4: Run to verify it passes** — focused test PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-state/write-set.ts apps/daemon/src/harness-state/write-set.test.ts
git commit -m "feat(daemon): deriveWriteSet — bounded git diff + session-created rows"
```

---

### Task 5: The deterministic conflict + belief-divergence detector + `ConflictJudge` seam

**Files:**
- Create: `apps/daemon/src/harness-state/detect.ts`
- Test: `apps/daemon/src/harness-state/detect.test.ts`

**Interfaces:**
- Produces: `detectStateConflicts(input: { self: { read_set, write_set, version_deps }; priors: Array<{ transitionId: string; read_set; write_set }>; currentVersions: Map<string,string>; judge?: ConflictJudge }): StateConflict[]`. `ConflictJudge` = `{ judge(c: StateConflict): "real" | "false_positive" }`; export `noopConflictJudge` returning `"real"` always.

Pure function. Three signals: (a) **write-write** — `self.write_set.ref` ∩ any prior `write_set.ref` → `{kind:"write_write", with_transition_id, refs}`; (b) **read-stale** — `self.read_set.ref` ∩ any prior `write_set.ref` (this step read what a concurrent step wrote) → `{kind:"read_stale", ...}`; (c) **belief_divergence** — any `self.version_deps` whose `observed_version` ≠ `currentVersions.get(ref)` → `{kind:"belief_divergence", with_transition_id:null, refs:[ref]}`. Each candidate passes through `judge`; only `"real"` ones are returned (default no-op keeps all).

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-state/detect.test.ts
import { describe, expect, it } from "vitest";
import { detectStateConflicts, noopConflictJudge } from "./detect.js";

const entry = (kind: string, ref: string) => ({ kind, ref } as any);

describe("detectStateConflicts", () => {
  it("flags write-write overlap on the same ref", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [entry("file","src/x.ts")], version_deps: [] },
      priors: [{ transitionId: "t-prev", read_set: [], write_set: [entry("file","src/x.ts")] }],
      currentVersions: new Map(),
    });
    expect(c.find((x) => x.kind === "write_write")?.refs).toContain("src/x.ts");
    expect(c.find((x) => x.kind === "write_write")?.with_transition_id).toBe("t-prev");
  });
  it("flags read-stale when self read a ref a prior wrote", () => {
    const c = detectStateConflicts({
      self: { read_set: [entry("memory_item","m1")], write_set: [], version_deps: [] },
      priors: [{ transitionId: "t2", read_set: [], write_set: [entry("memory_item","m1")] }],
      currentVersions: new Map(),
    });
    expect(c.some((x) => x.kind === "read_stale")).toBe(true);
  });
  it("flags belief-divergence when observed != current version", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [], version_deps: [{ ref: "ws1", observed_version: "main:false" }] },
      priors: [], currentVersions: new Map([["ws1", "main:true"]]),
    });
    expect(c.some((x) => x.kind === "belief_divergence")).toBe(true);
  });
  it("returns [] when no overlap and versions match", () => {
    expect(detectStateConflicts({
      self: { read_set: [entry("file","a")], write_set: [entry("file","b")], version_deps: [{ ref:"ws1", observed_version:"v" }] },
      priors: [{ transitionId: "t", read_set: [], write_set: [entry("file","c")] }],
      currentVersions: new Map([["ws1","v"]]),
    })).toEqual([]);
  });
  it("a refuting judge drops candidates", () => {
    const c = detectStateConflicts({
      self: { read_set: [], write_set: [entry("file","x")], version_deps: [] },
      priors: [{ transitionId: "t", read_set: [], write_set: [entry("file","x")] }],
      currentVersions: new Map(),
      judge: { judge: () => "false_positive" },
    });
    expect(c).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @orca/daemon test -- harness-state/detect` → FAIL.

- [ ] **Step 3: Implement** — pure function over the three signals + the `judge` gate; export `noopConflictJudge = { judge: () => "real" as const }`. Type with the contract types (`StateConflict`, `StateDepReadEntry`, `StateDepWriteEntry`, `StateVersionDep`). Compare refs by `kind:ref` equality (a file `src/x.ts` and a memory `src/x.ts` are different refs).

- [ ] **Step 4: Run to verify it passes** — focused test PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-state/detect.ts apps/daemon/src/harness-state/detect.test.ts
git commit -m "feat(daemon): deterministic state-conflict + belief-divergence detector + ConflictJudge seam (no-op)"
```

---

### Task 6: Wire write_set + assumptions + detection at step_complete; escalate/warn (RECON-FIRST)

> **RECON-FIRST.** Two unknowns to resolve before writing: (a) the **concurrent-set query** — how to select "other un-merged transitions on the same goal/workspace" (recon `buildConflictSnapshot` `detectors.ts:170` for the running-session pattern; the simplest correct set is the recent `step_launch`/`step_complete` transitions for the same goal from currently-`running` sessions, excluding self); (b) the **escalate seam** — E1 (`createHumanReviewRequest` → `orchestration_human_reviews`, `human-review.ts:361`) vs E2 (`pending_*_json` parking, `service.ts`). Trace which the existing `require_approval`/human-review path lands in and reuse THAT; if genuinely ambiguous in a way that changes product behavior, STOP and report NEEDS_CONTEXT.

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the two `step_complete` `recordHarnessTransition` sites: ~1696, ~2405)
- Modify: a concurrent-set query helper (new small file `apps/daemon/src/harness-state/concurrent.ts` or inline)
- Test: extend `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

**Interfaces:**
- Consumes: `deriveWriteSet` (Task 4), `detectStateConflicts` + `noopConflictJudge` (Task 5), the escalate seam (recon), the per-goal/default `conflict_policy`.

- [ ] **Step 1: Recon + write the failing test** — confirm the concurrent-set query + escalate seam. Test 1: two concurrent sessions on one goal both write `src/x.ts`; the second step_complete records a `step_complete` transition whose `stateDeps.conflicts` contains a `write_write` referencing the first, AND (policy `escalate`) the step is paused via the gate (assert the gate's pending row/state). Test 2: policy `auto` → conflict recorded + a warning event emitted, step NOT paused.

- [ ] **Step 2: Run to verify it fails** — today no write_set/detection runs at step_complete.

- [ ] **Step 3: Implement** — at the step_complete site: derive `write_set` (Task 4) + structured `assumptions` (map the execution step's existing free-text `assumptions[]` → `{statement, source_ref:null, verified:false}`; empty if none); build the `step_complete` `StateDepsFacet` (read_set re-derived or carried from launch — re-derive via the same inputs is acceptable); gather the concurrent priors (recon query) + `currentVersions` (current workspace/memory versions); run `detectStateConflicts({ self, priors, currentVersions, judge: noopConflictJudge })`; set `facet.conflicts`; record the transition with the facet. THEN, if `conflicts.length > 0`: `conflict_policy === "escalate"` → pause the affected step via the recon'd gate; `=== "auto"` → emit a warning event (mirror the existing `conflict.detected` event from `conflicts/usecases.ts`) and proceed. NEVER merge. Wrap the whole state-block in try/catch (mirror `service.ts:2423`) so it can't break step completion.

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @orca/daemon test -- service.agent-step` + `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(daemon): step_complete write_set + state-conflict detection + escalate/warn per policy"
```

**End of P2.** Concurrent state conflicts + belief-divergence are detected deterministically, recorded on the facet, and escalated or warned per policy; `state_consistency` reflects them.

---

## Self-Review

**Spec coverage (against `2026-06-24-stateful-axis-design.md`):**
- §4.1 StateDepsFacet contract (+ the `conflicts` controller-refinement field) → Task 1. ✓
- §4.2-1 read_set derived from context inputs → Tasks 2, 3. ✓
- §4.2-2 write_set derived (git diff + created rows) → Task 4. ✓
- §4.2-3 assumptions from existing free-text → Task 6. ✓
- §4.2-4 version_deps → Tasks 2 (workspace) + 6 (current). ✓
- §4.3-1 deterministic overlap detector → Task 5. ✓
- §4.3-2 ConflictJudge seam (no-op) → Task 5. ✓
- §4.3-3 belief-divergence → Task 5. ✓
- §4.3-4 detect-and-surface response (escalate/warn, record on facet) → Task 6. ✓
- §4.4 reconcile Inspectable state_consistency → Task 1. ✓
- D4 no LLM (seam only) → Task 5. ✓  D2 no auto-merge → Task 6. ✓

**Recon-first / risk:** Tasks 3 and 6 are explicit recon-first with NEEDS_CONTEXT gates — the step-launch hook (Task 3), and the concurrent-set query + escalate seam E1-vs-E2 (Task 6) are the integration unknowns. The deterministic core (Tasks 1, 2, 4, 5) is fully specified.

**Type consistency:** `StateDepsFacet`/`StateConflict`/`ConflictPolicy`/`StateDepReadEntry`/`StateDepWriteEntry`/`StateVersionDep` defined in Task 1 are consumed unchanged in Tasks 2, 4, 5, 6. `deriveReadSet` (Task 2) → step_launch facet (Task 3). `deriveWriteSet` (Task 4) + `detectStateConflicts` (Task 5) → Task 6. The metric reads `t.stateDeps.conflicts.length` (Task 1) which Task 6 populates.

**Migrations:** NONE required (the `state_deps_json` column already exists; conflicts live inside the facet JSON). A per-goal `conflict_policy` column is a deliberate non-goal unless recon shows it's needed (then 0043 + the 4 snapshot enumerations).

**Known recon-first for execution:** Task 3 (step-launch hook) and Task 6 (concurrent-set + escalate seam) must recon before dispatch.
