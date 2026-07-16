# Gate & Policy-Gateway Telemetry as First-Class Metrics Components (Scoring Evolution — Phase 1)

**Date:** 2026-07-16
**Status:** Design — approved, pending spec review
**Scope:** Phase 1 of a three-phase evolution of the Metrics-tab scoring, learning, and self-improvement system.

---

## 1. Context & motivation

Recent orchestrator work made **gates** first-class workflow nodes (shadow/worker `evalSubstrate`), with their own evaluation proposals (`approved`/`rejected`, `residualRisks`, `issueRefs`), reject-loops bounded by `GATE_REJECT_CAP = 3` + an `issueRefsEqual` stagnation signal, supervised human parks (`PendingGateReview`), and structured evidence bundles. In parallel, tool calls pass through a **policy gateway** (`RiskFacet.gate_decision` = `allow` | `require_approval` | `deny`).

The Metrics tab's scoring model, however, was built entirely around `step_complete` transitions. It has **no model of gates as components**. Today a gate node's surrogate step-run (`step_template_id = "__gate__:<nodeId>"`) falls through `computeStepMetrics`, renders with the raw internal id (e.g. `__gate__:review`), and is scored with completion machinery it doesn't fit — so it reads "No check yet." None of the gate-native signal (approval vs reject, loop convergence, reviewer overturn, residual-risk burden, evidence adequacy) is surfaced, scored, or available to the learning loop.

### Alignment with `agent-harness.pdf`

This work executes the paper's Agentic Harness Engineering (AHE) model directly:

- **§3.5.1 — deep telemetry as the optimization substrate.** The paper names three complementary telemetry channels: *evaluators* (task-level regressions), *tracing stacks* (trajectory-level causes), *policy gateways* (boundary violations). Orca has the evaluator channel richly (step scores/tiers/calibration) but the **tracing** and **policy-gateway** channels are captured yet invisible. Phase 1 lights them up.
- **§5.2.7 / §5.1.1 — metrics that isolate harness components.** You cannot score, diagnose, or evolve a component you can't isolate. Gates must become distinct telemetry entities before Phases 2–3 can act on them.
- **What makes a verifier/gate "good" (paper-derived, not intuition):**
  - **§5.2.3** — the cardinal verifier sin is *"accepting underspecified solutions"* (false acceptance). The independent check on it is **reviewer overturn**. → dominant score term.
  - **§3.4.4 / §5.1.1** — verification must be grounded in **deterministic sensors**, not critique alone; the **oracle-adequacy crisis** is the key open verifier problem. → **evidence-groundedness** score term.
  - **§3.4.4** — termination *"governed by verification … or when human review is required,"* with *"premature termination"* and *"over-permissive"* named as failure clusters. → **convergence + honest escalation** score term.
  - Residual-risk burden and raw approval/reject balance are **not** verifier-quality axes in the paper (rejecting weak work is the gate's job) → rendered as context, not scored. §5.2.2 frames the evidence bundle (checks run, assumptions, untested regions, **remaining risks**) as an *inspectable contract*, not a grade — reinforcing residual-risk-as-context.
- **§5.2.1 — evaluation dimensions are distinct, not one blended number.** The paper lists six: (i) trajectory efficiency (tool calls, **tokens**, wall-clock), (ii) verification strength (coverage, oracle diversity, **rate of false acceptance**), (iii) recovery, (iv) state consistency, (v) safety compliance, (vi) **replayability** (trajectory reconstructable/auditable from artifacts). Two consequences for gates: **cost/efficiency (i) is a separate axis from correctness (ii)** — so gate cost is surfaced but never folded into gate *health*; and every scored signal must be **replayable** — linked to the concrete decision artifacts behind it.
- **§5.2.7 — the four target properties.** A good harness surface is **executable** (evidence-grounded), **inspectable** (exposes provenance + failure causes), **stateful** (version-comparable), and **governed**. Phase 1 hits all four for gates: groundedness (executable), artifact-linked scored terms + failure-mode taxonomy (inspectable), version deltas (stateful), and the append-only capture fix + read-only aggregation (governed).

### Phase sequence (this spec = Phase 1)

1. **Phase 1 (this doc).** Isolate + score + surface gates and the policy gateway as first-class components.
2. **Phase 2.** Honest evidence/measurement scoring — fold oracle-adequacy / sensor-coverage / grounding / untested-regions into the score; surface the deterministic completion gate.
3. **Phase 3.** Extend the Evolution Agent (existing change-contract learning loop) to propose gate/validator/retry-limit revisions under the same governed-mutation + falsifier + rollback discipline.

Each phase is its own spec → plan → build.

---

## 2. Goals & non-goals

### Goals
- Gate nodes stop rendering as fake step rows; they become isolated, named, first-class telemetry components.
- A **gate-health** score exists, composed per the paper (overturn-dominant, then groundedness, then convergence), with the honest-null discipline the step score already uses.
- The **policy-gateway** channel (tool-gate decisions) is surfaced with over-permissive flagging.
- The overturn signal is **captured** so false acceptance is computable going forward.
- The top-line shows **Step health** and **Gate health** as two distinct readouts — never blended.

### Non-goals (Phase 1)
- Folding gate health into a single blended workflow number (rejected: violates paper's "isolate components").
- Evidence-depth changes to the *step* score (Phase 2).
- The deterministic completion gate as a scored surface (Phase 2).
- Any learning-loop / Evolution-Agent extension to gates (Phase 3).
- Recalibrating score coefficients or `TIER_CONFIDENCE`.
- Backfilling overturn for historical traversals (impossible — the data was discarded; honest-null covers it).

---

## 3. Telemetry-capture fix (prerequisite — paper §3.5.1)

**Problem.** In supervised mode the gate's *proposed* verdict (`recommendedOutcome`) lives only in the transient stash `workflow_runs.pending_gate_route_json`. `DispatchEngine.decideGate` (`apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:~2736`) sets that column to `NULL` **before** `recordGateDecision` writes the single `workflow_gate_decisions` row — whose `outcome` holds the **human's** decision (Y). The gate's proposal (X) is destroyed. `X≠Y` (overturn) is unrecoverable.

**Fix (minimal, surgical).**
- **Migration** (next number after `0056`): add nullable columns to `workflow_gate_decisions`:
  - `recommended_outcome TEXT` (`'approved'|'rejected'|NULL`) — the gate's proposal at a supervised traversal.
  - `recommended_reason TEXT NULL`, `recommended_issue_refs_json TEXT NULL` — the proposal's supporting detail (for the reject-reason clusters).
  - Nullable so historical rows and automated-path rows (where no human overturn exists) stay valid.
- **Write change** (`decideGate`): read the stashed `recommendedOutcome`/reason/issueRefs from `pending_gate_route_json` and pass them into `recordGateDecision` **before** nulling the stash. Extend `GateDecisionInput` + the `recordGateDecision` INSERT (`apps/daemon/src/workflows/gates/usecases.ts:31-58`) with the three new fields.
- **Automated path** (`applyGateProposal`) writes `outcome = proposal.outcome` with no human — leave `recommended_outcome = NULL` there (no overturn concept applies).

**Overturn definition.** For a supervised `workflow_gate_decisions` row with a non-null `recommended_outcome`: `overturned = (recommended_outcome !== outcome)`. `overturnRate = overturned_count / rows_with_recommended_outcome`.

---

## 4. Contracts (`packages/contracts/src/metrics/index.ts`)

### 4.1 `GateMetrics` (per gate node)

```
GateMetrics {
  nodeId: string
  name: string                     // resolved from the workflow graph node — no "__gate__:" leak
  evalSubstrate: "shadow" | "worker"
  health: number | null            // 0..100; null when overturn coverage is insufficient (honest-null)
  grade: "A"|"B"|"C"|"D"|"F" | null
  confidence: "low" | "ok"
  sampleSize: number               // total decisions in window
  delta: number | null             // latest-vs-prior version health delta (null unless both sides have samples)

  // Scored terms (paper-ordered weighting; overturn dominant). Each carries the
  // concrete decision ids behind it (§3.5.1 artifact-linked, §5.2.1(vi) replayable).
  scored: {
    overturnRate: number | null        // §5.2.3 false acceptance; null when no supervised-with-recommendation samples
    overturnSampleSize: number         // rows with a recommended_outcome (the coverage denominator)
    overturnDecisionIds: string[]      // workflow_gate_decisions ids where recommended_outcome != outcome (≤ audit cap)
    groundedness: number | null        // §3.4.4/§5.1.1 share of decisions on adequate evidence (sensors present + oracleAdequacy.sufficient)
    ungroundedDecisionIds: string[]    // ids of blind/weak-oracle approvals (≤ audit cap)
    convergence: number | null         // §3.4.4 termination discipline; see 5.2
    limitingTerm: "overturn" | "groundedness" | "convergence" | null
  }

  // Cost — §5.2.1(i) trajectory efficiency. A SEPARATE axis from health (§5.2.1):
  // never folded into the grade — a cheap wrong gate is not a good gate. Exposes the
  // §3.5.1 signal "budget consumed without improving verification outcomes".
  cost: {
    p50LatencyMs: number | null
    meanTokens: number | null          // per resolution, loop-multiplied (worker gates dominate)
    meanUsd: number | null
    tokensSpentOnOverturned: number | null   // budget spent on decisions a human later overturned — the paper's "budget without improving verification"
  }

  // Failure-mode taxonomy — §3.5.1 "failure traces cluster recurring patterns";
  // feeds Phase 3 Evolution-Agent diagnosis (§3.5.2 "attribute failures to components").
  // Readable labels via a gate failure-label catalog (mirrors the step catalog).
  failureModes: { label: string, count: number, pct: number, sampleDecisionIds: string[] }[]
  //   overturned_approve (false acceptance) · blind_approve (ungrounded) ·
  //   cap_hit / stagnation (non-convergence) · reviewer_unavailable_park (honest, NOT a failure)

  // Context (displayed, never scored)
  context: {
    approvalRate: number | null
    rejectRate: number | null
    decisions: number
    meanLoops: number | null           // mean traversals to resolution
    capHitRate: number | null          // share hitting GATE_REJECT_CAP
    stagnationRate: number | null      // share tripping issueRefsEqual
    parkRate: number | null            // supervised-park share
    residualRiskBurden: number | null  // mean residual-risk count carried at approval
    recentRejectReasons: { at: string, reason: string, issueRefs: string[] }[]  // ≤3
  }

  trend: number[]                      // health sparkline
  versionBoundaries: number[]
}
```

### 4.2 `PolicyGatewayMetrics` (per template — tool-gate channel)

```
PolicyGatewayMetrics {
  decisionDist: Record<"allow"|"require_approval"|"deny", number>   // aggregated across steps
  overPermissive: {
    count: number                      // allow decisions at high/critical risk_class
    sampleTransitionIds: string[]
  }
  boundaryViolations: FailureCluster[] // reuse existing FailureCluster shape, boundary = "tool_gate"
}
```

### 4.3 Summary/detail additions

- `TemplateMetricsSummary` gains `gateHealth: { value: number | null, grade: string | null, delta: number | null, confidence: "low"|"ok" }`.
- `TemplateMetricsDetail` gains `gates: GateMetrics[]` and `policyGateway: PolicyGatewayMetrics`.
- Existing `stepHealth` / workflow-health path stays **step-only** (the isolation invariant). The desktop `workflowHealthFromSteps` helper is unchanged; a sibling `gateHealth` value comes straight from the summary.

---

## 5. Daemon aggregation (`apps/daemon/src/metrics`)

### 5.1 Isolate gates out of the step path
In `computeStepMetrics` (`aggregate.ts:227`), skip transitions/step-runs whose `stepTemplateId` starts with `"__gate__:"`. Gates leave `steps[]` entirely. (The projection already excludes gate surrogates from the workspace tracker — `steps/projection.test.ts:132` — so this brings metrics into line.)

### 5.2 `buildGateMetrics()` — pure function
Inputs: `workflow_gate_decisions` rows (in window, per node), the gate surrogate step-runs (for loops/attempts), and the reviewed step's `EvidenceFacet` + `RefuteFacet` (for groundedness). Per gate node:
- **overturnRate / overturnSampleSize** — from `recommended_outcome` vs `outcome` (§3).
- **groundedness** — share of decisions where the reviewed evidence had `sensorsRun` present **and** `oracleAdequacy.sufficient` (evidence-grounded vs rubber-stamp). Reuses `classifyTier` inputs.
- **convergence** — a bounded composite: high when mean-loops ≈ 1, cap-hit and stagnation rates ≈ 0, and supervised escalation is honest (parked-when-required counts as *good*, not penalized). Low when loops trend toward `GATE_REJECT_CAP` or stagnation trips.
- **health** — weighted composite, overturn-dominant, then groundedness, then convergence. **Cost is NOT an input to health** (§5.2.1 — efficiency is a distinct axis from correctness). **Honest-null:** when `overturnSampleSize` is below the coverage floor (reuse `SAMPLE_MIN` / `VERSION_MIN` spirit), `overturnRate` is null and `health` renders **null → "unproven"** in the UI (an unmeasured gate is not a healthy gate — mirrors `verifiedSampleSize == 0` ⇒ "unverified" for steps). Exact weights specified in the implementation plan; the ordering (overturn ≫ groundedness > convergence) is fixed here.
- **cost** — from the gate transition's `telemetry` facet (latency/tokens/usd), summed across a resolution's loops; `tokensSpentOnOverturned` sums tokens over decisions whose `recommended_outcome != outcome`. Surfaced as its own readout, never folded into health.
- **failureModes** — cluster decisions into the taxonomy (`overturned_approve`, `blind_approve`, `cap_hit`, `stagnation`; `reviewer_unavailable_park` tracked but flagged honest, not a failure), each with `sampleDecisionIds`. Readable labels via a new gate failure-label catalog mirroring `metrics/failure-labels`.
- **artifact links** — populate `overturnDecisionIds` / `ungroundedDecisionIds` (≤ audit cap) so every scored term drills to its `workflow_gate_decisions` rows (§3.5.1 replayable).
- **name** — resolve `nodeId` against the workflow graph node's label; never emit `__gate__:`.

### 5.3 `buildPolicyGatewayMetrics()` — pure function
Aggregate the per-step `risk.gate_decision` facets (already summed per step at `aggregate.ts:383`) to a template-level `decisionDist`; flag `allow` at high/critical `risk_class` as `overPermissive`; cluster `deny`/`require_approval` by failure code into `boundaryViolations`.

### 5.4 Wiring
`GET /v1/metrics/templates/{id}` detail builder attaches `gates` + `policyGateway`; the summary builder attaches `gateHealth`. No new routes.

---

## 6. Desktop UI (`apps/desktop/src/metrics`)

- **Top strip:** replace the single `Workflow health` tile with **Step health** + **Gate health** (two `StatTile`s, each grade + delta), keeping First-pass / Self-recovered / Escalated. Step health = existing `workflowHealthFromSteps`; Gate health = `summary.gateHealth`.
- **Gates section** (new, below Step performance): one row per `GateMetrics` — status-colored node badge, resolved name, `evalSubstrate` pill, approval %/mean-loops/residual-risk/overturn context, health grade (or "unproven"). Expandable: groundedness breakdown, convergence detail (loops, cap-hit, stagnation, honest parks), a **cost line** (p50 latency / mean tokens / tokens-spent-on-overturned), a **failure-mode list** (readable labels + counts, drill-through via `sampleDecisionIds`), recent reject reasons + `issueRefs`, park history, trend `Sparkline`. Reuse `OutcomeBar`, `Sparkline`, `Delta`, `FailureMode`, tier-meter primitives.
- **Policy gateway readout** (new, compact): `allow/require_approval/deny` distribution bar + over-permissive flag chip with sample links.
- **Fix the `__gate__:` leak** everywhere it currently surfaces.

---

## 7. Testing & verification

- **Unit (daemon):** fixture-driven tests for `buildGateMetrics` (overturn math incl. null-coverage → null health; groundedness; convergence composite; **cost aggregation incl. `tokensSpentOnOverturned`, and assert cost never moves health**; **failure-mode clustering** incl. `reviewer_unavailable_park` NOT counted as a failure; artifact-id population; name resolution) and `buildPolicyGatewayMetrics` (dist, over-permissive flag, clusters). Mirror existing `aggregate` test style.
- **Migration test:** round-trip `recommended_outcome` capture through `decideGate` (proposal preserved, overturn reconstructable); automated path leaves it null.
- **Contract:** green fixtures for `GateMetrics`/`PolicyGatewayMetrics`/summary+detail additions.
- **Desktop:** `GateMetrics` row render + expand; two-readout top strip; extend `no-jargon.test` to gate rows (no `__gate__:`, no tier/sensor jargon); "unproven" state for null health.
- **Live (per `/verify`):** drive the Metrics tab in the browser (localhost:5174) on the `Adaptive Delivery` template — confirm `__gate__:review` is gone, gates appear in their own section with honest "unproven" where coverage is absent, and the policy-gateway readout renders.

---

## 8. `agent-harness.pdf` alignment scorecard

| Paper mandate | Spec element |
|---|---|
| §3.5.1 three telemetry channels (evaluators / tracing / policy gateways) | evaluators = existing step scores; **tracing** = gate convergence/loops; **policy gateway** = `PolicyGatewayMetrics` |
| §3.5.1 deep telemetry records "human interventions, rejected alternatives" | §3 capture fix → `recommended_outcome` (overturn computable) |
| §3.5.1 "budget consumed without improving verification" | `GateMetrics.cost.tokensSpentOnOverturned` |
| §3.5.1 signals "linked to concrete artifacts… replayable" / §5.2.1(vi) | `overturnDecisionIds`, `ungroundedDecisionIds`, `failureModes[].sampleDecisionIds`, `overPermissive.sampleTransitionIds` |
| §3.5.1 "failure traces cluster recurring patterns" / §3.5.2 attribute to components | `GateMetrics.failureModes` taxonomy + gate failure-label catalog |
| §3.4.4 verification grounded in deterministic sensors; §5.1.1 oracle-adequacy | `scored.groundedness` (sensors present + `oracleAdequacy.sufficient`) |
| §5.2.3 false acceptance is the cardinal verifier sin | `scored.overturnRate`, dominant health term |
| §3.4.4 termination governed by verification, honest escalation | `scored.convergence` (parks-when-required = good, not penalized) |
| §5.2.1 efficiency is a distinct axis from correctness | `cost` surfaced but **never** folded into `health` |
| §5.2.2 evidence bundle is an inspectable contract, not a grade | residual-risk & approval balance = context, not scored |
| §5.2.3 self-evolve "without hiding failures" | honest-null → "unproven" for unmeasured gates |
| §5.2.7 executable / inspectable / stateful / governed | groundedness / artifact-links + taxonomy / version deltas / append-only capture + read-only aggregation |
| §5.2.7 "metrics that isolate harness components" | gates & policy gateway modeled separately from steps; Step health ⟂ Gate health |

*Improvements added after the initial draft's paper re-review: per-gate **cost** telemetry (§3.5.1/§5.2.1), **artifact-linked** scored terms (§3.5.1/§5.2.1(vi)), and a **gate failure-mode taxonomy** (§3.5.1/§3.5.2).*

## 9. Open items for the implementation plan
- Exact composite **weights** for gate health (ordering fixed: overturn ≫ groundedness > convergence) and the overturn-coverage floor.
- Where groundedness reads the reviewed step's evidence facet (join path from a gate decision's `traversal_seq`/`ledger_version` to the step transition it gated).
- The **audit cap** for `*DecisionIds` arrays (reuse the step `sampleTransitionIds` cap).
- Whether `gateHealth` delta reuses the existing version-comparison window machinery verbatim.
