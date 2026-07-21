# Step Drawer Alignment (Phase B5) — Design

**Date:** 2026-07-21
**Status:** Design — finalized (output excerpt descoped per code map; inline drafted-fix wiring confirmed)
**Scope:** Phase B5 of the metrics health-console redesign. Bring the expanded **step drawer** into line with the approved mockup: **health-adaptive disclosure** — a healthy step's drawer is one line; a struggling step's drawer earns the detail (clustered failure → concrete sample with output excerpt → the drafted fix). Drop the dense mechanical sections the drawer kept as a "light touch" in B2.

---

## 1. Context & motivation

The step drawer today (`apps/desktop/src/metrics/StepPerformance.tsx`, the `open && (...)` block ~L203–302) is the old 2c-era dense drawer with the B4 failure-drill bolted on top. It was never restyled to the mockup's cleaner, failure-first shape — that was the explicit B2 "light touch" decision (B2 spec §3.2). The result: even a **healthy** step (e.g. Triage, 96) expands into a wall of `Checks run` / `How this score was reached` / `What we couldn't check` / `Remaining risks` / insights / reconciliation — mechanical, jargon-y, and (for the residual-risk chips) prone to spraying raw file paths into the UI in a larger project.

**User's governing principle (confirmed in review):** *"healthy steps are simple to view; the unhealthy step shows more details like what's going wrong."* The drawer should be **health-adaptive**: calm when healthy, detailed when struggling.

Two user concerns drove the final shape:
- `What we can't be sure of` (untestedRegions/residualRisk chips) is **not actionable** — the user has no next move from seeing it — and **scales badly** (per-file chips explode in a real project). Its trust-calibration value is already carried by the band pill (`Reviewed` vs `Run & tested`) and the collapsed row's `How we check it` channel; its *actionable* form is the drafted-fix card. → **Drop it.**
- The mechanical `Checks run` / `How this score was reached` block is the main thing making a healthy drawer heavy. → **Drop it.**

Design validated against real app data in an interactive mockup (`scratchpad/drawer-redesign-real.html`) before spec.

Paper alignment: §3.5.1 *"signals linked to concrete artifacts"* (the failure drill), §5.2.5 executable accountability (the drafted fix as the actionable output of a verification gap). The dropped epistemic chips traded honesty for noise; the calibration they carried survives in the band + channel, per §5.2.2 (calibrated-not-binary is preserved by the band, not the chip list).

---

## 2. Goals & non-goals

### Goals
- **Health-adaptive drawer.** The expansion leads with `What's going wrong` directly below the three-channel panel. No outcome bar, no band-strength bars at the top of the drawer.
- **Healthy step → one line:** `What's going wrong → No problems detected this period.` and nothing else.
- **Struggling step → the drill:** `What's going wrong` (clustered failures) → per-cluster sample peek (run/time/version + failed check with its reason + open-full-run — **no** output excerpt, see §3.4) → **inline drafted-fix card** (only when a proposal targets this step), reusing the self-improvement rail's review action.
- **Remove** from the drawer: `Checks run`, `How this score was reached`, `What we couldn't check` + `Remaining risks` chips, `insights`, `reconciliation`, `approvals`, `recentReasons`. (The outcome bar and band-strength bars move out too.)
- Keep the `VersionHistoryStrip` (A-ii change history) — it is version-lineage, orthogonal to health, and low-noise. *(Confirm with user; provisional keep.)*
- No-jargon copy throughout (`no-jargon` test passes).

### Non-goals
- No change to scoring, bands, the collapsed row, or the three-channel panel (`How it's doing` / `How we check it` / `Anything wrong` stay exactly as B2 shipped them).
- No change to the self-improvement rail itself — the drawer only *surfaces* the same proposal contextually and reuses its existing review action.
- No new failure-clustering or aggregation logic (uses the B4 `failureClusters`).
- Gate drawers (`GatePerformance.tsx`) are out of scope for B5 — steps only.

---

## 3. Design

### 3.1 The two drawer states (desktop, `StepPerformance.tsx`)

The expanded drawer becomes, in order:

**Always:**
1. `What's going wrong` — `SectionLabel` leading (no top margin), directly under the channel panel.
   - If `failureClusters.length === 0`: single green line `No problems detected this period.` **← healthy stops here.**
   - Else: for each cluster, the existing cluster row (`labelForFailure` + `count`× + `view N samples` toggle) → lazy `SamplePeek`.

**Struggling only (when there is ≥1 cluster):**
2. After the clusters/peek, the **inline drafted-fix card** (§3.5) — rendered only when a proposal targets this step.

Everything else in today's drawer (L206–218 outcome/band bars; L242–297 Checks run, How-this-score, chips, approvals, insights, reconciliation, recentReasons) is **deleted**. `VersionHistoryStrip` (L299) is retained at the bottom.

### 3.2 What this removes from the component
- Imports that become unused after deletion (`OutcomeBar`, `Sparkle`, `SectionLabel` if no longer used, `Chips` helper, `latencyLabel` if unused elsewhere) — remove only those our change orphans (surgical).
- The `Chips` component and any helper used *only* by the deleted sections. Verify each is not used elsewhere in the file before removing.

### 3.3 Health-adaptive is data-driven, not a flag
"Healthy vs struggling" is simply `step.failureClusters.length === 0`. No new field. A step with no in-window cluster shows the one-liner; a step with a cluster shows the drill. This matches the collapsed-row verdict already computed by `verdictFor`.

### 3.4 Sample peek — output excerpt DESCOPED (data not persisted for failing steps)
**Code-map finding (confirmed):** for a vetoed (`failed` verdict) `step_complete`, Orca goes straight to `reviseStep` (`service.ts:1409`) and **never writes the step's structured domain output** — the `block` object (`chosen_approach`, `approaches[]`, …) exists only in memory at gate-eval time. `workflow_artifacts` (type `step_output`) is written only for *committed* completions (`ledger-commit.ts:84`); `pending_completion_json` only on the pause/escalate path — **neither exists for the failing samples we drill into.** The only durable remnant is `workflow_step_runs.prior_claims_json`, a file-path claim subset, not the domain object.

**Decision (user-confirmed 2026-07-21):** **do not** persist failing output (that would touch the execution hot path); **the excerpt is dropped from B5.** The peek keeps its **current depth**: run/time/version + the failed check(s) with their `detail` (which already *quotes* the offending value, e.g. *"chosen_approach value 'Minimal…' is not among approaches[].name"*) + `open full run →`. No `SampleDetail`/`sample-detail.ts` change. (A later slice may persist a bounded failing-output excerpt if it proves valuable — its own execution-plane decision.)

### 3.5 Inline drafted-fix card
On a struggling step, after the clusters, surface the **existing** learning proposal that targets this step.
- **Trigger:** the step has ≥1 cluster (struggling) **and** a proposal exists with `stepTemplateId === step.stepTemplateId` and an actionable `status` (`pending`). Healthy step or no proposal → no card.
- **Content:** `✦ Orca drafted a fix: {proposal.predictedImprovement}` + a `Review change →` button, matching the rail card copy (`SelfImprovement.tsx:175,192`).
- **Action:** `Review change →` opens the **same review modal** the rail uses. Today that modal + its `reviewing` state are private to `SelfImprovementRail` (`SelfImprovement.tsx:197–235`, opened by `setReviewing(p.id)` at :192, Apply/Dismiss → `applyProposal`/`dismissProposal`). **Extract the review modal into a shared component** (`ProposalReviewModal`) driven by a `reviewingProposalId` state **owned by `MetricsPage`**, used by *both* the rail and the drawer. No new endpoints; Apply/Dismiss stay as-is.
- **Data path (state lift):** proposals are currently fetched *inside* `SelfImprovementRail` via `listProposals(templateId, period)` (`api.ts:1015`; `MetricsPage.tsx:122` passes it no proposals). **Lift the fetch to `MetricsPage`**: `MetricsPage` calls `listProposals`, owns `proposals` + `reviewingProposalId`, passes:
  - to `SelfImprovementRail`: `proposals` + `onReview(id)` + `onMutated` (rail stops fetching; it renders from props). Preserves the rail exactly.
  - to the step panels → `StepRow`: a `proposalForStep?: TemplateInstructionProposal` (or a `proposalsByStep` map keyed by `stepTemplateId`, taking the actionable one) + `onReviewProposal(id)`.
  - The extracted `ProposalReviewModal` rendered once at `MetricsPage`, keyed off `reviewingProposalId`.
- **Refetch:** `onMutated` (after Apply/Dismiss) re-runs the `MetricsPage` proposals fetch so both rail and drawer stay in sync.

### 3.6 Backward-compat
Recompute-on-read; no migration; **no contract change** (`SampleDetail` and `TemplateMetricsDetail` untouched). The new `StepRow` props (`proposalForStep`, `onReviewProposal`) are optional (absent → no card). The rail refactor (fetch→props, modal extraction) is behavior-preserving.

---

## 4. Testing & verification

- **Desktop:** a healthy step (no clusters) renders only `What's going wrong → No problems detected` (assert the mechanical sections — Checks run, How-this-score, chips, insights, reconciliation, approvals, outcome/band bars — are absent); a struggling step renders clusters → peek → drafted-fix card; the card shows only when a matching actionable proposal exists AND the step has a cluster; `Review change →` opens the shared `ProposalReviewModal`; `no-jargon` passes.
- **Rail regression:** `SelfImprovementRail` renders identically from props (no behavior change); Apply/Dismiss still call `applyProposal`/`dismissProposal`; `onMutated` refetches at `MetricsPage`.
- **Live (needs daemon restart):** healthy Triage drawer is one line; a struggling step (re-seed the veto as in the B4 live-verify) shows the drill + drafted-fix card. Screenshot; then delete the seed.

---

## 5. Open items for the implementation plan
- §3.4 resolved: output excerpt **descoped** (data not persisted for failing steps; no execution-path change).
- §3.5 resolved: lift `listProposals` fetch + `reviewingProposalId` to `MetricsPage`; extract `ProposalReviewModal` shared by rail + drawer; thread `proposalForStep` + `onReviewProposal` to `StepRow`.
- Confirm `VersionHistoryStrip` stays (provisional keep — low-noise, version-lineage not health).
- Surgical cleanup: after deleting drawer sections, remove only the imports/helpers our change orphans (candidates: `OutcomeBar`, `Sparkle`, `Chips`, `latencyLabel`, `SectionLabel` if unused) — verify each is not used elsewhere in the file first.

## 6. Task decomposition (for writing-plans)
1. **Desktop — trim the drawer** (`StepPerformance.tsx`): delete outcome/band bars + Checks-run + How-this-score + chips + approvals + insights + reconciliation + recentReasons; lead with `What's going wrong`; keep clusters/peek + `VersionHistoryStrip`. Remove orphaned imports/helpers. Update fixtures/tests. *(No backend, no props yet — independently testable: healthy = one line, struggling = clusters+peek.)*
2. **Desktop — lift proposals + extract `ProposalReviewModal`** (`MetricsPage.tsx`, `SelfImprovement.tsx`, new `ProposalReviewModal.tsx`): move `listProposals` fetch + `reviewingProposalId` to `MetricsPage`; rail renders from props; modal shared. Behavior-preserving for the rail. *(Independently testable: rail unchanged.)*
3. **Desktop — inline drafted-fix card** (`StepPerformance.tsx`, `GatePerformance.tsx`, `MetricsPage.tsx`): thread `proposalForStep` + `onReviewProposal` to `StepRow`; render the card on struggling steps with a matching proposal; `Review change →` opens the shared modal. *(Depends on 1 + 2.)*
