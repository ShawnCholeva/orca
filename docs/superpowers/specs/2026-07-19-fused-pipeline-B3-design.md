# Fused Pipeline (Phase B3) — Design

**Date:** 2026-07-19
**Status:** Design — brainstormed, pending spec review
**Scope:** Phase B3 of the metrics health-console redesign (umbrella §6). Merge the Step and Gate panels into one **Pipeline** panel, rendering steps and gates in graph/flow order with gates inline at the transitions they guard. Sample drill-through (B4) is separate.

---

## 1. Context & the data

Today steps and gates live in two disconnected panels, so the workflow's *structure* — where a gate sits, what it guards — is invisible. The template's `graph_json` has everything to fix this: a topologically-ordered `nodes` array and `edges`.

**`orca/adaptive-delivery` graph** (confirmed):
- **nodes (in order):** `triage` (step) · `route` (splitter) · `clarify` · `research` · `proposal` (steps) · `critique` (gate) · `execution` (step) · `review`=Verify (gate) · `done` (step).
- **edges** encode flow: `route`→{clarify,research,proposal} (branch); `proposal`→`critique`→`execution`; `critique`→`proposal` (reject loop); `execution`→`review`→`done`; `review`→`execution` (reject loop).

So: the **node order is the pipeline order**; a gate's **`guards from → to`** = its incoming step edge + its forward out-edge (the target *later* in the order — the reject edge points *earlier*); a splitter's **`branchesTo`** = its out-edges.

### `agent-harness.pdf` alignment
- §3.4 PEV loop / §3.4.1: the harness as a plan→execute→verify pipeline with review gates between transitions — the fused view makes that control structure visible. Gates are the paper's human-review/verification checkpoints in the flow.

---

## 2. Goals & non-goals

### Goals
- One **Pipeline** panel: steps (B2 diagnosis cards) and gates interleaved in graph order.
- Gates render inline at their guard position with a **`guards {from} → {to}`** caption + their existing treatment (◈, Agent-reviewed, approval/loops, unproven/health, A-ii change-markers).
- The **splitter** (Route) renders as a thin **branch marker** ("Route — branches to Clarify · Research · Proposal"); branch steps follow in sequence (flatten-with-marker, per the umbrella v1 call).
- Retire the separate Gate panel.

### Non-goals
- No parallel-lane DAG layout (flatten-with-marker for v1).
- No change to the step card (B2) or gate row internals — only orchestration + the guards caption + the splitter marker.
- No scoring/model change; the reject/loop-back edges are not rendered as separate rows (implied by the gate).
- No sample drill-through (B4).

---

## 3. Design

### 3.1 Daemon — expose the pipeline ordering (contract additive, optional)

New contract type + optional field on `TemplateMetricsDetail`:
```ts
export const PipelineNode = z.object({
  nodeId: z.string(),
  name: z.string(),
  type: z.enum(["step", "gate", "splitter"]),
  guards: z.object({ from: z.string(), to: z.string() }).strict().optional(),   // gates: node ids
  branchesTo: z.array(z.string()).optional(),                                    // splitters: node ids
}).strict();
export type PipelineNode = z.infer<typeof PipelineNode>;
// on TemplateMetricsDetail:
pipeline: z.array(PipelineNode).optional(),
```
**Optional ⇒ no required-field ripple.** A `buildPipeline(graphJson)` (daemon) maps `nodes` (in stored order) → `PipelineNode[]`; for each **gate**, `guards.from` = the source of the edge whose target is the gate; `guards.to` = the gate's out-edge target that appears **later** in the node order (excludes the earlier-pointing reject edge); for each **splitter**, `branchesTo` = its out-edge targets. Names come from the graph node `name`. Attach in `usecases.ts` (parse `graph_json` — already read by `gateNodeNames`). Resilient: missing/malformed `graph_json` → `pipeline` omitted (desktop falls back).

### 3.2 Desktop — one Pipeline panel (`MetricsPage.tsx` + a small renderer)

- Replace the separate `StepPerformancePanel` + `GatePerformancePanel` with **one** panel that, when `detail.pipeline` is present, **iterates it in order**:
  - `type: "step"` → find the step metric (`steps[]` by `stepTemplateId === nodeId`) → render the existing **`StepRow`** (B2 card). If no metric (no runs this period), render a muted "no runs this period" row.
  - `type: "gate"` → find the gate metric (`gates[]` by `nodeId`) → render the existing **`GateRow`** + a `guards {fromName} → {toName}` caption (names resolved from the pipeline id→name map). If no metric, muted row.
  - `type: "splitter"` → render a thin **branch-marker** divider: "Route — branches to {branchesTo names joined by ·}".
- **Fallback:** when `detail.pipeline` is absent, keep today's two-panel layout (back-compat for templates without `graph_json`).
- Governance cards (completion gate, tool safety) stay below, unchanged.
- Jargon-free (`no-jargon` passes).

### 3.3 Backward-compat
Recompute-on-read; `pipeline` optional; desktop falls back to the two-panel layout when absent. No migration.

---

## 4. Testing & verification

- **Daemon (`buildPipeline`):** from a synthetic graph — node order preserved; a gate's `guards` = {incoming step, forward out-edge target}, excluding the earlier reject edge; a splitter's `branchesTo` = its out-edges; malformed/absent graph → pipeline omitted. Live shape: Critique `guards {proposal, execution}`, Verify `guards {execution, done}`, Route `branchesTo [clarify, research, proposal]`.
- **Contract:** `PipelineNode`/`pipeline` parse; optional (fixtures without it valid).
- **Desktop:** with a `pipeline`, the one panel renders steps + gates interleaved in order; the gate shows "guards Proposal → Execution"; the splitter shows its branch marker; a pipeline node with no metric renders a muted row; without `pipeline`, the two-panel fallback renders; `no-jargon` passes.
- **Live (needs daemon restart):** on Adaptive Delivery — a single Pipeline panel: Triage → Route (branch marker) → Clarify → Research → Proposal → **◈ Critique (guards Proposal → Execution)** → Execution → **◈ Verify (guards Execution → Done)** → Done. Gates keep their A-ii change-markers. Screenshot.

> **Contract note:** `pipeline` is OPTIONAL (no required-field ripple). The daemon emits it whenever `graph_json` parses.

---

## 5. Open items for the implementation plan
- Exact forward-edge selection when a gate has multiple forward out-edges (use the one whose target has the greater node-order index; if ties/none, omit `guards`).
- Where the branch-marker sits relative to the branch steps (before the first branch step) and its styling.
- Whether a pipeline node absent from the metrics (no runs) shows a muted placeholder or is skipped — default: muted placeholder so the structure stays visible.
- Confirm `MetricsPage` still handles loading/empty states with the merged panel.
