# Per-Source Calibration (Phase 2b-ii) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-home feedback calibration from per-tier to per-artifact-source and reconnect it to the composed score, so a source's measured survival (against the independent refute signal) feeds its confidence — completing Decision "C".

**Architecture:** Shared `sourcesPassed`/`SOURCE_CONFIDENCE` (one source of truth for score + calibration). `computeCalibration` rewritten per-source (executable/grounding measured against refute; review/self designed-not-measured). `effectiveSourceConfidence` feeds the measured rate into `composedScore`'s `base`. `CalibrationEntry`/contract re-keyed `tier → source`; the per-step calibration insight speaks per-source.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Vitest, pnpm workspace. Daemon + contract + desktop-fixture reshape.

**Spec:** `docs/superpowers/specs/2026-07-17-per-source-calibration-design.md`

## Global Constraints

- **Only `executable` + `grounding` are calibratable** (refute is independent of them). **`independent_review` (circular — it IS refute) and `self_report` keep designed priors, `state: "unmeasurable"`, `measured: null`.**
- **Source-pass predicates are shared** between `composedScore` and `computeCalibration` (factored) so they agree by construction — same gates as 2b-i: executable = `sensorsRun.length>0 && oracleAdequacy.sufficient`; grounding = enforce-mode non-skipped check + `verdict:"passed"`.
- **Survival** = among a source's passing completions that had a refute run, `upheld / (upheld + refuted)`. Coverage gate `CALIBRATION_COVERAGE` (refutes-run/bucket ≥ 0.5) → else `unmeasurable`. Thresholds `CALIBRATION_MIN` (report) / `CALIBRATION_SCORE_MIN` (feed score).
- **`executable` measured can only LOWER it** (capped at the 1.0 prior); **`grounding`** moves either way in [0,1]; review/self never move.
- **No score-shape change** (`StepMetrics.score` stays `number|null`); recompute-safe, no migration.
- **`scoreBreakdown`, `scoreOver`'s conclusive/hard-fail discipline, `vFail`, `classifyTier`** all unchanged — 2b-ii only changes the `cᵢ` values `base` compounds and the calibration model.
- **No jargon** in the per-source insight text.

---

## File Structure

**Create:**
- `apps/daemon/src/metrics/source-signals.ts` — `sourcesPassed`, `SOURCE_CONFIDENCE`, `CalibrationSource`.
- `apps/daemon/src/metrics/source-signals.test.ts`.

**Modify:**
- `apps/daemon/src/metrics/composed-score.ts` — use `sourcesPassed`/`SOURCE_CONFIDENCE`; gain `calibration?` param (Task 3).
- `apps/daemon/src/metrics/verification.ts` — per-source `computeCalibration`; `effectiveSourceConfidence`; remove dead `effectiveTierConfidence`; `CalibrationEntry` `tier → source`.
- `packages/contracts/src/metrics/index.ts` — `summary.calibration` entry `tier → source`.
- `apps/daemon/src/metrics/aggregate.ts` — pass `input.calibration` into `composedScore` (Task 3); `deriveInsights` per-source.
- Test fixtures with a `calibration` array: `apps/desktop/src/metrics/MetricsPage.test.tsx`, `apps/desktop/src/metrics/no-jargon.test.tsx`, and any daemon calibration test.

---

## Task 1: Shared source signals

**Files:**
- Create: `apps/daemon/src/metrics/source-signals.ts`, `apps/daemon/src/metrics/source-signals.test.ts`
- Modify: `apps/daemon/src/metrics/composed-score.ts` (use the shared helpers)

**Interfaces:**
- Produces: `CalibrationSource = "executable"|"grounding"|"independent_review"|"self_report"`; `SOURCE_CONFIDENCE: Record<CalibrationSource, number>` = `{executable:1.0, grounding:0.7, independent_review:0.55, self_report:0.3}`; `sourcesPassed(ev, rf): { executable, grounding, independentReview }`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/source-signals.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sourcesPassed, SOURCE_CONFIDENCE } from "./source-signals.js";

const ev = (o: Record<string, unknown>) => ({ sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, ...o }) as never;

describe("sourcesPassed", () => {
  it("executable needs sensors ran AND sufficient", () => {
    expect(sourcesPassed(ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } }), null).executable).toBe(true);
    expect(sourcesPassed(ev({ sensorsRun: [], oracleAdequacy: { sufficient: true, gaps: [] } }), null).executable).toBe(false); // no sensors
    expect(sourcesPassed(ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: false, gaps: [] } }), null).executable).toBe(false); // not sufficient
  });
  it("grounding needs an enforce-mode non-skipped check + verdict passed", () => {
    expect(sourcesPassed(ev({ grounding: { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] } }), null).grounding).toBe(true);
    expect(sourcesPassed(ev({ grounding: { verdict: "passed", checks: [{ mode: "observe", result: "passed" }] } }), null).grounding).toBe(false); // no enforce
  });
  it("independentReview is refute upheld", () => {
    expect(sourcesPassed(null, { verdict: "upheld" } as never).independentReview).toBe(true);
    expect(sourcesPassed(null, { verdict: "refuted" } as never).independentReview).toBe(false);
  });
  it("SOURCE_CONFIDENCE holds the four designed priors", () => {
    expect(SOURCE_CONFIDENCE).toEqual({ executable: 1.0, grounding: 0.7, independent_review: 0.55, self_report: 0.3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- source-signals.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the shared module**

Create `apps/daemon/src/metrics/source-signals.ts` (predicates lifted verbatim from `composed-score.ts:18-22`):
```ts
import type { EvidenceFacet, RefuteFacet } from "@orca/contracts";

export type CalibrationSource = "executable" | "grounding" | "independent_review" | "self_report";

// The designed per-source prior confidences — the single source of truth shared by
// composedScore's `base` compounding and per-source calibration.
export const SOURCE_CONFIDENCE: Record<CalibrationSource, number> = {
  executable: 1.0, grounding: 0.7, independent_review: 0.55, self_report: 0.3,
};

// Which independent verifiers PASSED on a completion. Same gates classifyTier uses,
// so score and calibration bucket a completion identically.
export function sourcesPassed(
  ev: EvidenceFacet | null | undefined,
  rf: RefuteFacet | null | undefined,
): { executable: boolean; grounding: boolean; independentReview: boolean } {
  const executable = !!ev && ev.sensorsRun.length > 0 && ev.oracleAdequacy.sufficient === true;
  const grounding =
    ev?.grounding?.verdict === "passed" &&
    (ev.grounding.checks ?? []).some((c) => c.mode === "enforce" && c.result !== "skipped");
  const independentReview = rf?.verdict === "upheld";
  return { executable, grounding: !!grounding, independentReview: !!independentReview };
}
```

- [ ] **Step 4: Refactor `composedScore` to use them (behavior-preserving)**

In `apps/daemon/src/metrics/composed-score.ts`: import `sourcesPassed`, `SOURCE_CONFIDENCE` from `./source-signals.js`; delete the local `C_EXECUTABLE/C_GROUNDING/C_REVIEW/SELF_REPORT` constants (keep `COVERAGE_FLOOR`). Replace lines 18-27:
```ts
  const { executable, grounding, independentReview } = sourcesPassed(ev, rf);
  const cs: number[] = [];
  if (executable) cs.push(SOURCE_CONFIDENCE.executable);
  if (grounding) cs.push(SOURCE_CONFIDENCE.grounding);
  if (independentReview) cs.push(SOURCE_CONFIDENCE.independent_review);
  const base = cs.length === 0 ? SOURCE_CONFIDENCE.self_report : 1 - cs.reduce((p, c) => p * (1 - c), 1);
```

- [ ] **Step 5: Run — source-signals + composedScore both green**

Run: `pnpm --filter @orca/daemon test -- source-signals.test.ts composed-score.test.ts` and `pnpm --filter @orca/daemon typecheck`
Expected: PASS — composedScore behavior unchanged (same priors), all 13 composed-score tests still green.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/source-signals.ts apps/daemon/src/metrics/source-signals.test.ts apps/daemon/src/metrics/composed-score.ts
git commit -m "refactor(metrics): shared sourcesPassed + SOURCE_CONFIDENCE (score & calibration agree)"
```

---

## Task 2: Per-source calibration model

**Files:**
- Modify: `apps/daemon/src/metrics/verification.ts` (computeCalibration, effectiveSourceConfidence, CalibrationEntry; remove dead effectiveTierConfidence)
- Modify: `packages/contracts/src/metrics/index.ts` (summary.calibration `tier → source`)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`deriveInsights` per-source, observational)
- Modify fixtures: `apps/desktop/src/metrics/MetricsPage.test.tsx`, `apps/desktop/src/metrics/no-jargon.test.tsx`, daemon calibration test
- Test: `apps/daemon/src/metrics/verification.test.ts` (or the calibration test file)

**Interfaces:**
- Consumes: `sourcesPassed`, `SOURCE_CONFIDENCE`, `CalibrationSource` (Task 1).
- Produces: `CalibrationEntry = { source: CalibrationSource, assumed, measured: number|null, sampleSize, state }`; `computeCalibration(transitions): CalibrationEntry[]`; `effectiveSourceConfidence(source, calibration?): number`.

- [ ] **Step 1: Write the failing test**

Add to the calibration test file:
```ts
import { computeCalibration, effectiveSourceConfidence, CALIBRATION_SCORE_MIN } from "./verification.js";
// helper txc(runId, {evidence, refute}) mirrors the existing calibration-test fixture builder.

it("computes per-source survival for grounding against refute; review/self unmeasurable", () => {
  // N grounding-passed completions, each with a refute; some refuted.
  const groundingPassed = { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] };
  const ev = (o = {}) => ({ sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, grounding: groundingPassed, ...o });
  const txs = [];
  for (let i = 0; i < 12; i++) txs.push(txc(`r${i}`, { evidence: ev(), refute: { verdict: i < 3 ? "refuted" : "upheld" } })); // 9 upheld / 3 refuted
  const cal = computeCalibration(txs);
  const g = cal.find((c) => c.source === "grounding")!;
  expect(g.state).toBe("measured");
  expect(g.measured).toBeCloseTo(9 / 12, 5);
  expect(cal.find((c) => c.source === "independent_review")!.state).toBe("unmeasurable");
  expect(cal.find((c) => c.source === "self_report")!.measured).toBeNull();
});

it("effectiveSourceConfidence: measured feeds in past threshold; executable capped-down; review/self fixed", () => {
  const measuredCal = [{ source: "grounding", assumed: 0.7, measured: 0.5, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
  expect(effectiveSourceConfidence("grounding", measuredCal)).toBe(0.5);           // measured used
  expect(effectiveSourceConfidence("grounding", undefined)).toBe(0.7);             // prior when no cal
  const exeCal = [{ source: "executable", assumed: 1.0, measured: 1.3, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
  expect(effectiveSourceConfidence("executable", exeCal)).toBe(1.0);              // capped at prior (can't exceed)
  expect(effectiveSourceConfidence("independent_review", measuredCal)).toBe(0.55); // never calibrated
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- verification.test.ts`
Expected: FAIL — `effectiveSourceConfidence` missing / calibration still per-tier.

- [ ] **Step 3: Rewrite `computeCalibration` + add `effectiveSourceConfidence`**

In `apps/daemon/src/metrics/verification.ts`: change `CalibrationEntry` to key on `source`; import from `./source-signals.js`; rewrite `computeCalibration`; add `effectiveSourceConfidence`; **delete `effectiveTierConfidence`** (dead since 2b-i) and the `EVIDENCE_TIERS`/`CALIBRATION_TIERS` bits it used (keep `TIER_CONFIDENCE`/`TIER_LABEL`/`classifyTier`/`strongestTier` — still used for the display tier).
```ts
import { sourcesPassed, SOURCE_CONFIDENCE, type CalibrationSource } from "./source-signals.js";

export type CalibrationEntry = {
  source: CalibrationSource; assumed: number; measured: number | null;
  sampleSize: number; state: "measured" | "insufficient" | "unmeasurable";
};

const CALIBRATABLE: CalibrationSource[] = ["executable", "grounding"];
const ALL_SOURCES: CalibrationSource[] = ["executable", "grounding", "independent_review", "self_report"];

export function computeCalibration(transitions: TemplateTransition[]): CalibrationEntry[] {
  const finals = finalCompletions(transitions);
  return ALL_SOURCES.map((source): CalibrationEntry => {
    const assumed = SOURCE_CONFIDENCE[source];
    if (!CALIBRATABLE.includes(source)) {
      // review is the independent signal itself (circular); self-report has no independent check.
      return { source, assumed, measured: null, sampleSize: 0, state: "unmeasurable" };
    }
    const passedKey = source === "executable" ? "executable" : "grounding";
    const bucket = finals.filter((t) => sourcesPassed(t.transition.evidence, t.transition.refute)[passedKey]);
    const withRefute = bucket.filter((t) => t.transition.refute?.verdict === "upheld" || t.transition.refute?.verdict === "refuted");
    const upheld = withRefute.filter((t) => t.transition.refute?.verdict === "upheld").length;
    const claims = withRefute.length;
    let state: CalibrationEntry["state"];
    if (bucket.length > 0 && withRefute.length / bucket.length < CALIBRATION_COVERAGE) state = "unmeasurable";
    else if (claims < CALIBRATION_MIN) state = "insufficient";
    else state = "measured";
    return { source, assumed, sampleSize: claims, measured: state === "measured" ? upheld / claims : null, state };
  });
}

// Confidence for a source: designed prior until an independent measurement is strong
// enough (measured, ≥ CALIBRATION_SCORE_MIN claims), then the measured survival rate.
// executable is capped at its 1.0 prior — measurement can only LOWER it (a passing check
// that later got refuted was weak; nothing exceeds certainty). review/self never move.
export function effectiveSourceConfidence(source: CalibrationSource, calibration?: CalibrationEntry[]): number {
  const prior = SOURCE_CONFIDENCE[source];
  if (!CALIBRATABLE.includes(source)) return prior;
  const cal = calibration?.find((c) => c.source === source);
  if (!cal || cal.state !== "measured" || cal.measured == null || cal.sampleSize < CALIBRATION_SCORE_MIN) return prior;
  return source === "executable" ? Math.min(cal.measured, prior) : cal.measured;
}
```

- [ ] **Step 4: Reshape the contract**

In `packages/contracts/src/metrics/index.ts`, change the `calibration` entry (the `.strict()` object ~line 58) from `tier: VerificationTier` to:
```ts
    source: z.enum(["executable", "grounding", "independent_review", "self_report"]),
```
(Keep `assumed`/`measured`/`sampleSize`/`state`.)

- [ ] **Step 5: Rewrite `deriveInsights` per-source (still observational in this task)**

In `apps/daemon/src/metrics/aggregate.ts`, replace the `cal = calibration?.find((c) => c.tier === step.verification.tier)` block (~:200-206) with a per-source one. Surface a calibratable source the step actually used (from `step.quality.scoreBreakdown?.verifierMix`) whose measured rate diverges — OBSERVATIONAL wording (Task 3 flips it to "now applied"):
```ts
  const mix = step.quality.scoreBreakdown?.verifierMix;
  for (const c of calibration ?? []) {
    if (c.state !== "measured" || c.measured == null || c.sampleSize < CALIBRATION_SCORE_MIN) continue;
    if (Math.abs(c.measured - c.assumed) <= CALIBRATION_DIVERGENCE) continue;
    const used = c.source === "executable" ? (mix?.executable ?? 0) > 0 : c.source === "grounding" ? (mix?.grounding ?? 0) > 0 : false;
    if (!used) continue;
    const label = c.source === "grounding" ? "Grounding claims" : "Executed checks";
    out.push(`${label} hold up ${Math.round(c.measured * 100)}% of the time here vs the ${Math.round(c.assumed * 100)}% assumed.`);
  }
```

- [ ] **Step 6: Reshape the fixtures**

Update every `calibration: [...]` fixture from `tier:` to `source:` — `apps/desktop/src/metrics/MetricsPage.test.tsx` (empty array, no change), `apps/desktop/src/metrics/no-jargon.test.tsx` (its populated entry → `source:`), and any daemon calibration fixture. Contracts test fixtures too if present.

- [ ] **Step 7: Run + regression**

Run: `pnpm --filter @orca/contracts build && pnpm --filter @orca/contracts test`, `pnpm --filter @orca/daemon test`, `pnpm --filter @orca/desktop test`, `pnpm -w typecheck`.
Expected: PASS. (Score is NOT yet calibrated — composedScore still uses priors — so scoring numbers are unchanged in this task; only the calibration model + insight text changed. Update any calibration-test expectation to the per-source shape, never weaken.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(metrics): per-source calibration model (executable/grounding vs refute; review/self designed)"
```

---

## Task 3: Reconnect the composed score to calibration

**Files:**
- Modify: `apps/daemon/src/metrics/composed-score.ts` (gain `calibration?` param; use `effectiveSourceConfidence`)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (pass `input.calibration` into `composedScore`; flip insight wording to "now applied")
- Test: `apps/daemon/src/metrics/composed-score.test.ts`, `apps/daemon/src/metrics/aggregate.test.ts`

**Interfaces:**
- Consumes: `effectiveSourceConfidence`, `CalibrationEntry` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `composed-score.test.ts`:
```ts
import { effectiveSourceConfidence } from "./verification.js"; // used indirectly; import type CalibrationEntry as needed
it("uses the calibrated grounding confidence when calibration is supplied", () => {
  const groundingEv = { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, grounding: { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] } };
  const cal = [{ source: "grounding", assumed: 0.7, measured: 0.5, sampleSize: 10, state: "measured" }] as never;
  const withCal = composedScore(tx({ evidence: groundingEv }), cal);
  const noCal = composedScore(tx({ evidence: groundingEv }));
  expect(noCal.base).toBeCloseTo(0.7, 5);   // designed prior (2b-i behavior preserved when no calibration)
  expect(withCal.base).toBeCloseTo(0.5, 5); // calibrated grounding survival feeds base
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- composed-score.test.ts`
Expected: FAIL — composedScore ignores calibration.

- [ ] **Step 3: Reconnect composedScore**

In `apps/daemon/src/metrics/composed-score.ts`: import `effectiveSourceConfidence` + `CalibrationEntry` from `./verification.js`; add the param and use it:
```ts
export function composedScore(t: TemplateTransition, calibration?: CalibrationEntry[]): CompletionScore {
  ...
  const { executable, grounding, independentReview } = sourcesPassed(ev, rf);
  const cs: number[] = [];
  if (executable) cs.push(effectiveSourceConfidence("executable", calibration));
  if (grounding) cs.push(effectiveSourceConfidence("grounding", calibration));
  if (independentReview) cs.push(SOURCE_CONFIDENCE.independent_review); // never calibrated (circular)
  const base = cs.length === 0 ? SOURCE_CONFIDENCE.self_report : 1 - cs.reduce((p, c) => p * (1 - c), 1);
  ...
}
```
> Watch for an import cycle: `verification.ts` imports `source-signals.ts`; `composed-score.ts` importing `verification.ts` is fine (verification doesn't import composed-score). Confirm `pnpm typecheck` is clean.

- [ ] **Step 4: Pass calibration at the call site**

In `apps/daemon/src/metrics/aggregate.ts`, the `scoreByCompletion` map (~:316) becomes:
```ts
  const scoreByCompletion = new Map(finalStepCompletes.map((t) => [t, composedScore(t, input.calibration)] as const));
```

- [ ] **Step 5: Flip the insight to "now applied"**

In `deriveInsights` (from Task 2), change the observational wording to reflect that calibration now feeds the score for calibratable sources:
```ts
    out.push(`${label} hold up ${Math.round(c.measured * 100)}% of the time here vs the ${Math.round(c.assumed * 100)}% assumed — the score now uses the measured rate.`);
```

- [ ] **Step 6: Run + regression sweep**

Run: `pnpm --filter @orca/daemon test -- composed-score.test.ts aggregate.test.ts`, then `pnpm --filter @orca/daemon test`, then `pnpm --filter @orca/daemon typecheck`.
Expected: PASS. Any scoring test whose number changes because a measured grounding/executable rate now feeds the score must be recomputed by hand (from the measured `cᵢ`) and updated, never weakened — note each in the report.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/composed-score.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/composed-score.test.ts apps/daemon/src/metrics/aggregate.test.ts
git commit -m "feat(metrics): composed score consumes per-source calibration; insight says applied"
```

---

## Task 4: Verification (full workspace + live)

**Files:** none (verification only).

- [ ] **Step 1: Full workspace green**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`.
Expected: all green (update any remaining calibration/scoring fixture that legitimately changed — recompute, never weaken).

- [ ] **Step 2: Live drive (per `/verify`, needs daemon restart — ask the user first)**

On `orca/adaptive-delivery`: pull the metrics detail and confirm the `summary.calibration` array is now per-source (executable/grounding with measured-vs-assumed; independent_review/self_report `unmeasurable` at their designed priors). If grounding survival is `measured` past threshold and diverges, confirm the affected steps' grounding-derived scores reflect the measured rate (vs the pre-restart 0.7-prior scores) and the per-step insight reads "…the score now uses the measured rate." Review/self never move.

- [ ] **Step 3: Final commit (if verification fixups were needed)**

```bash
git add -A && git commit -m "test(metrics): per-source calibration fixture/number updates (Phase 2b-ii)"
```

---

## Self-Review notes
- **Spec coverage:** shared source-signals + SOURCE_CONFIDENCE (§3.1/§6 → Task 1); per-source computeCalibration incl. review/self unmeasurable + effectiveSourceConfidence with executable cap (§3.1/§3.2 → Task 2); contract tier→source + per-source insight (§3.4/§3.5 → Task 2); composedScore reconnect + insight-applied (§3.3 → Task 3); live (§4 → Task 4).
- **Sequencing honesty:** Task 2 lands the calibration MODEL with the insight still observational (calibration not yet feeding the score); Task 3 reconnects AND flips the insight to "now applied" — so the insight is never falsely claiming application before it's true.
- **Type consistency:** `CalibrationSource`/`SOURCE_CONFIDENCE`/`sourcesPassed` (Task 1) match `computeCalibration`/`effectiveSourceConfidence` (Task 2) and `composedScore`'s calibration use (Task 3); `CalibrationEntry.source` matches the contract enum.
