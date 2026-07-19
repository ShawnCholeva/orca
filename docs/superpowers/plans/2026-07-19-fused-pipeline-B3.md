# Fused Pipeline B3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Step and Gate panels into one Pipeline panel that renders steps and gates in graph/flow order, gates inline at the transition they guard.

**Architecture:** The daemon derives an ordered `pipeline` (node order + gate guards + splitter branches) from `graph_json` and exposes it as an optional field. The desktop iterates it, reusing `StepRow` (B2 card) and `GateRow`, with a splitter branch-marker and a `guards {from}→{to}` caption on gates; falls back to today's two panels when `pipeline` is absent.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`packages/contracts`, `apps/daemon`, `apps/desktop`).

**Design spec:** `docs/superpowers/specs/2026-07-19-fused-pipeline-B3-design.md`. **Mockup reference:** `scratchpad/metrics-redesign.html` (the fused pipeline + `GATE` caption + branch marker).

## Global Constraints

- `pipeline` is **OPTIONAL** on `TemplateMetricsDetail` (no required-field ripple); desktop falls back to the two-panel layout when absent.
- Node **order** = the `graph_json` `nodes` array order. Gate **`guards`** = `{from: source of the edge into the gate, to: the gate's out-edge target with the greatest node-order index > the gate's index}` (excludes the earlier-pointing reject edge; if no later target, omit `guards`). Splitter **`branchesTo`** = the splitter's out-edge targets.
- Type normalization: `"gate"`→gate, `"splitter"`→splitter, everything else (`step`, `delegate`, unknown)→`"step"` (keeps every node visible; a node with no metric renders a muted row).
- Resilient: missing/malformed `graph_json` → `pipeline` omitted (no throw).
- No change to `StepRow`/`GateRow` internals beyond an optional `guards` caption on `GateRow`; no scoring/model change.
- Jargon-free (`no-jargon` passes).

---

### Task 1: Daemon — `buildPipeline` + `pipeline` field (contract + daemon)

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (`PipelineNode` type + optional `pipeline` on `TemplateMetricsDetail`)
- Create: `apps/daemon/src/metrics/pipeline.ts` (`buildPipeline`)
- Modify: `apps/daemon/src/metrics/usecases.ts` (read `graph_json`, attach `pipeline` to the detail)
- Test: `apps/daemon/src/metrics/pipeline.test.ts`

**Interfaces:**
- Produces: `buildPipeline(graphJson: string | null): PipelineNode[] | undefined`; `TemplateMetricsDetail.pipeline?: PipelineNode[]`.

- [ ] **Step 1: Contract**

```ts
export const PipelineNode = z.object({
  nodeId: z.string(),
  name: z.string(),
  type: z.enum(["step", "gate", "splitter"]),
  guards: z.object({ from: z.string(), to: z.string() }).strict().optional(),
  branchesTo: z.array(z.string()).optional(),
}).strict();
export type PipelineNode = z.infer<typeof PipelineNode>;
```
Add `pipeline: z.array(PipelineNode).optional(),` to `TemplateMetricsDetail`.

- [ ] **Step 2: Write the failing test**

`pipeline.test.ts` — feed a synthetic graph mirroring Adaptive Delivery:
```ts
const graph = JSON.stringify({
  nodes: [
    { id: "triage", type: "step", name: "Triage" },
    { id: "route", type: "splitter", name: "Route" },
    { id: "clarify", type: "step", name: "Clarify" },
    { id: "research", type: "step", name: "Research" },
    { id: "proposal", type: "step", name: "Proposal" },
    { id: "critique", type: "gate", name: "Critique" },
    { id: "execution", type: "step", name: "Execution" },
    { id: "review", type: "gate", name: "Verify" },
    { id: "done", type: "step", name: "Done" },
  ],
  edges: [
    { from: "triage", to: "route" }, { from: "route", to: "clarify" }, { from: "route", to: "research" }, { from: "route", to: "proposal" },
    { from: "clarify", to: "research" }, { from: "research", to: "proposal" },
    { from: "proposal", to: "critique" }, { from: "critique", to: "execution" }, { from: "critique", to: "proposal" },
    { from: "execution", to: "review" }, { from: "review", to: "done" }, { from: "review", to: "execution" },
  ],
});
const p = buildPipeline(graph)!;
expect(p.map((n) => n.nodeId)).toEqual(["triage","route","clarify","research","proposal","critique","execution","review","done"]); // order preserved
expect(p.find((n) => n.nodeId === "critique")!.guards).toEqual({ from: "proposal", to: "execution" }); // forward edge, not the reject loop
expect(p.find((n) => n.nodeId === "review")!.guards).toEqual({ from: "execution", to: "done" });
expect(p.find((n) => n.nodeId === "route")!.branchesTo).toEqual(["clarify","research","proposal"]);
expect(buildPipeline(null)).toBeUndefined();
expect(buildPipeline("{not json")).toBeUndefined();
```

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @orca/daemon test -- pipeline`.

- [ ] **Step 4: Implement `buildPipeline`**

```ts
import type { PipelineNode } from "@orca/contracts";

export function buildPipeline(graphJson: string | null): PipelineNode[] | undefined {
  if (!graphJson) return undefined;
  let graph: { nodes?: { id: string; type: string; name?: string }[]; edges?: { from: string; to: string }[] };
  try { graph = JSON.parse(graphJson); } catch { return undefined; }
  const nodes = graph.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const norm = (t: string): "step" | "gate" | "splitter" => (t === "gate" ? "gate" : t === "splitter" ? "splitter" : "step");
  return nodes.map((n) => {
    const base: PipelineNode = { nodeId: n.id, name: n.name ?? n.id, type: norm(n.type) };
    if (n.type === "gate") {
      const from = edges.find((e) => e.to === n.id)?.from;
      const gi = idx.get(n.id) ?? -1;
      const to = edges.filter((e) => e.from === n.id && (idx.get(e.to) ?? -1) > gi)
        .sort((a, b) => (idx.get(b.to)! - idx.get(a.to)!))[0]?.to ?? edges.find((e) => e.from === n.id)?.to;
      return from && to ? { ...base, guards: { from, to } } : base;
    }
    if (n.type === "splitter") {
      const branchesTo = edges.filter((e) => e.from === n.id).map((e) => e.to);
      return branchesTo.length ? { ...base, branchesTo } : base;
    }
    return base;
  });
}
```

- [ ] **Step 5: Wire into `usecases.ts`**

In `getTemplateMetricsDetail`, read `graph_json` (a query like `gateNodeNames` already does) and set `pipeline: buildPipeline(graphJson)` on the returned detail.

- [ ] **Step 6: Run tests + full daemon/contracts green** — `pnpm --filter @orca/daemon test -- pipeline`, then `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/contracts typecheck`. (Optional field ⇒ no fixture ripple.)

- [ ] **Step 7: Commit** — `git commit -m "feat(metrics): derive pipeline ordering (steps + gates + splitter) from graph"`

---

### Task 2: Desktop — one fused Pipeline panel

**Files:**
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (render one Pipeline panel from `detail.pipeline`; fallback to the two panels)
- Modify: `apps/desktop/src/metrics/GatePerformance.tsx` (`GateRow` gains optional `guards?: { from: string; to: string }` caption; export a `FusedPipelinePanel` or render inline)
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` if `StepRow` needs a "no metric" muted variant
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx` (+ `no-jargon.test.tsx` stays green)

**Interfaces:**
- Consumes: `detail.pipeline` (Task 1), `detail.steps`, `detail.gates`. Reuses `StepRow`/`GateRow`.

- [ ] **Step 1: Write the failing render test**

In `MetricsPage.test.tsx`, mock a detail with a `pipeline` (steps + a gate with `guards` + a splitter with `branchesTo`) plus matching `steps`/`gates`, and assert:
- steps and gates render **interleaved in pipeline order** (e.g. the Critique gate row appears between the Proposal step and the Execution step in the DOM);
- the gate shows a caption "guards Proposal → Execution";
- the splitter renders a branch marker containing "branches to" + the branch names;
- with **no** `pipeline`, the two-panel fallback renders (Step performance + Gates panels present).

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @orca/desktop test -- MetricsPage`.

- [ ] **Step 3: Implement**

- `GateRow`: add optional `guards?: { from: string; to: string }`; when present, render a muted caption `guards {from} → {to}` in the name line (mirror the A-ii `vchip` placement).
- New `FusedPipelinePanel({ detail, openStep, onToggleStep, openGate, onToggleGate })` (in `GatePerformance.tsx` or a new file): if `detail.pipeline` present, build an id→name map from `pipeline`; iterate `pipeline` in order — `type:"step"` → find `steps.find(s => s.stepTemplateId === nodeId)` → `StepRow` (or a muted "no runs this period" row if absent); `type:"gate"` → find `gates.find(g => g.nodeId === nodeId)` → `GateRow` with `guards` resolved to names via the map (muted row if absent); `type:"splitter"` → a thin branch-marker divider "`{name} — branches to {branchesTo names joined by " · "}`". Track a running index for `isLast`.
- `MetricsPage.tsx`: replace the `<StepPerformancePanel/>` + `<GatePerformancePanel/>` pair with: `detail?.pipeline ? <FusedPipelinePanel …/> : (<><StepPerformancePanel…/><GatePerformancePanel…/></>)`. Keep `PolicyGatewayReadout`/`CompletionGateReadout` below.

- [ ] **Step 4: Run desktop tests + typecheck + no-jargon** — `pnpm --filter @orca/desktop test && pnpm --filter @orca/desktop typecheck`. Green.

- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): fused pipeline panel — steps + inline gates in flow order"`

---

### Task 3: Verify — full workspace, whole-branch review, live check

- [ ] **Step 1:** `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test` — all green.
- [ ] **Step 2:** Whole-branch review (base = commit before Task 1 .. HEAD). Verify: `buildPipeline` order + gate guards (forward edge, not reject loop) + splitter branches; `pipeline` optional (no ripple); resilient parse; the desktop interleaves in order, gate caption correct, splitter marker, muted rows for missing metrics, two-panel fallback when absent; no scoring/model change; `no-jargon` passes. Feed the ledger's Minor list.
- [ ] **Step 3:** Live check (needs daemon restart — ask user). On Adaptive Delivery: one Pipeline panel — Triage → Route (branch marker) → Clarify → Research → Proposal → **◈ Critique (guards Proposal → Execution)** → Execution → **◈ Verify (guards Execution → Done)** → Done; gates keep A-ii change-markers; the separate Gates panel is gone. Screenshot.
- [ ] **Step 4:** Mark B3 complete in the ledger + update `metrics-health-console-redesign.md`. Next: B4 (sample drill-through).

---

## Self-Review

**Spec coverage:** pipeline derivation (Task 1) with the exact guards rule (forward edge by node-order index) + splitter branches; desktop merge + interleave + gate caption + splitter marker + fallback (Task 2); live confirmation of the ordered pipeline (Task 3). All spec §3 items map to a task.

**Placeholder scan:** `buildPipeline` is complete code; the test names concrete expected order/guards/branches; the desktop iteration rule is explicit (find-by-id, muted-if-absent, splitter marker). Reuses existing `StepRow`/`GateRow`.

**Type consistency:** `PipelineNode` shape identical in contract + `buildPipeline` return; `type` normalization keeps the enum valid; `guards` carries node ids from the daemon, resolved to names on the desktop via the pipeline id→name map; `pipeline` optional on `TemplateMetricsDetail`.
