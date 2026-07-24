# Node Confidence Model — Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive, at read-time, the **downstream-vindication signal** for each step completion — was it *vindicated* (downstream accepted it), *bounced* (downstream rejected it), or *pending* (no downstream outcome yet) — and surface it as observational data. **No score change** in 2a; Phase 2b consumes this to make calibration load-bearing.

**Architecture:** Recompute-on-read, **no DB migration** — the signal derives from `harness_transitions` (per-run, `createdAt`-ordered) + `workflow_gate_decisions` + `workflow_split_decisions`, joined against the current template graph, reusing the version-immune per-run temporal-join pattern already in `gate-metrics.ts`. A step is labeled by what its *immediate downstream node* did with its final completion. Version-safety mirrors Phase 1's latest-version gate-credit guard.

**Tech Stack:** TypeScript, Zod contracts, Vitest (`vitest run`). Daemon package `@orca/daemon`.

## Global Constraints

- **Recompute-on-read; NO database migrations.** All data already persists (gate decisions migration 0029, split decisions migration 0038, transitions). Only read-only query/SELECT additions are allowed.
- **Version-safety (locked, Phase A):** only label completions from **latest-version** runs (the current graph is valid only for the latest topology) — mirror `usecases.ts` gate-credit filter (`d.templateVersion === info.latestVersion`). Older-version completions → not labeled (treated as no-signal), never mis-attributed.
- **2a does NOT move the score.** `composedScore`, `aggregate`'s mean/band, and calibration are untouched in 2a. The only `StepMetrics` change is a new **observational** `vindication` field.
- **Ask-stability (2a scope):** a step's instructions are version-pinned per run (identical across attempts), so a gate-reject → redo is inherently a stable-ask **bounce**. The human-goal-change "pivot → neutral" case is out of 2a scope (documented refinement — needs a `goals` join).
- **Deterministic core:** pure TypeScript over facets; no LLM calls.
- **Transitions have no sequence column** — only `createdAt`. All per-run ordering is `createdAt`-based (the established `gate-metrics.ts` pattern).
- Test runner: from `apps/daemon`, `npx vitest run <path>`; run the **full** `npx vitest run src/metrics` + `npx tsc --noEmit` before every commit.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

- `apps/daemon/src/metrics/fetch.ts` — MODIFY: add `SplitDecisionRow` + `listSplitDecisionsByTemplate`; add `selectedEdgeTo` to `GateDecisionRow` + its SELECT.
- `apps/daemon/src/metrics/vindication.ts` — CREATE: pure `deriveVindication(...)`.
- `apps/daemon/src/metrics/vindication.test.ts` — CREATE.
- `apps/daemon/src/metrics/aggregate.ts` — MODIFY: accept a per-completion vindication lookup; aggregate per-step counts into `StepMetrics.vindication`.
- `apps/daemon/src/metrics/aggregate.steps.test.ts` — MODIFY.
- `apps/daemon/src/metrics/usecases.ts` — MODIFY: load split decisions, compute vindication (latest-version filtered), pass the lookup into `computeStepMetrics`.
- `apps/daemon/src/metrics/usecases.gate.test.ts` (or a new `usecases.vindication.test.ts`) — MODIFY/CREATE: E2E.
- `packages/contracts/src/metrics/index.ts` — MODIFY: add the optional `vindication` field to `StepMetrics`.

---

## Task 1: Fetch — split decisions + gate `selectedEdgeTo`

**Files:**
- Modify: `apps/daemon/src/metrics/fetch.ts`
- Test: the existing fetch test file (grep `grep -rn "listGateDecisionsByTemplate" apps/daemon/src/metrics/*.test.ts` to find where gate-decision loading is tested; mirror it). If none exists, add a focused DB-fixture test following the pattern in `usecases.gate.test.ts` (which seeds `workflow_gate_decisions` rows).

**Interfaces:**
- Produces:
```ts
export type SplitDecisionRow = {
  id: string; workflowRunId: string; nodeId: string; traversalSeq: number;
  selectedBranch: string; selectedEdgeTo: string; createdAt: string; templateVersion: number;
};
export function listSplitDecisionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): SplitDecisionRow[];
```
- Also adds `selectedEdgeTo: string` to `GateDecisionRow`.

- [ ] **Step 1: Write the failing test.** Following the existing gate-decision fetch/DB-fixture pattern, seed one `workflow_split_decisions` row and assert `listSplitDecisionsByTemplate` returns it mapped to `SplitDecisionRow` (camelCase, with `selectedBranch`/`selectedEdgeTo`/`templateVersion` from the `workflow_runs` join). Also assert `listGateDecisionsByTemplate` now returns `selectedEdgeTo`.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run <fetch test path>` — FAIL (function/field absent).

- [ ] **Step 3: Implement.** In `fetch.ts`:
  1. Add `selected_edge_to` to the gate SELECT (`listGateDecisionsByTemplate`) and `selectedEdgeTo` to `GateDecisionRow` + its row-map.
  2. Add `SplitDecisionRow` and `listSplitDecisionsByTemplate` mirroring the gate loader exactly:
```ts
export function listSplitDecisionsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string
): SplitDecisionRow[] {
  const rows = db.prepare(
    `SELECT sd.id, sd.workflow_run_id, sd.node_id, sd.traversal_seq, sd.selected_branch,
            sd.selected_edge_to, sd.created_at, wr.template_version
     FROM workflow_split_decisions sd
     JOIN workflow_runs wr ON wr.id = sd.workflow_run_id
     WHERE wr.template_id = ? AND sd.created_at >= ? AND sd.created_at < ?
     ORDER BY sd.created_at ASC, sd.id ASC`
  ).all(templateId, sinceIso, untilIso) as Array<{
    id: string; workflow_run_id: string; node_id: string; traversal_seq: number;
    selected_branch: string; selected_edge_to: string; created_at: string; template_version: number;
  }>;
  return rows.map((r) => ({
    id: r.id, workflowRunId: r.workflow_run_id, nodeId: r.node_id, traversalSeq: r.traversal_seq,
    selectedBranch: r.selected_branch, selectedEdgeTo: r.selected_edge_to,
    createdAt: r.created_at, templateVersion: r.template_version,
  }));
}
```

- [ ] **Step 4: Run to verify pass.** `npx vitest run <fetch test path>`; then `npx vitest run src/metrics` + `npx tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add apps/daemon/src/metrics/fetch.ts <fetch test file>
git commit -m "feat(metrics): load split decisions + gate selectedEdgeTo for vindication

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `vindication.ts` — the pure derivation

**Files:**
- Create: `apps/daemon/src/metrics/vindication.ts`
- Test: `apps/daemon/src/metrics/vindication.test.ts`

**Interfaces:**
- Consumes: `TemplateTransition`, `GateDecisionRow`, `SplitDecisionRow` (Task 1), `WorkflowGraph`.
- Produces:
```ts
export type VindicationOutcome = "vindicated" | "bounced" | "pending";
export type VindicationResult = { outcome: VindicationOutcome; byNodeId: string | null };
// key: `${workflowRunId}::${stepNodeId}` — one label per (run, step), for the step's FINAL completion.
// byNodeId = the downstream node whose outcome decided the label (null for terminal). Carried for Phase 2b attenuation.
export function deriveVindication(input: {
  transitions: TemplateTransition[];
  gateDecisions: GateDecisionRow[];
  splitDecisions: SplitDecisionRow[];
  graph: WorkflowGraph;
}): Map<string, VindicationResult>;
```

**Semantics (label the step's FINAL completion per run — aligns with `finalStepCompletes` scoring):**
- Downstream = the step node's single outgoing edge target. Terminal step (no outgoing edge) → vindicated iff a `mark_done` transition exists in the run after the completion (human acceptance is the terminal ground truth), else pending.
- Downstream is a **gate**: the earliest gate decision for that gate node in the run with `createdAt >` the completion → `approved`=vindicated, `rejected`=bounced; none yet → pending.
- Downstream is a **splitter**: a split decision for that node in the run after the completion → vindicated (routing proceeded); none → pending. *(Backtrack/misroute detection is Phase 3, when splitters are scored.)*
- Downstream is a **delegate**: a `delegate_join` transition in the run after the completion → vindicated; else pending.
- Downstream is a **step**: that step completes in the run after the completion → vindicated (it proceeded on our output); else pending.

- [ ] **Step 1: Write the failing tests** — `vindication.test.ts`. Build a small graph and per-run transitions/decisions with the file's fixture idiom (`as never` casts as in `composed-score.test.ts`). Cover:
```ts
import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { deriveVindication } from "./vindication.js";

const graph = { nodes: [
  { id: "proposal", type: "step", name: "P", stepId: "proposal" },
  { id: "critique", type: "gate", name: "C", instructions: "x" },
  { id: "execution", type: "step", name: "E", stepId: "execution" },
  { id: "review", type: "gate", name: "V", instructions: "x" },
  { id: "done", type: "step", name: "D", stepId: "done", terminal: true },
], edges: [
  { from: "proposal", to: "critique" }, { from: "critique", to: "execution", port: "approved" }, { from: "critique", to: "proposal", port: "rejected" },
  { from: "execution", to: "review" }, { from: "review", to: "done", port: "approved" }, { from: "review", to: "execution", port: "rejected" },
], positions: {} } as never;

const sc = (runId: string, step: string, at: string) => ({ templateVersion: 1, stepTemplateId: step,
  transition: { id: `${runId}-${step}-${at}`, workflowRunId: runId, boundary: "step_complete", createdAt: at } } as never);
const markDone = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: null,
  transition: { id: `${runId}-done-${at}`, workflowRunId: runId, boundary: "mark_done", createdAt: at } } as never);
const gate = (runId: string, node: string, outcome: "approved" | "rejected", at: string) =>
  ({ id: `${runId}-${node}-${at}`, workflowRunId: runId, nodeId: node, traversalSeq: 1, outcome, reason: "", issueRefs: [], recommendedOutcome: null, recommendedReason: null, selectedEdgeTo: "", createdAt: at, templateVersion: 1 });

describe("deriveVindication", () => {
  it("gate-approved downstream → vindicated", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [gate("r1", "critique", "approved", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "vindicated", byNodeId: "critique" });
  });
  it("gate-rejected downstream → bounced", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [gate("r1", "critique", "rejected", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "bounced", byNodeId: "critique" });
  });
  it("no downstream decision yet → pending", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "pending", byNodeId: "critique" });
  });
  it("labels the FINAL completion: reject-then-redo-then-approve → vindicated", () => {
    const m = deriveVindication({
      transitions: [sc("r1", "proposal", "t1"), sc("r1", "proposal", "t3")],
      gateDecisions: [gate("r1", "critique", "rejected", "t2"), gate("r1", "critique", "approved", "t4")],
      splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "vindicated", byNodeId: "critique" });
  });
  it("terminal step vindicated by mark_done", () => {
    const m = deriveVindication({ transitions: [sc("r1", "done", "t1"), markDone("r1", "t2")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::done")).toEqual({ outcome: "vindicated", byNodeId: null });
  });
  it("terminal step pending without mark_done", () => {
    const m = deriveVindication({ transitions: [sc("r1", "done", "t1")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::done")).toEqual({ outcome: "pending", byNodeId: null });
  });
  it("downstream step proceeded → vindicated (execution → review gate approved isn't needed; execution vindicated when review approves)", () => {
    // execution's downstream is the 'review' gate:
    const m = deriveVindication({ transitions: [sc("r1", "execution", "t1")], gateDecisions: [gate("r1", "review", "approved", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::execution")).toEqual({ outcome: "vindicated", byNodeId: "review" });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/metrics/vindication.test.ts` — FAIL (module absent).

- [ ] **Step 3: Implement** — `vindication.ts`:
```ts
import type { WorkflowGraph } from "@orca/contracts";
import type { TemplateTransition, GateDecisionRow, SplitDecisionRow } from "./fetch.js";

export type VindicationOutcome = "vindicated" | "bounced" | "pending";
export type VindicationResult = { outcome: VindicationOutcome; byNodeId: string | null };

function push<K, V>(m: Map<K, V[]>, k: K, v: V) { (m.get(k) ?? m.set(k, []).get(k)!).push(v); }

export function deriveVindication(input: {
  transitions: TemplateTransition[];
  gateDecisions: GateDecisionRow[];
  splitDecisions: SplitDecisionRow[];
  graph: WorkflowGraph;
}): Map<string, VindicationResult> {
  const { graph } = input;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // step identity (stepId ?? id) -> single downstream node id, or null (terminal / not exactly one edge)
  const downstreamOf = new Map<string, string | null>();
  for (const n of graph.nodes) {
    if (n.type !== "step") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    downstreamOf.set(n.stepId ?? n.id, out.length === 1 ? out[0].to : null);
  }
  // downstream-step identity resolver (a downstream node id -> the stepTemplateId transitions carry)
  const stepIdentityOf = (nodeId: string) => nodeById.get(nodeId)?.stepId ?? nodeId;

  const stepCompletesByRun = new Map<string, TemplateTransition[]>();
  const markDoneByRun = new Map<string, TemplateTransition[]>();
  const delegateJoinByRun = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    const runId = t.transition.workflowRunId;
    if (runId == null) continue;
    const b = t.transition.boundary;
    if (b === "step_complete" && t.stepTemplateId && !t.stepTemplateId.startsWith("__gate__:")) push(stepCompletesByRun, runId, t);
    else if (b === "mark_done") push(markDoneByRun, runId, t);
    else if (b === "delegate_join") push(delegateJoinByRun, runId, t);
  }
  const gatesByRunNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.gateDecisions) push(gatesByRunNode, `${d.workflowRunId}::${d.nodeId}`, d);
  const splitsByRunNode = new Map<string, SplitDecisionRow[]>();
  for (const d of input.splitDecisions) push(splitsByRunNode, `${d.workflowRunId}::${d.nodeId}`, d);

  // final completion per (run, step)
  const finalByRunStep = new Map<string, TemplateTransition>();
  for (const [, arr] of stepCompletesByRun) for (const t of arr) {
    const k = `${t.transition.workflowRunId}::${t.stepTemplateId}`;
    const prev = finalByRunStep.get(k);
    if (!prev || t.transition.createdAt > prev.transition.createdAt) finalByRunStep.set(k, t);
  }

  const out = new Map<string, VindicationResult>();
  for (const [k, t] of finalByRunStep) {
    const runId = t.transition.workflowRunId!;
    const stepId = t.stepTemplateId!;
    const at = t.transition.createdAt;
    const dn = downstreamOf.get(stepId) ?? null;
    if (dn == null) {
      const done = (markDoneByRun.get(runId) ?? []).some((m) => m.transition.createdAt > at);
      out.set(k, { outcome: done ? "vindicated" : "pending", byNodeId: null });
      continue;
    }
    const dtype = nodeById.get(dn)?.type;
    if (dtype === "gate") {
      const dec = (gatesByRunNode.get(`${runId}::${dn}`) ?? [])
        .filter((d) => d.createdAt > at).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      out.set(k, dec == null ? { outcome: "pending", byNodeId: dn }
        : { outcome: dec.outcome === "approved" ? "vindicated" : "bounced", byNodeId: dn });
    } else if (dtype === "splitter") {
      const routed = (splitsByRunNode.get(`${runId}::${dn}`) ?? []).some((d) => d.createdAt > at);
      out.set(k, { outcome: routed ? "vindicated" : "pending", byNodeId: dn });
    } else if (dtype === "delegate") {
      const joined = (delegateJoinByRun.get(runId) ?? []).some((j) => j.transition.createdAt > at);
      out.set(k, { outcome: joined ? "vindicated" : "pending", byNodeId: dn });
    } else {
      const proceeded = (stepCompletesByRun.get(runId) ?? [])
        .some((c) => c.stepTemplateId === stepIdentityOf(dn) && c.transition.createdAt > at);
      out.set(k, { outcome: proceeded ? "vindicated" : "pending", byNodeId: dn });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass.** `npx vitest run src/metrics/vindication.test.ts`; then `npx vitest run src/metrics` + `npx tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add apps/daemon/src/metrics/vindication.ts apps/daemon/src/metrics/vindication.test.ts
git commit -m "feat(metrics): deriveVindication — per-run downstream accept/bounce signal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire vindication into metrics + surface observational counts (no score change)

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (add `StepMetrics.vindication`)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (accept lookup, aggregate counts)
- Modify: `apps/daemon/src/metrics/usecases.ts` (load splits, derive, pass lookup — latest-version filtered)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts` + a `getTemplateMetricsDetail` E2E case

**Interfaces:**
- Contract: `StepMetrics.vindication: z.object({ vindicated: z.number().int().nonnegative(), bounced: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict().optional()`.
- `computeStepMetrics` input gains `vindicationByCompletion?: (t: TemplateTransition) => VindicationOutcome | undefined`.

- [ ] **Step 1: Add the contract field.** In `packages/contracts/src/metrics/index.ts`, add to `StepMetrics` (optional, so existing fixtures don't break):
```ts
  vindication: z.object({
    vindicated: z.number().int().nonnegative(),
    bounced: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }).strict().optional(),
```
Run `npx tsc --noEmit` (contracts + daemon) — expect clean (optional field).

- [ ] **Step 2: Write the failing aggregate test.** In `aggregate.steps.test.ts`, a step with two completions across two runs, a `vindicationByCompletion` predicate returning "vindicated" for one and "bounced" for the other → `step.vindication` equals `{ vindicated: 1, bounced: 1, pending: 0 }`.

- [ ] **Step 3: Run to verify it fails.** `npx vitest run src/metrics/aggregate.steps.test.ts` — FAIL (`vindication` undefined).

- [ ] **Step 4: Implement in `aggregate.ts`.** Add `vindicationByCompletion?` to the input type (~215). Over the step's `finalStepCompletes`, tally the outcomes and set `vindication` on the `StepMetrics` object literal (~531):
```ts
    const vindTally = { vindicated: 0, bounced: 0, pending: 0 };
    for (const t of finalStepCompletes) {
      const o = input.vindicationByCompletion?.(t);
      if (o === "vindicated") vindTally.vindicated++;
      else if (o === "bounced") vindTally.bounced++;
      else vindTally.pending++;
    }
```
and add `vindication: input.vindicationByCompletion ? vindTally : undefined,` to the `step` literal.

- [ ] **Step 5: Run to verify pass.** `npx vitest run src/metrics/aggregate.steps.test.ts`.

- [ ] **Step 6: Wire the real signal in `usecases.ts` (`getTemplateMetricsDetail`).**
  1. Load split decisions for the window: `const splitDecisions = listSplitDecisionsByTemplate(db, templateId, since, now);`
  2. **Version-safety:** filter gate + split decisions to latest version before deriving (mirror the existing `latestVersionGateDecisions` filter): `const latestSplits = splitDecisions.filter((d) => d.templateVersion === info.latestVersion);` and reuse `latestVersionGateDecisions`.
  3. `const vindication = deriveVindication({ transitions, gateDecisions: latestVersionGateDecisions, splitDecisions: latestSplits, graph });`
  4. Build the predicate keyed by `(runId, stepTemplateId)`, only crediting latest-version completions:
```ts
    const vindicationByCompletion = (t: TemplateTransition) => {
      const runId = t.transition.workflowRunId;
      if (runId == null || t.stepTemplateId == null || t.templateVersion !== info.latestVersion) return undefined;
      return vindication.get(`${runId}::${t.stepTemplateId}`)?.outcome;
    };
```
  5. Pass `vindicationByCompletion` into the `computeStepMetrics({ ... })` call.

- [ ] **Step 7: Write the E2E test** (extend `usecases.gate.test.ts` or new `usecases.vindication.test.ts`): seed a latest-version run with a step completion + an APPROVED gate decision for its downstream gate → `getTemplateMetricsDetail`'s step shows `vindication.vindicated === 1`. Add a version-safety case: an older-version run's completion → not counted (contributes to neither, i.e. the older completion isn't labeled).

- [ ] **Step 8: Verify + commit.** `npx vitest run src/metrics` (0 failures) + `npx tsc --noEmit`.
```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/usecases.ts packages/contracts/src/metrics/index.ts apps/daemon/src/metrics/aggregate.steps.test.ts <e2e test file>
git commit -m "feat(metrics): surface per-step vindication counts (observational; no score change)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification
- [ ] `npx vitest run src/metrics` — all pass. `npx vitest run src/workflows` — unaffected, still green. `npx tsc --noEmit` — clean.

## Self-review checklist (done)
- **Spec coverage:** downstream-vindication signal (2a) = Tasks 2–3; split-decision + gate-edge fetch = Task 1; version-safety = Task 3 Step 6; ask-stability (within-run redo = bounce) = the FINAL-completion labeling in Task 2 + gate-reject semantics. **Out of 2a scope (guardrail):** no `composedScore`/calibration/Beta change, no one-hop attenuation, no human-goal-change pivot — those are Phase 2b / refinements.
- **Type consistency:** `VindicationOutcome`/`VindicationResult` (Task 2) → `vindicationByCompletion` (Task 3) → `StepMetrics.vindication` (Task 3 contract). `SplitDecisionRow`/`selectedEdgeTo` (Task 1) consumed by Task 2.
- **`byNodeId`** is carried now (unused in 2a) specifically so Phase 2b can weight each vindication by that downstream node's confidence (one-hop attenuation) without re-deriving.
