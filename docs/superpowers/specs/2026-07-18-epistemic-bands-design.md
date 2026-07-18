# Epistemic Bands (Scoring Evolution — Phase 2c-i)

**Date:** 2026-07-18
**Status:** Design — approved, pending spec review
**Scope:** Phase 2c-i. Retire the 5-tier display pill into three composed-derived **epistemic bands** (strong / weak / needs-more-evidence). Gate-groundedness re-weight (2c-ii) and completion-gate telemetry (2c-iii) are separate slices.

---

## 1. Context & motivation

Since 2b-i the step score has been the composed compounding × coverage number, but the UI still shows the **tier pill** (`verification.tierLabel` from `classifyTier`: "Run & tested" / "Partly verified" / …) — deliberately "kept for display" while the score went composed. 2c-i retires it.

**The point is not cosmetic.** After 2b-ii, a grounding-only step can score **95 / grade A** (grounding calibrated to 1.0). The grade says *how good the number is*; it does not say *how the work was verified*. The paper's epistemic-awareness (§5.2.2: "feedback loops that are… **epistemically aware: the harness should know when a signal is strong enough to act on, when it is weak, and when additional evidence is required**") is about **verification kind and independence, not score magnitude**. So a 95/A step that was only *reviewed* (never executed) must read **"Weakly verified"** — an honest high-number-but-not-proven signal. The band is **orthogonal to the grade** and surfaces exactly what the grade hides.

### `agent-harness.pdf` alignment
- §5.2.2 epistemic-awareness → the three bands are "strong enough to act on / weak / needs more evidence."
- §5.2.1 verification strength is a **rate** (coverage, oracle diversity) → the strong/weak split is proportional (majority of completions), not a binary any/all trigger.
- §5.2.2 "calibrated evidence, not a binary success signal" + "the green test is not the full specification" → majority threshold (one green run doesn't make a step proven; one reasoning-only run doesn't unprove a tested step).
- §5.2.7 inspectable → the band is a first-class, Phase-3-reusable field, derived from the already-inspectable `scoreBreakdown`.

---

## 2. Goals & non-goals

### Goals
- Add a per-step **epistemic band** derived from the composed evidence model (not `classifyTier`).
- Retire the tier pill + 5-segment tier meter from the UI, replaced by the band.
- The band is orthogonal to the grade: a high-grade, review-only step reads "Weakly verified."

### Non-goals (2c-i)
- Gate-groundedness re-weight (2c-ii); completion-gate telemetry (2c-iii).
- Changing the SCORE or calibration — band is a *label* derived from existing signals; no scoring change.
- Removing `classifyTier`/`verification.tier`/`tierLabel` — they stay as internal fields (conclusiveness gate, `strongestTier`, back-compat); only their *display* is retired.

---

## 3. Design

### 3.1 The band and its derivation (daemon)

`verification.band: { level: "strong" | "weak" | "needs_evidence", label: string }`, computed in `computeStepMetrics` (`aggregate.ts`) from the **scored, non-fail-edge completions** (the same `concScores` set the 2b-i `scoreBreakdown` is built over — a `CompletionScore` per completion with `verifiers` + `base`):

- **`needs_evidence`** — `score == null` (no conclusive verification ran). Label: **"Needs more evidence"**.
- **`strong`** — of the scored completions (`base > 0`), execution verified the **majority**: `count(verifiers.executable) > scoredCount / 2`. Label: **"Strongly verified"**.
- **`weak`** — scored but execution was the minority/absent (grounding/review-only dominant). Label: **"Weakly verified"**.

`scoredCount` = number of `concScores` with `base > 0` (excludes fail-edge, matching the 2b-i breakdown convention). Pure; derived alongside `scoreBreakdown`, no new inputs. The band never contradicts the score's existence (null → needs_evidence) but is deliberately independent of the score *magnitude* (a high grade can be "weak").

> Rationale for majority (paper-derived, §5.2.1/§5.2.2): verification strength is a rate; "strong enough to act on" = the typical completion was executed; any/all are binary triggers the paper argues against.

### 3.2 Contract

Add `band` to `StepMetrics.verification` (`packages/contracts/src/metrics/index.ts:193`):
```
band: z.object({ level: z.enum(["strong", "weak", "needs_evidence"]), label: z.string() }).strict(),
```
Additive. `tier`/`tierLabel` stay (internal/back-compat).

### 3.3 Desktop — retire the pill + meter into the band

`apps/desktop/src/metrics/StepPerformance.tsx` + `metrics-data.ts`:
- **Pill** (`StepPerformance.tsx:76`): render `step.verification.band.label` instead of `tierLabel`. Colour by band level via a new `bandMeta` map (strong → `var(--run)`, weak → `var(--warn)`, needs_evidence → `var(--accent)`). The existing `status`/score colouring (the ordinal badge, the score number) is unchanged — the band pill and the score are now two distinct readouts (kind vs magnitude).
- **Tier meter** (`StepPerformance.tsx:102`, the 5-segment bar ranked by tier index): replace with a **3-segment band strength indicator** (needs_evidence → 1 filled, weak → 2, strong → 3), coloured by band level.
- `metrics-data.ts`: add `bandMeta: Record<level, { label; color }>`. `verificationMeta` (the per-tier label/colour map) is no longer used for the pill — leave it only if some other consumer needs it, else remove.
- **Jargon-free**: "Strongly verified" / "Weakly verified" / "Needs more evidence" pass the `no-jargon` bar.

### 3.4 Backward-compat
Recompute-from-persisted (no migration). `verification.tier`/`tierLabel` remain in the contract, so any non-desktop consumer is unaffected; only the desktop step-detail stops *rendering* them.

---

## 4. Testing & verification

- **Unit (daemon):** band derivation — `score == null` → needs_evidence; majority-executable → strong; grounding/review-only (no execution) → weak; a mixed step where execution is the minority → weak; the boundary (exactly 50%) → weak (strict `>`). Assert a HIGH-scoring grounding-only step (e.g. score 95 via calibrated grounding) still bands **weak** — the headline honesty case.
- **Contract:** `verification.band` parses; additive (existing fixtures without it fail only if made required — it IS required, so fixtures/producers must supply it; the daemon always does — update daemon fixtures, and any desktop fixture building a `verification` object, `tier→` keep + add `band`).
- **Desktop:** the pill renders the band label (not the old tier label); the 3-segment indicator reflects the level; `no-jargon` passes; a grounding-only high-score fixture shows "Weakly verified" alongside its A grade.
- **Regression:** full workspace green.
- **Live (per `/verify`, needs daemon restart):** on `orca/adaptive-delivery`, confirm the grounding-verified steps (Triage/Proposal, high scores post-2b-ii) now show **"Weakly verified"** (reviewed, not executed) while Execution (sensors) shows **"Strongly verified"** — the band honestly separating kind from the score.

> **Contract note:** `verification.band` is REQUIRED (the daemon always computes it). Per the Phase-1 lesson, this ripples to every fixture building a `verification` object — the plan must update them all (daemon + desktop). If the ripple is large, the plan may instead make it optional; the daemon still always emits it.

---

## 5. Open items for the implementation plan
- Confirm the exact `scoredCount` denominator source in `aggregate.ts` (the `concScores.filter(base>0)` set) and that band computation sits with the `scoreBreakdown` build.
- Decide required-vs-optional for `verification.band` based on the fixture-ripple size (Phase-1 lesson).
- Whether the 3-segment indicator replaces the meter in-place or the meter is dropped for a simpler chip.
- Any non-pill consumer of `verification.tierLabel` (e.g. `reconciliation.verifiedTierLabel` is a *separate* field — out of scope) that should also move — default: no, keep 2c-i to the pill + meter.
