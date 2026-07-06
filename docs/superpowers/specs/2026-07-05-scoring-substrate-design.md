# Sub-project 1 — Honest scoring substrate + readable metrics UI + joined scoring surfaces

**Date:** 2026-07-05
**Status:** Design — awaiting review
**Scope:** The read-side of Orca's step-scoring. Fixes the "everything reads 100/100 Healthy" problem, replaces jargon with plain language, and joins the two separate scoring surfaces into one confidence story. It is the substrate the existing learning loop (Phase 5.2) consumes — SP2 and SP3 build on it.

---

## 1. Problem

Every step of the Adaptive Delivery workflow reads **100/100 "Healthy"** on the Metrics tab, and the self-improvement rail says *"Nothing to propose — steps are healthy or below the sample threshold."* Three root causes, all verified in code:

1. **The score is dishonest.** `computeStepMetrics` sets `score = round(verdictPassRate × 100)` (`apps/daemon/src/metrics/aggregate.ts:332`). A step that merely *passed* scores 100 regardless of how weakly it was verified. A step upheld only by a soft AI refutation, with no executable check, scores identically to one that cleared a full test suite.
2. **Absence of verification reads as perfect verification.** `sensorPassRate` returns `1` (100%) when *zero* sensors ran (`aggregate.ts:252`). "No sensors exist" is displayed as "all sensors passed."
3. **Jargon + two contradictory surfaces.** The UI shows "verdict pass / sensors / oracle adequate" (`StepPerformance.tsx:112`) — words a user doesn't know — and a caveat ("oracle is inadequate") that contradicts the green 100. Separately, the Activity-thread step-result card (`ActivityThread.tsx`) shows a standalone self-graded 100% grid that looks identical to a verified score. The user cannot tell a **claim** from a **proof**.

Because the score saturates at 100, the *existing* learning-loop diagnosis (`diagnoseTemplate`, rules R1–R4, sample-gated) finds no gradient to act on. Fixing the read-side signal is the keystone that unblocks the whole loop.

### Grounding — the paper (`agent-harness.pdf`, §5.2.1–5.2.2, p.62)
> *"a harness can become overconfident precisely because it has executable feedback: the agent sees a green test, but the green test is not the full specification."*

The paper's prescription — a **verification stack with explicit scope**, where each artifact declares *what it verifies, what it cannot, and what confidence it provides*, and *"every accepted action carries an evidence bundle containing the checks run, the assumptions preserved, the untested regions, and the remaining risks."* SP1 realizes the read-side of this in user-readable terms.

---

## 2. Goals / Non-goals

**Goals**
- Step scores reflect **verification strength**, not raw pass/fail. Lightly-checked passes land mid-range; only genuinely well-verified passes approach 100.
- **Absence of a check is never a perfect score.** Kill the `sensors=1`-when-empty default and equivalents.
- **"Unverified" is an actionable state**, surfaced for attention and eligible to feed the improvement loop — not a neutral grey blank excluded from everything.
- The step detail shows **positives and negatives a human can read**: did it work, how sure are we, what wasn't covered, and — when runs failed — a **readable, counted failure-mode taxonomy** + a plain-language insight.
- **Zero jargon** in user-facing copy: no "oracle", "sensor", "verdict", "refute".
- **Join the two scoring surfaces** into one confidence story: the self-report is demoted to *"the AI's own claim,"* reconciled against the independent check, on both the Metrics tab and the Activity-thread step-result card.

**Non-goals (explicit)**
- The self-improvement panel UI and the diagnosis-rule updates that make proposals fire — **SP2**.
- The learning-log timeline and applied-change outcome verification — **SP3**.
- Auto-apply / autonomous self-modification (the mock's "auto-apply >90%" toggle) — **L5 non-goal** per `FUTURE_WORK.md`.
- Changing the **producers** (harness sensors, refute, orchestrator prompts) to emit richer per-artifact scope declarations. SP1 **derives** the confidence model from signals *already captured*. Producer enrichment is a later step toward full evidence-bundle fidelity.
- A semantic **step-type registry** ("this is a planning step"). SP1 keys wording off *observed evidence* (did any executable check ever run for this step) rather than a hardcoded taxonomy.

---

## 3. The model

### 3.1 Verification as an evidence bundle (with a plain-language headline rung)
Following the paper's *"verification stack with explicit scope"* (§5.2.2) — *"each artifact should declare what it verifies, what it cannot verify, and what confidence it provides"* — each **final** step completion (the latest `step_complete` per run — existing `finalStepCompletes` logic) carries a small **evidence bundle**: one entry per verification source that had something to say, each declaring its **own** scope. Today three sources exist, derived from data already on the `HarnessTransition` (`evidence`, `refute`, `telemetry`) plus the step's self-report; the bundle is shaped to admit more later (static analysis, property tests, human review) **without another rewrite** — this is the contract seam toward the full evidence-bundle model:

| Artifact `source` | Declares it verified | Declares it *cannot* verify | Confidence |
|---|---|---|---|
| `executable` (sensors/tests/build) | the checks that ran passed | untested regions / oracle gaps | high when `oracleAdequacy.sufficient` |
| `independent_review` (refute) | a second model did not overturn the result | anything not executed | medium |
| `self_report` (model's own claim) | nothing independently — a claim only | everything | low |

The **headline rung** the user sees is then *derived* as the strongest independent artifact present in the bundle:

| Tier (internal) | User-facing label | Derived from | Confidence coeff. |
|---|---|---|---|
| `verified_executed` | **Run & tested** | `evidence` present, executable sensors ran, `oracleAdequacy.sufficient === true` | **1.0** |
| `partially_verified` | **Partly verified** | `evidence` present, some executable signal but gaps / untested regions (`sufficient === false`) | **0.7** |
| `ai_reviewed` | **Reviewed, not proven** | no executable `evidence`, independent refute `verdict === "upheld"` | **0.55** |
| `self_reported` | **Self-reported only** | only the model's own claim; refute `uncertain`/`unavailable` | **0.3** |
| `unverified` | **No check yet** | no conclusive signal at all, or `evaluation_failed` | — (special) |

Coefficients live as a single tunable constant table in `aggregate.ts` (not scattered magic numbers). They are a **designed heuristic** — defensible and adjustable, not derived from first principles (see §7).

### 3.2 Step score (the honest headline)
Let `F` = final completions in the period.
- `Fᵥ` = completions with a conclusive tier (tier ≠ `unverified`).
- **If `Fᵥ` is empty** → the step is in the **"No check yet"** actionable state. The headline renders as *"needs a check"* (not a number), the step counts as *attention*, and it is eligible for the improvement loop. (Replaces today's neutral "not verified" that was excluded from everything.)
- **Else:**
  ```
  score = round( 100 × mean over c in Fᵥ of  ( isPass(c) ? conf(tier(c)) : 0 ) )
  ```
  where `isPass`/`isFail` reuse the existing `vPass`/`vFail` logic. A step that always passes at `ai_reviewed` → ~55; always passes `verified_executed` → ~100; fails half its executed runs → ~50.

**Absolute scale (decided).** A step whose best achievable tier is `ai_reviewed` (e.g. a plan that cannot be executed) caps at that tier's confidence — it is **not** re-baselined to 100. A green "Run & tested" step and a mid "Reviewed, not proven" step therefore mean different, comparable things across the whole workflow. Workflow health is the sample-weighted mean of step scores, and will drop accordingly (e.g. 94 → ~71) — this is intended.

### 3.2a False-acceptance rate — a first-class verification-strength signal
The paper names *rate of false acceptance* as a core measure of verification strength (§5.2.1, dim. ii). Orca can measure it **directly**: the fraction of completions where the step self-reported success but the independent check **overturned** it (`refute.verdict === "refuted"` against a self-reported pass). This rate (a) pulls the step's score down — a step whose "passes" keep getting overturned is weakly verified even when its tier looks fine — and (b) surfaces as a headline weakness: *"its own 'pass' was overturned N% of the time."* It is the sharpest available proxy for oracle inadequacy on a passing step, and — per the paper's *feedback-calibration* direction — it is also the empirical signal against which the §3.1 confidence coefficients get **calibrated** over time (see §7).

### 3.3 Status thresholds (`statusForStep`, `metrics-data.ts`)
- `unverified/no-check-yet` → **"No check yet"** (blue, actionable) — *distinct from* a failing grade it didn't earn.
- score ≥ 80 → Healthy (green) · ≥ 60 → Watch (amber) · else Degraded (red).
- Grade band (`gradeFor`) retained but re-anchored to the honest scale.
- Low-sample dimming (`confidence === "low"`, `n < 5`) retained unchanged.

### 3.4 Readable failure-mode taxonomy
Two sources, both mapped to **human-readable labels** via a deterministic catalog:

1. **Outcome failures** — existing `failureClusters` keyed by `failureCode::boundary`. Add a `FAILURE_LABELS` catalog mapping each `failureCode` to a plain sentence (e.g. `evaluation_failed` → "Finished without producing a checkable result").
2. **Verification-adequacy weaknesses** — derived from `evidence`/`refute` state, expressed as failure-mode entries even when the run "passed":
   - refute `refuted` a self-reported pass → **"Approved something the independent check overturned"** (the paper's *false pass*).
   - completion with no evidence and inconclusive refute → **"Said 'pass' without an independent check"** (the *inconclusive verdict*).

Each entry carries `{ label, count, pct }` and renders as the mock's counted+ranked list. When there are genuinely no failures and the step is well-verified, show *"No problems detected this period."*

### 3.5 Insight (plain-language, deterministic)
A one/two-sentence summary **templated** from the computed signals — the dominant failure mode, the verification tier, and the trend direction. No new LLM call in the read path (keeps SP1 control-plane-cheap; LLM-authored insight can come later). Example: *"Consistently passes review but is never independently proven — if downstream steps fail on this output, that's the signal to strengthen it."*

### 3.6 The step detail as the paper's four-part evidence bundle
The paper prescribes that *"every accepted action carry an evidence bundle containing the checks run, the assumptions preserved, the untested regions, and the remaining risks"* (§5.2.2). The expanded step detail is organized as exactly those four, in plain language — so the UI *is* the inspectable evidence contract, not an ad-hoc list:
- **Checks run** — the §3.1 bundle artifacts: what actually vouched for this step ("a second AI reviewed it," "the build ran and tests passed").
- **Assumptions preserved** — surfaced from the evidence facet's recorded assumptions when present (the fabrication-rollback path records verified claims as scoped evidence-bundle assumptions, per FUTURE_WORK 2.8); omitted when none.
- **Untested regions** — from `evidence.untestedRegions`, in plain words. Wording keys off *observed evidence* (whether any executable check has ever run for this step) — **not** a step-type registry. Never ran → *"No executable check exists for this step — its output was never run or tested."*
- **Remaining risks** — from `evidence.residualRisk`, in plain words.

*(The nicer step-aware copy — "a proposal is a plan, so nothing was run" — is an optional later enhancement that would need a step-type signal.)*

### 3.7 Reconciliation (the join)
Every step carries a `reconciliation`: the **claimed** self-report vs the **independently verified** tier, e.g. *"Claimed fully complete · Independently verified: reviewed, not executed."* When the independent check **refuted** the claim, the reconciliation renders in red. This is the single sentence that ties claim to proof, shown on both surfaces.

---

## 4. The two surfaces

### 4.1 Metrics tab — `StepPerformance.tsx` (+ `metrics-data.ts`, `MetricsPage.tsx`)
- **Row (collapsed):** honest score / "needs a check", plain status pill (Run & tested / Partly verified / Reviewed not proven / Self-reported only / No check yet), existing sparkline + outcome bar retained.
- **Expanded:** a 5-segment **verification-strength bar** (which rung), then plain sections — **Did it work?**, **How sure are we it's right?**, **What we couldn't check**, the **readable failure-mode taxonomy** (when failures exist), the **insight**, and the **reconciliation** line. The self-report becomes *"What the AI said about its own work · its own claim — not confirmed,"* with each dimension glossed in plain words.
- **Delete** the "Verdict pass X% · sensors X% · oracle adequate X%" line and the "oracle is inadequate" insight string entirely.
- Workflow-level tile ("Workflow health") reflects the honest mean; `attention` count includes "No check yet" steps.

### 4.2 Activity thread — `ActivityThread.tsx` (`StepResultCard` / the scores `<dl>`)
- Retitle the grid **"How this step scored itself"** with a **"its own claim — not proof"** tag; gloss each dimension (Complete / Correct / Followed instructions).
- Add an **"Independent check"** line rendered from the `RefuteFacet` available at this surface (upheld → amber "reviewed and agreed, nothing executed"; refuted → red).
- Add the same **reconciliation** callout. Full health *trend* stays on the Metrics tab (only self-report + refute are available at card-render time; the health rollup is a Metrics aggregate).
- Remove the note framing that implies the grid is a co-equal score.

---

## 5. Contract & data changes

**`packages/contracts/src/metrics/index.ts`** — extend `StepMetrics` (additive):
- `verification: { tier; tierLabel; confidence; falseAcceptanceRate; artifacts: { source: "executable" | "independent_review" | "self_report"; verifies: string; cannotVerify: string; confidence: number; verdict: "pass" | "fail" | "partial" | "inconclusive" }[] }` — the evidence bundle (§3.1); `tier` and `confidence` are **derived** from `artifacts`, and the array is shaped to admit more sources later without a UI/contract rewrite
- `failureModes: { label: string; count: number; pct: number }[]` (readable; used for display — retain the raw `failureClusters` field for internal/diagnosis consumers that need codes)
- `insights: string[]` — already present on `StepMetrics`; now populated by the templated insight (§3.5) instead of the old "oracle is inadequate" string
- `reconciliation: { claimedComplete: boolean; verifiedTierLabel: string; refuted: boolean } | null`
- `quality.sensorPassRate` semantics fixed: **null when no sensors ran** (never `1`); UI shows "no checks run" rather than a percentage.

**`apps/daemon/src/metrics/aggregate.ts`** — the core rewrite: tier classification, confidence-weighted score, taxonomy + labels catalog, templated insight, reconciliation, sensor-default fix.

**`apps/daemon/src/metrics/fetch.ts`** — surface the **self-report** (from `workflow_step_runs` `pending_completion_json` / the stored scoring) into the metrics layer so the Metrics-tab reconciliation has the "claimed" values. *(On the Activity-thread surface the self-report + refute are already present.)*

**Frontend:** `StepPerformance.tsx`, `metrics-data.ts`, `MetricsPage.tsx`, `ActivityThread.tsx`. No new API endpoints.

---

## 6. Edge cases
- **No completions in period** → existing "No step activity in this period."
- **Low sample (`n<5`)** → keep dimming + `n=` tooltip; scores can swing — unchanged.
- **`evaluation_failed`** → `unverified` tier (already excluded from verified pass) → "No check yet."
- **Veto-then-pass** (two `step_complete`s per run) → score the final attempt only — existing `finalStepCompletes` dedup retained.
- **Refute `unavailable`/`uncertain`** with no evidence → `self_reported` (if a self-report exists) else `unverified`.
- **Refuted pass** → counts as a failure-mode entry *and* pulls the score down (the completion is `isFail` via existing `vFail` refute branch).

---

## 7. Alignment (paper + FUTURE_ARCHITECTURE) & risks

**Where SP1 sits in the paper's frame.** SP1 is the **observe** stage of the Evolution-Agent loop (paper §3.5.2: observe → diagnose → propose → evaluate → promote) — it turns the already-captured deep telemetry into a legible, comparable per-step signal that the existing `diagnoseTemplate` (diagnose) consumes. It strengthens the **Inspectable** axis (FUTURE_ARCHITECTURE Invariants; the `RefuteFacet` is that axis's independent ground truth) without touching Executable/Stateful/Governed.

**The core rationale.** The paper warns: *"if the verifier is weak, the agent will learn to optimize against the wrong signal."* Today's `score = verdictPassRate × 100` is exactly such a weak signal — so the moment SP2's loop optimizes against it, it would tune step instructions to satisfy a vanity metric. Making the score an **honest, scope-aware verification-strength measure is the precondition** for the learning loop to be safe to close.

**Evaluation dimensions (paper §5.2.1).** SP1 covers **verification strength** (incl. oracle adequacy + false-acceptance rate) as the headline, and **recovery ability** (the passed/recovered/failed outcome bar). It deliberately leaves **trajectory efficiency** (cost — surfaced but secondary), **safety compliance** (constraint violations/approvals — shown only when they fire), **state consistency** (belief-divergence, already captured elsewhere) and **replayability** to their existing homes. Naming the full set keeps the pick principled rather than ad hoc.

**Calibration, not fixed truth (feedback-calibration, §5.2.2).** The §3.1 confidence coefficients ship as an initial **prior**. The paper's *"epistemically aware"* harness "knows when a signal is strong enough to act on" — so the coefficients are meant to be **calibrated** against the measured **false-acceptance rate** (§3.2a) as run volume accrues (an SP2/SP3 refinement). SP1 states the priors and the calibration target; it does not pretend the numbers are ground truth.

**Replayability / comparability (invariant).** The score MUST be a **pure, deterministic function of captured evidence** — no wall-clock or nondeterministic inputs — so the same evidence yields the same score across runs and across template versions. This is what lets the `version_comparison` falsifier (SP3) tell whether an applied instruction change actually helped. Metrics remain a **projection** over the append-only transition spine (recomputed, never stored mutable).

**Control-plane purity & scope.** All of SP1 is control-plane-pure (no execution-plane access) and per-template / per-owner (no cross-goal learning) — consistent with the deterministic-core cost spine and the owner-boundary wall. The deterministic insight (§3.5) adds **no** LLM call to the read path.

**Risks.**
- *The score is now interpretive.* Mitigation: single tunable coefficient table; the rung bar + evidence bundle make the derivation legible in-product; calibration path defined above.
- *Workflow health visibly drops* (e.g. 94 → ~71) — the intended honest picture, flagged so it isn't read as a regression.
- *Thin samples* mean proposals stay quiet until ≥5 runs/step accrue (SP2 dogfooding prerequisite, not a blocker for SP1).

---

## 8. Success criteria (verifiable)
1. A passing-but-`ai_reviewed` step (fixture) scores in the mid-range (~50–65), **not** 100.
2. A step with zero sensors shows **no** "sensors 100%" — the UI reads "no checks run"/"reviewed only".
3. An `unverified` step renders as **"No check yet"** (actionable), is counted in "needs attention", and is **not** excluded.
4. `grep` over built user-facing strings finds **no** "oracle", "sensor", "verdict", "refute".
5. Both surfaces render the **reconciliation**; a refuted claim renders distinctly (red) on both.
6. Failure runs render as **readable labels with counts** (no raw `failureCode::boundary` shown to users).
7. Existing `aggregate` tests updated; new tests cover tier classification, the score formula, and the sensor-default fix; `ActivityThread.test.tsx` updated for the reconciled card.
8. Verified end-to-end in the running app (browser) on the Adaptive Delivery workflow: the flatline-at-100 is gone and the step detail is readable.
9. **Replayability:** the score is a pure function of captured evidence — recomputing metrics over the same transitions yields an identical score (a test recomputes twice and asserts equality); no wall-clock/random inputs.
10. Each step exposes the **evidence bundle** (`verification.artifacts`, each with `verifies`/`cannotVerify`/`confidence`) and a computed **false-acceptance rate**; a fixture with a refute-overturned pass lowers the score and shows the "overturned N%" weakness.

---

## 9. Out of scope → next
- **SP2** — update `diagnoseTemplate` to key off these honest signals + the taxonomy so proposals fire; bring `SelfImprovement.tsx` to the mock's fidelity (before→after instruction-diff modal, confidence, predicted lift, review/approve/dismiss/rollback).
- **SP3** — learning-log timeline + applied-change outcome verification (version-comparison falsifier + counterfactual judgment surfaced).
