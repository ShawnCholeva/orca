# Node Confidence Model — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give **gates and splitters** a calibrated confidence — a gate's = **decision correctness** (false-accept primary), a splitter's = **branch-not-walked-back** — so every node on the pipeline is judgeable. Carry the `byNodeId` back-pointer through the new node-vindication so the full weighted-edge graph accrues for the deferred computed-confidence attenuation.

**Explicitly deferred (do NOT build here):** the **computed-confidence attenuation** (weighting a step's vindication by its downstream's *computed* score). The ground-truth pass confirmed that requires a topology-ordered, per-node-calibration scoring engine (the full-propagation architecture) — deferred to the autonomy-gating phase. Phase 3 only *captures the data + completes the edge graph* for it; the shipping attenuation stays the Phase-2b prior-weighted `vindicatorWeight`.

**Architecture:** Recompute-on-read, **no DB migration** (all retrospective signals already persist: `harness_transitions`, `workflow_gate_decisions` incl. `selected_edge_to`/`recommended_outcome`, `workflow_split_decisions` incl. `selected_branch`/`selected_edge_to`). Gate/splitter confidence is each node's **own** decision correctness, measured against the terminal anchor (`mark_done` = the goal shipped) — anchor-weighted, so no attenuation and no cross-node ordering is needed. Reuses the Phase-2b `Beta(α₀=prior·K, β₀)` machinery per node.

**Tech Stack:** TypeScript, Zod contracts, Vitest. Daemon `@orca/daemon`.

## Global Constraints

- **Recompute-on-read; NO migration.** All new fields are additive to `.strict()` Zod objects (`packages/contracts/src/metrics/index.ts`).
- **Anchor-based, no attenuation:** gate/splitter confidence is judged against `mark_done` (the run shipped) — the human anchor, weight 1.0. Do NOT introduce cross-node score ordering or computed-confidence weighting here (that's the deferred propagation phase).
- **`byNodeId` carried:** the new gate/splitter self-vindication must resolve and retain each node's own downstream (`byNodeId`) — the propagation-ready edge back-pointer — even though nothing consumes it for attenuation in Phase 3.
- **Additive only:** keep the existing `buildGateMetrics` health/overturn/groundedness/convergence/failureModes — add `confidence`, don't replace.
- **False-reject is deferred** — Phase 3 gate confidence is driven by **false-accept** (approval → did it hold up). Rejections feed only the existing context/rate fields.
- **Splitter confidence is coarse & retrospective-only** (`evaluate_split` is unwired in production) — mark it clearly; ship the honest backtrack signal.
- Deterministic; no LLM. Test runner from `apps/daemon`: run FULL `npx vitest run src/metrics` + `npx tsc --noEmit` (daemon + contracts + desktop) before every commit.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Tunable constants (flagged — data-refinable)
`GATE_CONFIDENCE_PRIOR` = worker 0.7 / shadow 0.55; `SPLITTER_CONFIDENCE_PRIOR` = 0.5; `NODE_PRIOR_STRENGTH K` = 4; `NODE_CONFIDENCE_MIN` (sample floor before `state="measured"`) = 5. These are starting priors that observed decision-correctness overrides — noted for review.

## File Structure
- `apps/daemon/src/metrics/node-vindication.ts` — CREATE: pure `deriveGateVindication` + `deriveSplitterVindication` (label each gate/splitter *decision* correct/incorrect/pending vs the terminal anchor; carry `byNodeId`).
- `apps/daemon/src/metrics/node-vindication.test.ts` — CREATE.
- `apps/daemon/src/metrics/verification.ts` — MODIFY (small): extract a reusable `betaMean(prior, K, pos, neg)` / `betaSampleSize` helper from the inline `computeCalibration` math (no behavior change) for per-node reuse.
- `apps/daemon/src/metrics/gate-metrics.ts` — MODIFY: compute per-gate decision-correctness Beta `confidence` from gate vindication; add to output.
- `apps/daemon/src/metrics/splitter-metrics.ts` — CREATE: `buildSplitterMetrics(...)` → per-splitter confidence.
- `apps/daemon/src/metrics/usecases.ts` — MODIFY: derive gate/splitter vindication, pass into `buildGateMetrics`/`buildSplitterMetrics`; add `detail.splitters`; populate the summaries-list `gateHealth` (close the doc-noted stub).
- `packages/contracts/src/metrics/index.ts` — MODIFY: add `GateMetrics.confidence`; add `SplitterMetrics` type + `TemplateMetricsDetail.splitters`.
- Test files as needed.

---

## Task 1: `node-vindication.ts` — gate & splitter self-vindication (with `byNodeId`)

**Files:** Create `node-vindication.ts` + `.test.ts`.

**Interfaces:**
```ts
export type NodeVindicationOutcome = "vindicated" | "false_accept" | "pending";
export type NodeVindicationResult = { outcome: NodeVindicationOutcome; byNodeId: string | null };
// key: `${workflowRunId}::${nodeId}::${traversalSeq}` — one label per gate/split DECISION.
export function deriveGateVindication(input: {
  transitions: TemplateTransition[]; gateDecisions: GateDecisionRow[]; graph: WorkflowGraph;
}): Map<string, NodeVindicationResult>;
export function deriveSplitterVindication(input: {
  transitions: TemplateTransition[]; splitDecisions: SplitDecisionRow[]; graph: WorkflowGraph;
}): Map<string, NodeVindicationResult>;
```

**Gate decision semantics (false-accept primary, anchored at `mark_done`):** for each gate decision `d` with `outcome === "approved"`:
- **vindicated** — a `mark_done` transition exists in the run at `createdAt > d.createdAt` (the approved work ultimately shipped);
- **false_accept** — no `mark_done` after `d`, but the run *terminally failed* after `d` (a `step_complete` with `telemetry.outcome.status === "failed"`, or a failed final step-run — reuse the existing hard-fail notion) at `createdAt > d.createdAt`;
- **pending** — otherwise (run still in progress / no terminal signal).
`byNodeId` = `resolveGateNext(graph, d.nodeId, "approved")`'s node id (the gate's own downstream on approval), or `null` if that resolves to a terminal. Rejected decisions are **not** labeled here (false-reject deferred) — they're already covered by `overturnRate`/`rejectRate` context.

**Splitter decision semantics (coarse backtrack, anchored at `mark_done`):** for each split decision `d`:
- **vindicated** — a `mark_done` after `d` AND no *later* split decision for the same `(run, nodeId)` with a **different** `selectedBranch` (the branch wasn't re-decided);
- **false_accept** (misroute) — a later split decision for the same `(run, nodeId)` with a different `selectedBranch` (the splitter re-routed → the first branch was abandoned), OR the run terminally failed after `d`;
- **pending** — otherwise.
`byNodeId` = `resolveSplitterNext(graph, d.nodeId, d.selectedBranch)`'s node id.

- [ ] **Step 1: failing tests** — build a small graph (proposal→critique(gate)→execution→review(gate)→done + a triage→route(splitter)→… slice) and per-run transitions/decisions using the `as never` fixture idiom (mirror `vindication.test.ts`). Cover, for gates: approval→mark_done ⇒ vindicated; approval→terminal-fail ⇒ false_accept; approval, run in progress ⇒ pending; rejection ⇒ not in map. For splitters: route→mark_done, no re-decide ⇒ vindicated; two split decisions same run/node different branch ⇒ false_accept; route, in progress ⇒ pending. Assert `byNodeId` is the resolved downstream in each.
- [ ] **Step 2: RED** — `npx vitest run src/metrics/node-vindication.test.ts`.
- [ ] **Step 3: implement** `node-vindication.ts`. Reuse `deriveVindication`'s per-run/per-node indexing patterns (createdAt-ordered, `.localeCompare(...) > 0`); use `resolveGateNext`/`resolveSplitterNext` from `../workflows/graph/graph-routing.js` for `byNodeId`; import `SplitDecisionRow`/`GateDecisionRow` from `./fetch.js`.
- [ ] **Step 4: GREEN** + full `npx vitest run src/metrics` + `npx tsc --noEmit`.
- [ ] **Step 5: commit** `feat(metrics): deriveGate/SplitterVindication — node decision-correctness (byNodeId-carrying)`.

---

## Task 2: Gate confidence — decision-correctness Beta in `buildGateMetrics`

**Files:** `verification.ts` (extract `betaMean` helper), `gate-metrics.ts`, `packages/contracts/src/metrics/index.ts`, tests.

**Interfaces (contract):** add to `GateMetrics`:
```ts
  confidence: z.object({
    value: z.number().nullable(),           // decision-correctness posterior mean (0..1), null when no labels
    sampleSize: z.number().int().nonnegative(), // # labeled (non-pending) approval decisions
    state: z.enum(["measured", "insufficient"]),
  }).strict(),
```
(Keep the existing `confidence: z.enum(["low","ok"])` field? — it currently means overturn-sample adequacy. To avoid a name clash, name the new field **`decisionConfidence`**.)

- [ ] **Step 1: extract `betaMean` helper (no behavior change).** In `verification.ts`, factor the inline Beta math into `export function betaMean(prior: number, k: number, pos: number, neg: number): number` and `betaSampleSize(pos, neg)`; have `computeCalibration` call them. Run full `src/metrics` — must be **unchanged** (pure refactor; if any value shifts, the extraction is wrong).
- [ ] **Step 2: failing tests** — `buildGateMetrics` with a gate vindication map (`deriveGateVindication` output) where a gate's approvals are mostly `false_accept` → `decisionConfidence.value` below the gate prior; mostly `vindicated` → above; <5 labels → `state: "insufficient"`.
- [ ] **Step 3: RED.**
- [ ] **Step 4: implement.** Add `gateVindication?: Map<string, NodeVindicationResult>` to `buildGateMetrics`'s input. Per gate node, over its labeled approval decisions: `pos = #vindicated`, `neg = #false_accept`, `value = betaMean(GATE_CONFIDENCE_PRIOR[evalSubstrate], K, pos, neg)`, `sampleSize = pos+neg`, `state = sampleSize >= NODE_CONFIDENCE_MIN ? "measured" : "insufficient"`. Emit `decisionConfidence`. Leave `health`/`scored`/etc. untouched. Add the contract field.
- [ ] **Step 5: GREEN** + full `src/metrics` (update the gate fixtures that now need `decisionConfidence`) + `npx tsc --noEmit`.
- [ ] **Step 6: commit** `feat(metrics): gate decision-correctness confidence (false-accept Beta)`.

---

## Task 3: Splitter scoring — `SplitterMetrics` + `buildSplitterMetrics` + `detail.splitters`

**Files:** Create `splitter-metrics.ts`; `packages/contracts/src/metrics/index.ts` (`SplitterMetrics` + `TemplateMetricsDetail.splitters`); tests.

**Interfaces (contract):**
```ts
export const SplitterMetrics = z.object({
  nodeId: z.string(), name: z.string(),
  confidence: z.object({ value: z.number().nullable(), sampleSize: z.number().int().nonnegative(), state: z.enum(["measured","insufficient"]) }).strict(),
  decisions: z.number().int().nonnegative(),
  misrouteRate: z.number().nullable(),        // false_accept / labeled
  retrospectiveOnly: z.literal(true),         // honest marker: evaluate_split unwired
  versionHistory: NodeVersionHistory.optional(),
}).strict();
```
`buildSplitterMetrics(input: { splitDecisions, splitterVindication, names, lineage? }): SplitterMetrics[]` — per splitter node: `value = betaMean(SPLITTER_CONFIDENCE_PRIOR, K, #vindicated, #false_accept)`, `misrouteRate = false_accept/labeled`.

- [ ] **Step 1: failing tests** — a splitter with mostly-`false_accept` decisions → low `confidence.value`, `misrouteRate` high; mostly `vindicated` → high; assert `retrospectiveOnly: true`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: implement** `splitter-metrics.ts` + the contract type + `TemplateMetricsDetail.splitters: z.array(SplitterMetrics)` (optional or required-with-default — match how `gates` is typed).
- [ ] **Step 4: GREEN** + full `src/metrics` + `npx tsc --noEmit`.
- [ ] **Step 5: commit** `feat(metrics): splitter confidence (branch-not-walked-back, retrospective-only)`.

---

## Task 4: Wire into the detail + summary gateHealth stub + E2E

**Files:** `usecases.ts`, tests.

- [ ] **Step 1: implement wiring** in `getTemplateMetricsDetail`:
  1. `const gateVindication = deriveGateVindication({ transitions, gateDecisions: latestVersionGateDecisions, graph });` and `const splitterVindication = deriveSplitterVindication({ transitions, splitDecisions: latestSplits, graph });` (reuse the latest-version-filtered decisions already computed for the vindication feed — version-safety).
  2. Pass `gateVindication` into `buildGateMetrics`; call `buildSplitterMetrics(...)`; add `splitters` to the returned `TemplateMetricsDetail`.
  3. **Close the summaries-list stub:** in `getTemplateMetricsSummaries` (the list path where `gateHealth` is still `{value:null,...}`), populate it the same way the detail does IF the data is cheaply available — otherwise leave a one-line comment that the list intentionally stays null (a summaries-list request may not load the graph/decisions). Pick the cheaper honest option and note it.
- [ ] **Step 2: E2E test** in `usecases.*.test.ts` (DB-backed): seed a gate with approvals that reach `mark_done` (vindicated) vs a run that terminally fails after approval (false_accept) → `detail.gates[].decisionConfidence` reflects it; seed a splitter re-decision → `detail.splitters[].misrouteRate`. Version-safety: older-version decisions don't leak.
- [ ] **Step 3: verify** full `npx vitest run src/metrics` + `npx vitest run src/workflows` + `npx tsc --noEmit` (daemon + contracts + desktop — new contract fields; update any `TemplateMetricsDetail`/`GateMetrics` fixture that needs `decisionConfidence`/`splitters`).
- [ ] **Step 4: commit** `feat(metrics): wire gate/splitter confidence into the detail; splitters surface`.

---

## Governance & alignment (agent-harness.pdf)

Consistent with Phase 2b's stance: the gate/splitter confidence is **advisory** (Metrics tab / drawer only — never a gate/route/completion decision), **bounded** (Beta over anchored labels, sample-floored), and **inspectable** (`decisionConfidence`/`misrouteRate` + sample sizes exposed). Paper §5.2.2: *verification strength incl. **rate of false acceptance*** is an explicit evaluation dimension — a gate's false-accept rate is exactly that signal made first-class. §5.2.2: *"each feedback signal should expose its scope and uncertainty"* — the `retrospectiveOnly` marker + `state`/`sampleSize` do this honestly for the coarse splitter signal. Do NOT wire any of these confidences into an advancement/completion/permission path.

## Final verification
- [ ] Full `src/metrics` + `src/workflows` + `tsc` (daemon/contracts/desktop) green. A template with no gate/split decisions yields empty/`insufficient` node confidences (no crash), and existing step scores are **unchanged** (Phase 3 adds node scoring; it must not touch `composedScore`/step calibration).

## Self-review checklist (done)
- **Spec coverage:** gates scored on decision correctness (false-accept) = Tasks 1–2; splitters on branch-not-walked-back = Tasks 1,3; `gateHealth` summary stub = Task 4; `byNodeId` propagation-readiness = Task 1. **Deferred (guardrail):** computed-confidence attenuation, false-reject, and the topology-ordered propagation engine — NOT in this phase.
- **No step-score movement:** Phase 3 must not change `composedScore`/`computeCalibration`/step scores — an explicit final check.
- **Type consistency:** `NodeVindicationResult` (T1) → `buildGateMetrics`/`buildSplitterMetrics` (T2/T3) → `usecases` wiring (T4). `betaMean` extraction is behavior-preserving.
