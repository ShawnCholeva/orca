# Composed Verification Score (Scoring Evolution — Phase 2b-i)

**Date:** 2026-07-16
**Status:** Design — approved, pending spec review
**Scope:** Phase 2b-i. Replaces the coarse tier-confidence step score with a composed compounding × coverage score on **designed per-source priors**. Per-source **calibration** re-home is 2b-ii; epistemic bands / gate re-weight / completion-gate telemetry are 2c.

---

## 1. Context & motivation

Phase 2a made the evidence bundle honestly declare *what it couldn't verify* (`untestedRegions`/`oracleAdequacy.gaps` now populated deterministically). Phase 2b turns that into an honest **score**.

Today the step score is a coarse 5-bucket collapse: each completion → `classifyTier` → weight = `effectiveTierConfidence(tier, calibration)` (`aggregate.ts:320-321`), tiers = `verified_executed 1.0 / partially_verified 0.7 / ai_reviewed 0.55 / self_reported 0.3 / unverified 0`. The paper (§5.2.2) calls this exactly the failure mode to fix: verification treated "as a single terminal signal" creates "a false sense of correctness." Live proof on `orca/adaptive-delivery`: **Research and Proposal have byte-identical evidence (same tier, same grounding FAIL, same review pass) yet score 66 vs 100** — the tier collapse plus per-tier calibration averaged the failure away.

2b-i implements the paper's **composed verification stack** (§5.2.2): compose the artifacts, each with its confidence, and let coverage cap the result so "the green test is not the full specification" is real. The compounding × coverage formula was validated on live Adaptive Delivery data (it beat weighted-sum — too lenient — and weakest-link — too harsh — and fixed the Research/Proposal incoherence). Decision "C" (locked in the phase2-scoring-evolution memory): full **replace** of the tier score, with calibration re-homed to per-source — sequenced 2b-i (score) → 2b-ii (calibration).

### `agent-harness.pdf` alignment
- §5.2.2 composed verification stack with explicit scope; "each artifact declares its confidence" → per-source `cᵢ` compounded.
- §5.2.2 "the green test is not the full specification" → coverage caps the score (2a's real untested data).
- §5.2.2 independent verification → **independent** verifiers compound; self-report is a floor, never compounded.
- §5.2.1 verification strength = coverage · oracle diversity · **rate of false acceptance** → a refuted completion scores 0.
- §5.2.7 inspectable → the composed score carries a breakdown of *why*.

---

## 2. Goals & non-goals

### Goals
- Replace the per-completion tier-confidence weight with a composed compounding × coverage score.
- "Partial" verification (a required sensor couldn't run) becomes a **graded** score, not a total failure.
- The composed score is **inspectable** — carries `base`, `coverage`, and the contributing verifiers.

### Non-goals (2b-i)
- **Calibration** — 2b-i uses designed per-source priors; per-source calibration re-home is **2b-ii**. In 2b-i the existing per-tier `computeCalibration` is disconnected from scoring and left as a **display-only** readout.
- **Retiring the tier label** — `classifyTier` stays (it still gates conclusive-vs-unverified and drives the display pill/meter). Composed epistemic bands are **2c**.
- **Gate groundedness re-weight** and **deterministic-completion-gate telemetry** — **2c**.
- No contract-shape change to `StepMetrics.score` (stays `number | null`); no migration (scores recompute from persisted transitions on read).

---

## 3. Design

### 3.1 Per-completion composed score

New pure function (in `apps/daemon/src/metrics/composed-score.ts`, or alongside `verification.ts`):

```
composedScore(t: TemplateTransition): number
```

Let `ev = t.transition.evidence`, `rf = t.transition.refute`.

**Fail edges first (→ 0):**
- `rf?.verdict === "refuted"` (independent overturn — false acceptance) → **0**.
- `ev?.verdict === "failed"` (a check actually failed) → **0**.

**Otherwise (passed or partial) → `base × coverage`:**

- **`base`** = `1 − ∏(1 − cᵢ)` over the **passing independent verifiers**, floored at `SELF_REPORT = 0.3`:
  - executable: **`ev.oracleAdequacy.sufficient === true`** → `c = 1.0`. (Sufficiency-gated, NOT merely "sensors ran": a *partial* oracle — a required check couldn't run though the ones that did passed — must not earn full executable credit, or a partly-checked change would score 1.0. A partial oracle therefore drops out of `base`, so the score comes from grounding/review and lands honestly below a fully-verified step. This is "the green test is not the full specification" enforced in `base` rather than relying on coverage to catch the kind-gap.)
  - grounding: `ev.grounding?.verdict === "passed"` → `c = 0.7`
  - independent review: `rf?.verdict === "upheld"` → `c = 0.55`
  - if no independent verifier passed → `base = SELF_REPORT` (0.3).
  - (Priors reuse today's `TIER_CONFIDENCE` values by source: verified_executed→executable 1.0, partially_verified→grounding 0.7, ai_reviewed→review 0.55, self_reported→floor 0.3.)
- **`coverage`** = `1.0` **unless** the completion has code files in its write-set **and** `ev.oracleAdequacy.sufficient === false`; then:
  - `coverage = max(COVERAGE_FLOOR, 1 − untestedCodeFiles / totalChangedCodeFiles)`, `COVERAGE_FLOOR = 0.3`.
  - `untestedCodeFiles` = code-file entries in 2a's `ev.untestedRegions` (the per-file "`<path>` — changed, no test or check ran over it" lines); `totalChangedCodeFiles` = code files in the completion's write-set.
  - Non-code completions (no code write-set) → `coverage = 1.0` (execution inapplicable — no double-penalty; the absence of execution is already reflected in `base`).
- **`score = base × coverage`** (∈ [0,1]).

> **Write-set / code-file source (confirmed available).** The composed score needs the completion's code write-set to compute coverage. The metrics `TemplateTransition` **already carries** `stateDeps` — `fetch.ts` `FACET_COLS` loads every facet via `defineFacet`, including `state_deps_json` (`harness/index.ts:233`), and `HarnessTransition.stateDeps: StateDepsFacet.nullable()` holds `write_set`. So `composedScore` reads code files from `t.transition.stateDeps?.write_set` (`kind === "file"` + the code-extension rule 2a uses — factor that extension check into a shared helper so 2a and 2b agree). No fetch change needed. If `stateDeps` is null on a transition, `coverage` defaults to 1.0 (honest: no code-coverage claim to make).

### 3.2 Wire into `scoreOver`

In `aggregate.ts`:
- Replace `contribution` (`:320-321`) — `vFail(t) ? 0 : effectiveTierConfidence(...)` — with `composedScore(t)`.
- **Adjust `vFail`** (`:277-280`): `ev.verdict === "partial"` must no longer be a hard fail. Split the notion: a completion is *conclusive/scored* when it has evidence or a conclusive refute (unchanged — `classifyTier !== "unverified"` still gates `conclusive`); its *contribution* is `composedScore(t)`, which internally returns 0 for real failures (`refuted`/`failed`) and a graded value for partial. Keep the `conclusive`/`unverified` gate and the hard-fail-in-denominator discipline (`:304-319`) exactly as-is — only the per-completion **value** changes.
- `classifyTier` and `effectiveTierConfidence` remain imported: `classifyTier` still determines conclusiveness + the display tier; `effectiveTierConfidence` is **no longer called by scoring** in 2b-i (calibration is display-only until 2b-ii). Leave `computeCalibration` feeding the summary `calibration` readout unchanged.

### 3.3 Inspectable breakdown (§5.2.7)

Add to `StepMetrics.quality` a `scoreBreakdown` (aggregated over the step's scored completions):
```
scoreBreakdown: {
  meanBase: number | null;      // mean base across scored completions
  meanCoverage: number | null;  // mean coverage across scored completions
  coverageLimited: number;      // count of completions whose coverage < 1
  verifierMix: { executable: number; grounding: number; independentReview: number; selfReportOnly: number }; // how many scored completions had each passing verifier
}
```
Purely additive to the contract; lets the UI (and Phase 3) see *why* a step scored what it did. The desktop step-detail renders a one-line "how this score was reached" from it (small, reuses existing text style; full epistemic surfacing is 2c).

### 3.4 What changes numerically (flagged for review)
- **Partial completions** (missing-required sensor) move from **0** to `base × coverage` — an intended honesty upgrade (partial ≠ total failure). Existing step scores that had partial completions will rise.
- **Identical-evidence steps converge** (Research == Proposal). Steps with a grounding FAIL in some completions drop toward the honest value.
- **Full-sensor steps** stay at/near 1.0 (base 1.0 × coverage 1.0). A grounding+review step (no execution — e.g. Triage) lands at ~0.86 (`1−(1−0.7)(1−0.55)`), grounding-only at 0.70 — below the run-and-tested ceiling instead of tying at 100 as the tier calibration does today.
- Because calibration no longer adjusts the score in 2b-i, steps whose per-tier calibration had *raised* them (e.g. partially_verified bumped 0.7→~1.0) will reflect the **designed** prior until 2b-ii re-homes calibration. This is expected and honest (uncalibrated priors), and called out so the shift isn't mistaken for a regression.

---

## 4. Testing & verification

- **Unit (daemon):** `composedScore` fixture tests — refuted → 0; failed → 0; full sensor pass (sufficient) → 1.0; grounding+review (no execution) → ~0.86; grounding-only → 0.70; self-report-only → 0.3 floor; **partial oracle (sensors ran, `sufficient=false`)** → executable excluded from base, score = grounding/review base × 1.0 (not 1.0, not 0); code write-set + no execution → coverage = exercised-fraction floored (0.3 when 0 files exercised); non-code → coverage 1.0 (no double-penalty); coverage ∈ [floor,1].
- **`scoreOver` tests:** the Research/Proposal-style identical-evidence fixtures now converge; hard-fail-in-denominator + conclusive/unverified gates unchanged; a step with only unverified completions still scores `null`.
- **Breakdown tests:** `scoreBreakdown` aggregates correctly; additive contract parses.
- **Regression:** full daemon suite green; existing scoring tests whose expected numbers legitimately change (partial→graded; calibration no longer bumping) updated to the correct new value with a noted reason, never weakened.
- **Live (per `/verify`, needs daemon restart):** on `orca/adaptive-delivery`, confirm Research and Proposal now show the **same** score; a grounding-only step scores below a full-sensor step; the step-detail shows the "how this score was reached" breakdown; no step that was adequately verified drops misleadingly.

---

## 5. Open items for the implementation plan
- The shared code-file-extension helper (factor 2a's list out of `scope.ts` so 2b reuses it).
- `stateDeps.write_set` is confirmed available on the metrics `TemplateTransition` (§3.1) — the plan just consumes it; no fetch change.
- Whether `scoreBreakdown.verifierMix` counts are needed by the UI in 2b-i or can wait for 2c (keep the field, minimal UI).
- Confirm no consumer of `StepMetrics.score` assumes the old tier-quantized values (workflow-health mean, Phase 3 learning — both take the number as-is).
