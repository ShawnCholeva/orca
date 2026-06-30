# Metrics Read Surface — Design (Sub-project A of Phase 5)

**Date:** 2026-06-30
**Status:** Approved design, pending implementation plan
**Supersedes:** the data layer of `2026-06-29-metrics-tab-rebuild-design.md` (that doc built the mock view; this replaces the mock with real, derived data)

---

## 1. Context & scope

Orca's Metrics tab is currently a hand-authored mock (`apps/desktop/src/metrics/metrics-data.ts`): per-workflow health, per-step scores/trends/failure-modes, a self-improvement rail of proposals, and a learning log. None of it is real.

This sub-project (**A**) brings the **read surface** to life: it aggregates telemetry Orca already captures and renders it on the existing Metrics page, with **zero LLM calls** (a pure read/projection surface). It is the first of a decomposition of the user's larger request ("bring the Metrics page to life + implement Phase 5 scoring/composition/learning/autonomy"):

| # | Sub-project | Phase items | Status |
|---|---|---|---|
| **A** | **Scoring read surface — real Metrics page** (this spec) | Inspectable axis | designing |
| B | Learning loop (reflective optimizer → proposes template instruction edits) | 5.2 | deferred |
| C | Scoring integrity (risk-gated adversarial refute before approve) | 5.4 | deferred |
| D | Autonomy crossing (LLM gate-evaluator, L4→L5; issue-list correction) | 5.3 | deferred |
| E | Composition (`workflow`/delegate seam, isolated child state) | 5.1 | deferred |

Each lands as its own spec → plan → implementation cycle. A has **no upstream dependency** (the data is already captured) and defines the canonical read-model that B and C build on.

### Non-goals (A)
- Semantic (free-text) failure clustering, instruction-edit **proposals**, the **learning log**, and **auto-apply** — these are the Evolution Agent / learning loop → **B (5.2)**.
- Owner-scoping of the read-model → the tenancy phase (single-owner today).
- Global / cross-owner dashboards and external observability stacks (OTEL/Grafana) → remain a non-goal.
- `step_result_json` self-reported scoring as the **primary** signal → kept as optional secondary enrichment only (see §3).

---

## 2. Decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Aggregation grain | **Per-template, cross-run, version-aware** | Exactly the substrate 5.2 (the learning loop) needs: *"mine a template's own accumulated signals."* Appendix A's "cross-run dashboards" non-goal is narrowed to *global/cross-owner* (see §7). |
| A/B boundary | A computes **deterministic insights**; proposals + learning log render a **deferred state** | Keeps the read endpoint LLM-free (deterministic-core invariant). Proposals are 5.2's output. |
| Time dimension | **Window filter (24h/7d/30d) + real trends** from `created_at` | Makes the period toggle and sparklines honest. |
| Telemetry shape | **Three channels + version-aware**, per the paper | §3.5.1: *"evaluators expose task-level regressions, tracing stacks expose trajectory-level causes, policy gateways expose boundary violations."* Don't collapse them. |
| Failure breakdown | **Categorical `failure_code` clusters** (deterministic) | Real enum already captured; the paper's *"failure traces cluster recurring patterns"* without an LLM. |
| Freshness | **GET on open + manual refresh** (re-fetch on template/period change) | Aggregates don't change second-to-second; matches existing `/harness-metrics`. No WS plumbing. |
| Cold-start | **Show with low-confidence marking** (faded + `n=` caveat; suppress sparkline below density) | Keeps the "this template is new" signal without faking precision. |
| Aggregation mechanism | **On-read SQL/JS derivation** (no new tables, no migration) | Paper-aligned: the view is an always-rederivable projection over preserved full-fidelity artifacts — can never drift; audit/replay/version-comparison reconstruct from source. A materialized rollup is a permitted later optimization behind the same endpoint contract. |
| Substrate | **`harness_transitions` spine** (not `step_result_json`) | See §3 — the canonical Inspectable substrate; the paper prefers deterministic sensors over self-report. |

### Paper alignment (`agent-harness.pdf`)
- **Three channels are the paper's, verbatim** (§3.5.1) → sourced from `EvidenceFacet` / `TelemetryFacet` / `RiskFacet`.
- **Deterministic sensors over self-report** (§3.4.4, §5.2.2: self-reported scores *"create a false sense of correctness"*) → anchor on transition facets; downrank `step_result_json` self-scores.
- **Artifact-linked, replayable, version-comparable** (§3.5.1, §5.1 replayability) → `harness_transitions` is append-only, linked to run/step/version, already backing `/harness-replay` + `/provenance`.
- **Categorical failure clustering** (§3.5.1) → `FailureCode` enum + `attributeFailures`.
- A is the **"Collect" / read surface** of the AHE loop in Fig. 9 (Collect → Failure Diagnosis → Evolution Agent → Replay → Governed Promotion); **B (5.2)** is the Evolution Agent downstream.

---

## 3. Substrate: `harness_transitions`

The canonical Inspectable substrate, **already populated on every real run** (emitters wired: `emitToolGate` in `permission-gate.ts`, `emitStepComplete`/`emitStepLaunch` in `dispatch-engine.ts` + `service.ts`, `emitMarkDone` in `recommendations/usecases.ts`).

Append-only spine (`migrations/0040_harness_transitions.sql`), four boundaries, four nullable JSON facets:

| Boundary | Facets carried |
|---|---|
| `step_launch` | stateDeps |
| `step_complete` | evidence, stateDeps, telemetry |
| `tool_gate` | risk |
| `mark_done` | telemetry, stateDeps |

Facet contents (`packages/contracts/src/harness/index.ts`):
- **EvidenceFacet** (channel 1 — verification): `sensorsRun[]` (typecheck/lint/unit/build/static `SensorResult`s), `verdict` (passed/failed/partial), `untestedRegions`, `residualRisk`, `oracleAdequacy`.
- **TelemetryFacet** (channel 2 — trajectory/cost): `cost` (tokens_in/out, cache, usd), `latency_ms`, `model`, `provider_id`, `rejected_alternatives`, `human_interventions`, `outcome { status, failure_code }`.
- **RiskFacet** (channel 3 — boundary): `risk_class`, `permission_tier`, `gate_decision` (allow/require_approval/deny), `hard_constraint_violations`, `mode`, `approval`.
- **StateDepsFacet**: `conflicts[]` (Stateful axis).

`FailureCode` enum (categorical, clusterable): `invalid_output, timeout, session_not_terminal, output_unavailable, source_truncated, goal_archived, session_archived, daemon_restart, guardrail_denied, evidence_veto, provider_error, internal_error`.

**Joins** for per-template aggregation:
- `harness_transitions.workflow_run_id` → `workflow_runs (template_id, template_version, started_at, finished_at)`
- `harness_transitions.workflow_step_run_id` → `workflow_step_runs (step_template_id, ordinal, attempt, status)`
- window filter on `harness_transitions.created_at`

**Why not `step_result_json`:** it holds the orchestrator's *self-reported* `successScore` + quality dims; the paper distrusts self-report. It remains an **optional secondary** per-step enrichment (the quality dims), never the primary signal, and may be omitted from the first implementation.

---

## 4. Read-model contract (`@orca/contracts`)

New zod schemas on the public spine, consumed by both daemon endpoint and desktop.

```ts
// Per-template summary — drives the dropdown + the stat tiles
TemplateMetricsSummary {
  templateId, name, latestVersion
  runs: number                          // workflow_runs in window
  // The paper's six reliability dimensions, aggregated across the template's
  // runs in the window (reuses the per-goal computation core):
  dimensions: {
    trajectoryEfficiency, verificationStrength, recovery,
    stateConsistency, safetyCompliance, replayability: Metric  // { value: number|null, reason?: string }
  }
  latencyP50Ms: number | null
  // deltas vs the immediately-prior window of equal length:
  deltas: { <same six keys + latency>: number | null }
  versions: { version, runs, firstSeenAt }[]   // version-awareness
  confidence: "low" | "ok"              // low when runs < SAMPLE_MIN
}

// Per-step detail — three channels, deterministic
StepMetrics {
  stepTemplateId, name, ordinal
  score: number                          // 0..100 composite; grade A–F; status healthy|watch|degraded
  sampleSize: number; confidence: "low"|"ok"
  runs, passedFirstTry, recovered, failed: number
  quality:  { verdictPassRate, sensorPassRate, oracleSufficientRate: number,
              limitingDimension: <quality dim> | null }     // CHANNEL 1 (EvidenceFacet;
                                                            // limitingDimension is part of the
                                                            // OPTIONAL step_result_json enrichment,
                                                            // null when that enrichment is absent)
  cost:     { p50LatencyMs, meanTokens, meanUsd, meanRetries: number | null }  // CHANNEL 2 (TelemetryFacet)
  risk:     { riskClassDist, gateDecisionDist: Record<string,number>,
              hardConstraintViolations: number }            // CHANNEL 3 (RiskFacet)
  failureClusters: { failureCode: string|null, boundary: string, count: number,
                     sampleTransitionIds: string[] }[]      // categorical, deterministic
  trend: number[]                        // composite score per time-bucket; [] if below density threshold
  versionBoundaries: number[]            // bucket indices where template_version changed
  insight: string | null                 // deterministic, rule-based (no LLM)
  recentReasons: { at, reason }[]         // raw outcome.reason / blockedReason tail (full-fidelity)
}

TemplateMetricsDetail { summary: TemplateMetricsSummary, steps: StepMetrics[] }
```

**Derivations (pure arithmetic over preserved facets):**
- `score` (the per-step 0..100 composite headline + its A–F grade + healthy/watch/degraded status) = `verificationStrength × 100` — the deterministic-sensor evaluator channel is the headline (paper-aligned: sensors over self-report). Status thresholds and any cross-channel weighting are fixed in the implementation plan; the trend buckets the same composite over time.
- `firstPass` = distinct (run, step) passing on `attempt=1` ÷ total.
- `recovered` = distinct (run, step) ending `passed` with `attempt>1`.
- `escalated` (a tile) = rate of transitions with `RiskFacet.gate_decision ∈ {require_approval, deny}` **or** non-empty `TelemetryFacet.human_interventions`. **No `gate_decision_ledger` join** — both signals are on the facets.
- `insight` = a small fixed rule set (e.g. *"Most revisions in this workflow originate here (54%)"*, *"Weakest step"*, *"`correctness` limits low-scoring runs"*, *"Trending down N pts this window"*). Enumerable, testable, zero LLM.
- `failureClusters` = `attributeFailures` variant, filtered to the template/window and grouped by `step_template_id`.

The mock's four tiles re-map onto this vocabulary: health ≈ verificationStrength, recovered ≈ recovery, escalated ≈ 1 − safetyCompliance / human-intervention rate, latency from `telemetry.latency_ms`.

---

## 5. Daemon: endpoints + reuse seam

**Reuse, don't reinvent.** The per-goal `harness-metrics` suite already computes the six dimensions (`computeHarnessMetrics`) and categorical failure clusters (`attributeFailures`).

- Extract **`computeHarnessMetricsFromTransitions(ts: HarnessTransition[]): HarnessMetrics`** from the existing `computeHarnessMetrics(db, goalId)` (which already computes over a transition *list*). The per-goal path feeds it `listTransitionsByGoal(...)`; the per-template path feeds it the windowed, template-filtered transition set. The existing per-goal tests become a refactor-safety net.
- Add a **template-filtered, step-grouped variant of `attributeFailures`** (same SQL shape, additional `template_id`/window predicate via the `workflow_runs` join, `GROUP BY` also on the step).

**Endpoints** (new module, e.g. `apps/daemon/src/metrics/` or extend `harness-metrics/routes.ts`), sharing the computation core:
- `GET /v1/metrics/templates?period=7d` → `TemplateMetricsSummary[]` (dropdown + tiles).
- `GET /v1/metrics/templates/:templateId?period=7d` → `TemplateMetricsDetail` (summary + steps + failure clusters).

Validation: unknown `period` → 400; unknown `templateId` → 404; empty result is a valid 200 (empty arrays / null dimensions).

---

## 6. Desktop wiring

Components are purely presentational; wiring is surgical.

- **`metrics/metrics-data.ts`:** replace the synchronous `getWorkflowMetrics()` / `getLearningLog()` mock with a fetch against the two endpoints via the **existing daemon HTTP client** (browser-proxy + Tauri-token both already handled). Realign the exported view types to the §4 contracts; a thin mapper adapts facet-sourced fields to existing component props.
- **`MetricsPage.tsx`:** fetch hook keyed on `(templateId, period)`; the toggle + dropdown drive real re-fetches; add a **refresh button**. Four states: **loading** (skeleton), **error** (retryable inline), **empty** ("Run a workflow to see metrics"), **data**.
- **`StepPerformance.tsx`:** the expanded `StepRow` failure block renders **categorical `failureClusters`** (count + boundary) + `recentReasons` tail (replacing mock labels). `OutcomeBar` + `Sparkline` (with version-boundary ticks) map directly. **Low-confidence marking:** sub-threshold steps render faded with an `n=` chip; sparkline suppressed until density. Deterministic `insight` line stays.
- **`SelfImprovement.tsx` (right rail — B's territory):** renders the **deferred state** — a deterministic header (*"N steps underperforming in {template}"*) + an explicit **"Learning loop not yet enabled"** placeholder where proposals/activity will land. The **`AutoApplyToggle` is removed from A** (it governs autonomous template mutation — B/5.2's governed-promotion concern; a live toggle with nothing behind it would mislead).

No new view components.

---

## 7. Testing (TDD — tests before implementation)

- **Daemon core:** unit-test `computeHarnessMetricsFromTransitions` (six dimensions + null-facet handling) against synthetic transition lists; existing per-goal suite continues to pass (refactor net).
- **Per-template aggregation:** seed a temp SQLite with `workflow_runs` + `workflow_step_runs` + `harness_transitions` spanning **two template versions** and **straddling a window boundary**; assert summary dimensions, per-step rollups, version bucketing, delta-vs-prior-window, confidence threshold, empty/cold-start.
- **Failure clustering:** step-grouped, template-filtered `attributeFailures` — ordering + counts.
- **Contracts:** zod parse/round-trip.
- **Endpoints:** 200 shape, 404 unknown template, invalid `period` → 400, empty 200.
- **Desktop:** extend `MetricsPage` / `StepPerformance` / `metrics-charts` tests to the real data shape + four states + failure-cluster rendering + low-confidence marking + deferred B-rail.

---

## 8. Edge cases & risks

- **`escalated` / gate-ledger risk (raised in design) is resolved** by the substrate swap: derived from `RiskFacet.gate_decision` + `TelemetryFacet.human_interventions`, both on the facets — no extra join.
- **Sparse facets:** boundaries carry different facets; aggregation handles per-dimension nulls exactly as `computeHarnessMetrics` does today (`Metric.reason`).
- **Performance:** template-wide scan joins via `workflow_runs(template_id)`; adequate at A's scale. Index/rollup is the stated drop-in optimization behind the same endpoint (Approach 1 tradeoff). Log if any cap is applied.
- **Step rename/removal across versions:** `step_template_id` is the stable key; display the latest template's name.

---

## 9. Doc updates shipped with A

- **ORCA.md** — Inspectable-axis entry: per-template metrics surface, generalizes `harness-metrics` from per-goal to per-template.
- **FUTURE_WORK.md Appendix A** — narrow the *"cross-run/global dashboards"* non-goal to **global / cross-owner**; per-template cross-run is now in-scope (the 5.2 substrate).
- **FUTURE_WORK.md Phase 4/5** — note the read-side consumer of the scoring/transition substrate now exists (closes the "nothing consumes it" pointer for the read half; 5.2 still owns the learning half).

---

## 10. Exit criteria

1. The Metrics tab renders real per-template, windowed, version-aware data with zero mock and zero LLM calls.
2. Per-step view shows the three telemetry channels + categorical failure clusters + deterministic insight, sourced from `harness_transitions` facets.
3. Cold-start / low-sample states are honest (marked, not faked).
4. The per-goal `harness-metrics` suite still passes against the shared, extracted computation core.
5. The learning-loop rail renders an explicit deferred state (no proposals, no auto-apply) — ready for B to fill.
