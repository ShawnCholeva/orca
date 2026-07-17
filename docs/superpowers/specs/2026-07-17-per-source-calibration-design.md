# Per-Source Calibration (Scoring Evolution — Phase 2b-ii)

**Date:** 2026-07-17
**Status:** Design — approved, pending spec review
**Scope:** Phase 2b-ii. Re-home feedback calibration from per-tier to per-artifact-source and reconnect it to the composed score. Completes Decision "C". Epistemic bands / tier retirement / gate re-weight / completion-gate telemetry are 2c.

---

## 1. Context & motivation

2b-i replaced the coarse tier-confidence score with a composed **compounding × coverage** score on *designed* per-source priors (executable 1.0 / grounding 0.7 / review 0.55 / self-report 0.3), and disconnected the old *per-tier* calibration from scoring (it became an honest observational per-step insight).

2b-ii restores the self-correcting half — **feedback calibration** (paper §5.2.2, and p.65 "each feedback signal should expose its scope and **uncertainty**… treating feedback as calibrated evidence, not a binary success signal") — but at the granularity the paper wants: **per signal/source**, not per collapsed tier. Each calibratable source's confidence `cᵢ` is measured against an independent ground truth and fed back into the composed `base`.

### The crux: a source cannot calibrate itself (paper-derived)

Calibration measures a source's *survival* against something **independent** of it (the paper's independent-verification principle, §4). Orca's independent check is the **refute** signal (`RefuteFacet` upheld/refuted). But the **`independent_review` source IS refute-upheld** — measuring its survival by refute is circular (always 100%). No signal independent *of* review is captured at step-completion (Phase-1 gate-overturn is a *different* mechanism and must not be conflated). The paper's remedy for "no independent measurement" is not a fabricated self-measure — it is to **expose the uncertainty honestly** (p.65). Therefore:

- **Calibratable: `executable`, `grounding`** — refute is genuinely independent of them.
- **Not calibratable: `independent_review` (circular), `self_report` (no independent signal)** — keep designed priors (0.55 / 0.30), explicitly marked "designed, not measured." (This mirrors today's per-tier system, which already marks `self_reported` `unmeasurable`.)

---

## 2. Goals & non-goals

### Goals
- Per-source calibration: measure `executable`/`grounding` survival against refute; re-key the calibration model from tier to source.
- Reconnect calibration to the score: `composedScore`'s `base` uses `effectiveSourceConfidence(source, calibration)` for the calibratable sources.
- Honest readout: the per-step calibration insight speaks per-source, and says calibration is now *applied* to the calibratable sources (reversing 2b-i's observational-only wording for those), while marking review/self designed-not-measured.

### Non-goals (2b-ii)
- Epistemic bands / retiring `classifyTier` / the tier pill — 2c.
- Calibrating review against gate-overturns — rejected (different mechanism; conflation).
- Cross-goal/global calibration — stays per-template (non-negotiable, per Phase-5 scope).
- No score-shape change (`StepMetrics.score` stays `number|null`); recompute-safe, no migration.

---

## 3. Design

### 3.1 Per-source survival — rewrite `computeCalibration`

`apps/daemon/src/metrics/verification.ts`. Replace the per-tier bucketing with per-source. For each **calibratable source** (`executable`, `grounding`):
- **Bucket** = final completions where that source passed (executable: `sensorsRun.length>0 && oracleAdequacy.sufficient`; grounding: an enforce-mode non-skipped check + verdict passed — the SAME gates 2b-i's `composedScore` uses; factor the source-pass predicates into shared helpers so score and calibration agree, mirroring how `isCodeFile` is shared).
- **Independent ground truth** = the `refute` verdict on those completions. `survived` = refute `upheld`; `overturned` = refute `refuted`; a completion with no refute contributes to the bucket size but not the measurement.
- **measured** = `survived / (survived + overturned)`; `null` until enough.
- **Coverage gate** (reuse `CALIBRATION_COVERAGE`): require `refutesRun / bucketSize ≥ 0.5` before trusting the rate (few refutes ⇒ `unmeasurable`).
- **State** (reuse `CALIBRATION_MIN`/`CALIBRATION_SCORE_MIN`): `measured` (≥ MIN claims, coverage met) / `insufficient` / `unmeasurable`.
- **review + self_report**: always `unmeasurable` with `assumed` = their designed prior (0.55 / 0.30), `measured: null`.

`CalibrationEntry` is re-keyed:
```
CalibrationEntry = { source: "executable"|"grounding"|"independent_review"|"self_report",
                     assumed: number, measured: number|null, sampleSize: number,
                     state: "measured"|"insufficient"|"unmeasurable" }
```
(`TIER_CONFIDENCE` stays for `classifyTier`'s display tier; a new `SOURCE_CONFIDENCE` map holds the four source priors — the same numbers `composedScore` already uses as constants; factor those constants into the shared map so score and calibration share one source of truth.)

### 3.2 `effectiveSourceConfidence` — feed measured rate into the score

```
effectiveSourceConfidence(source, calibration?): number
```
- Designed prior (`SOURCE_CONFIDENCE[source]`) until a `measured` entry with `sampleSize ≥ CALIBRATION_SCORE_MIN` exists for that source, then the measured rate.
- **`executable` is capped at its 1.0 prior** — measurement can only *lower* it (a passing check that later got refuted was a weak check; it can never exceed certainty).
- **`grounding`** can move either way within [0,1].
- **`independent_review`/`self_report`**: always the designed prior (never measured).

### 3.3 Reconnect `composedScore` to calibration

`apps/daemon/src/metrics/composed-score.ts`: `composedScore` gains an optional `calibration?: CalibrationEntry[]` param. In `base`, replace the constants with `effectiveSourceConfidence`:
- executable `cᵢ` = `effectiveSourceConfidence("executable", cal)` (still gated on `sensorsRun>0 && sufficient`).
- grounding `cᵢ` = `effectiveSourceConfidence("grounding", cal)` (still gated on enforce-check + passed).
- review `cᵢ` = designed 0.55; self-report floor = 0.30 (unchanged).
- Fail edges, coverage, floor: all unchanged.

`aggregate.ts`: `computeStepMetrics` already computes `input.calibration`; pass it into `composedScore(t, input.calibration)` (the `scoreByCompletion` map). No change to `scoreOver`'s structure or the conclusive/hard-fail discipline.

### 3.4 Honest per-source insight — update `deriveInsights`

`deriveInsights` (`aggregate.ts`) currently emits the 2b-i *observational* calibration line (per-tier). Rewrite it per-source:
- For a calibratable source with a `measured` + divergent (> `CALIBRATION_DIVERGENCE`) entry that now feeds the score: *"Grounding claims hold up {measured}% of the time here vs the {assumed}% assumed — the score now uses the measured rate."* (Honest: in 2b-ii it IS applied.)
- Never emit a "measured" claim for review/self (they're designed) — if surfaced at all, phrase as designed.
- Keep jargon-free; keep the n≥threshold + divergence gating for WHEN it appears.

### 3.5 Contract + desktop

- `packages/contracts/src/metrics/index.ts`: `summary.calibration` entry `tier` → `source` (enum of the four sources). `.strict()`.
- **No dedicated desktop calibration panel exists** — `summary.calibration` is consumed by `deriveInsights` (daemon) to produce `step.insights` text, which the desktop renders as-is. So the desktop change is limited to **reshaping the two test fixtures** that build a `calibration` array (`MetricsPage.test.tsx`, `no-jargon.test.tsx`) from `tier:` to `source:`.

### 3.6 Backward-compat
Scores + calibration recompute from persisted transitions on read; no migration. Historical data re-buckets per-source automatically.

---

## 4. Testing & verification

- **Unit (daemon) — `computeCalibration` per-source:** executable/grounding buckets by the shared source-pass predicates; measured = survived/(survived+overturned) among refuted-run completions; coverage gate; state transitions (measured/insufficient/unmeasurable); review/self always unmeasurable at designed prior.
- **`effectiveSourceConfidence`:** designed prior below threshold; measured at/above; executable capped at 1.0 (measured can't raise it); grounding moves both ways; review/self never move.
- **`composedScore` with calibration:** a grounding-only step with measured grounding survival 0.5 (≥ score-min samples) scores with `base=0.5` not 0.7; the same step with `undefined` calibration uses the 0.7 prior (2b-i behavior preserved); executable calibrated-down lowers a sensor step; review/self unaffected.
- **`deriveInsights`:** per-source wording; asserts it does NOT claim to measure review/self; asserts it DOES say the measured rate feeds the score for a calibrated source.
- **Regression:** full daemon suite green; contracts fixtures + the 2 desktop calibration fixtures reshaped; any scoring test whose number changes because calibration now feeds the score recomputed by hand, never weakened.
- **Live (per `/verify`, needs daemon restart):** on `orca/adaptive-delivery`, confirm grounding's per-source calibration entry appears (measured vs assumed) and — if grounding survival diverges past threshold with enough samples — a step's grounding-derived score reflects the measured rate; the per-source insight reads honestly; review/self show as designed.

---

## 5. `agent-harness.pdf` alignment
| Paper mandate | 2b-ii element |
|---|---|
| §5.2.2 / p.65 feedback calibration, "each signal exposes its uncertainty" | per-source calibration of executable/grounding confidences |
| §4 independent verification channels | survival measured against the independent `refute` signal |
| p.65 expose uncertainty honestly when unmeasurable | review (circular) + self kept as designed priors, marked not-measured |
| §5.2.2 "if the verifier is weak, the agent learns the wrong signal" | executable capped-down when passing checks get refuted; feeds Phase-3 honest inputs |

## 6. Open items for the implementation plan
- Shared source-pass predicate helpers (executable/grounding) factored so `composedScore` and `computeCalibration` agree by construction.
- The `SOURCE_CONFIDENCE` map location (contract vs verification.ts) so score + calibration share one prior table.
- Exact per-source insight wording (short, honest, jargon-free) for the divergent-measured case.
