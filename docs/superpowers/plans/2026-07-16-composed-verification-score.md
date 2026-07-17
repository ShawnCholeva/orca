# Composed Verification Score (Phase 2b-i) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coarse tier-confidence step score with a composed **compounding × coverage** score on designed per-source priors, so the score honestly reflects *which* verifiers ran and *how much* they covered.

**Architecture:** A new pure `composedScore(transition)` computes `base × coverage` per completion; it replaces the `contribution` weight inside `scoreOver` (`aggregate.ts:320`). `base` compounds passing independent verifiers (executable sufficiency-gated 1.0 / grounding 0.7 / review 0.55; self-report 0.3 floor); `coverage` caps a code change whose oracle was inadequate, from 2a's per-file untested data. An optional inspectable `scoreBreakdown` rides on `StepMetrics.quality`. `classifyTier` stays (conclusiveness + display pill); calibration goes display-only.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Vitest, pnpm workspace. Daemon + one small desktop render.

**Spec:** `docs/superpowers/specs/2026-07-16-composed-verification-score-design.md`

## Global Constraints

- **`composedScore` is pure** over one transition; deterministic; no I/O.
- **Fail edges → 0:** refute `refuted` OR evidence `verdict: "failed"` → score 0.
- **executable is SUFFICIENCY-gated:** contributes `c=1.0` only when `evidence.oracleAdequacy.sufficient === true`. A partial oracle drops out of `base` (must not score 1.0).
- **No double-penalty:** `coverage = 1.0` for non-code completions and for `sufficient` completions; it only bites when a **code** change had `sufficient === false`.
- **`coverage`** (that one case) = `max(0.3, 1 − untestedCodeFiles / totalChangedCodeFiles)` from 2a's per-file `untestedRegions`.
- **`base` floor** = self-report 0.3 when no independent verifier passed.
- **Preserve the aggregate discipline:** `scoreOver`'s conclusive/unverified gate and hard-fail-in-denominator logic (`aggregate.ts:304-327`) are UNCHANGED — only the per-completion value changes. **Do NOT change `vFail`** — it serves the separate `verdictPassRate` channel; `composedScore` handles partial→graded internally without it.
- **`StepMetrics.score` shape unchanged** (`number | null`, 0-100); no migration (recompute-from-persisted).
- **`scoreBreakdown` is OPTIONAL** on the contract — avoids the required-field fixture ripple; the daemon always emits it, consumers treat it as optional.
- **`classifyTier`/`strongestTier` stay** (conclusiveness + display tier); `effectiveTierConfidence` is no longer called by scoring (calibration display-only until 2b-ii).

---

## File Structure

**Create:**
- `apps/daemon/src/harness-sensors/code-files.ts` — shared `isCodeFile`/`CODE_EXTS` (factored out of `scope.ts`).
- `apps/daemon/src/metrics/composed-score.ts` — `composedScore` + `CompletionScore` type.
- `apps/daemon/src/metrics/composed-score.test.ts`.

**Modify:**
- `apps/daemon/src/harness-sensors/scope.ts` — import `isCodeFile` from the shared module (remove the local copy).
- `packages/contracts/src/metrics/index.ts` — add optional `scoreBreakdown` to `StepMetrics.quality`.
- `apps/daemon/src/metrics/aggregate.ts` — replace `contribution` with `composedScore(...).score`; build `scoreBreakdown`.
- `apps/daemon/src/metrics/aggregate.test.ts` (+ scoring tests) — convergence + numeric-shift updates.
- `apps/desktop/src/metrics/StepPerformance.tsx` — render a one-line "how this score was reached" from `scoreBreakdown` (optional-safe).

---

## Task 1: Factor out the shared code-file helper

**Files:**
- Create: `apps/daemon/src/harness-sensors/code-files.ts`
- Modify: `apps/daemon/src/harness-sensors/scope.ts:3-12`
- Test: `apps/daemon/src/harness-sensors/code-files.test.ts`

**Interfaces:**
- Produces: `isCodeFile(path: string): boolean` and `CODE_EXTS` — the exact set currently in `scope.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/harness-sensors/code-files.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isCodeFile } from "./code-files.js";

describe("isCodeFile", () => {
  it("classifies by extension, case-insensitive", () => {
    expect(isCodeFile("src/calc.ts")).toBe(true);
    expect(isCodeFile("src/App.TSX")).toBe(true);
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("docs/plan")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- code-files.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the shared module**

Create `apps/daemon/src/harness-sensors/code-files.ts` with the exact content moved from `scope.ts:3-12`:
```ts
// Code-file extensions for write-set classification. Deliberately conservative;
// a file not matched here is treated as non-code output. Shared by scope.ts (2a)
// and metrics/composed-score.ts (2b) so both agree on what "code" means.
export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".rb", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".swift", ".kt", ".scala", ".sh",
]);
export function isCodeFile(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && CODE_EXTS.has(p.slice(dot).toLowerCase());
}
```

- [ ] **Step 4: Update `scope.ts` to import it**

In `apps/daemon/src/harness-sensors/scope.ts`, delete the local `CODE_EXTS`/`isCodeFile` (lines 3-12) and add:
```ts
import { isCodeFile } from "./code-files.js";
```
(Everything else in `scope.ts` — `SENSOR_GAP_PHRASE`, `deriveEvidenceScope`, the `codeFiles = input.writeSet.filter(isCodeFile)` call — stays.)

- [ ] **Step 5: Run to verify both green**

Run: `pnpm --filter @orca/daemon test -- code-files.test.ts scope.test.ts` and `pnpm --filter @orca/daemon typecheck`
Expected: PASS; scope.test.ts unaffected (same `isCodeFile` behavior).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/harness-sensors/code-files.ts apps/daemon/src/harness-sensors/code-files.test.ts apps/daemon/src/harness-sensors/scope.ts
git commit -m "refactor(daemon): shared isCodeFile helper (used by 2a scope + 2b score)"
```

---

## Task 2: `composedScore` pure function

**Files:**
- Create: `apps/daemon/src/metrics/composed-score.ts`
- Test: `apps/daemon/src/metrics/composed-score.test.ts`

**Interfaces:**
- Consumes: `TemplateTransition` (`./fetch.js`), `isCodeFile` (Task 1).
- Produces: `CompletionScore = { score: number; base: number; coverage: number; verifiers: { executable: boolean; grounding: boolean; independentReview: boolean } }`; `composedScore(t: TemplateTransition): CompletionScore`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/composed-score.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { composedScore } from "./composed-score.js";
import type { TemplateTransition } from "./fetch.js";

const tx = (over: Record<string, unknown>): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s",
  transition: { workflowRunId: "r", boundary: "step_complete", createdAt: "2026-07-16T00:00:00Z", ...over } as never,
});
const ev = (o: Record<string, unknown>) => ({ sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, ...o });

describe("composedScore", () => {
  it("refuted → 0", () => expect(composedScore(tx({ refute: { verdict: "refuted" } })).score).toBe(0));
  it("evidence failed → 0", () => expect(composedScore(tx({ evidence: ev({ verdict: "failed" }) })).score).toBe(0));
  it("full sensor pass (sufficient) → 1.0", () => {
    const r = composedScore(tx({ evidence: ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } }) }));
    expect(r.score).toBe(1); expect(r.base).toBe(1); expect(r.coverage).toBe(1);
  });
  it("grounding + review, no execution → ~0.86", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: { verdict: "passed" } }), refute: { verdict: "upheld" } }));
    expect(r.base).toBeCloseTo(0.865, 3); expect(r.coverage).toBe(1); expect(r.score).toBeCloseTo(0.865, 3);
  });
  it("grounding only → 0.70", () => {
    expect(composedScore(tx({ evidence: ev({ grounding: { verdict: "passed" } }) })).score).toBeCloseTo(0.7, 5);
  });
  it("self-report only (no verifiers) → 0.30 floor", () => {
    expect(composedScore(tx({ evidence: ev({}) })).score).toBeCloseTo(0.3, 5);
  });
  it("partial oracle (sensors ran, sufficient=false) → executable excluded, grounding base × 1.0", () => {
    const r = composedScore(tx({ evidence: ev({ sensorsRun: [{ kind: "typecheck" }], verdict: "partial", grounding: { verdict: "passed" } }) }));
    expect(r.verifiers.executable).toBe(false); // sufficiency-gated
    expect(r.base).toBeCloseTo(0.7, 5); expect(r.coverage).toBe(1); expect(r.score).toBeCloseTo(0.7, 5);
  });
  it("code change, no execution → coverage floors from per-file untested", () => {
    const r = composedScore(tx({
      evidence: ev({ grounding: { verdict: "passed" }, untestedRegions: ["src/a.ts — changed, no test or check ran over it"] }),
      stateDeps: { write_set: [{ kind: "file", ref: "src/a.ts", change_kind: "modified" }] },
    }));
    expect(r.coverage).toBeCloseTo(0.3, 5); // 1 of 1 code file untested → floor
    expect(r.score).toBeCloseTo(0.7 * 0.3, 5);
  });
  it("non-code write-set → coverage 1.0 (no double-penalty)", () => {
    const r = composedScore(tx({
      evidence: ev({ grounding: { verdict: "passed" }, untestedRegions: ["semantic correctness — nothing was executed"] }),
      stateDeps: { write_set: [{ kind: "file", ref: "docs/x.md", change_kind: "modified" }] },
    }));
    expect(r.coverage).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- composed-score.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `composedScore`**

Create `apps/daemon/src/metrics/composed-score.ts`:
```ts
import type { TemplateTransition } from "./fetch.js";
import { isCodeFile } from "../harness-sensors/code-files.js";

const C_EXECUTABLE = 1.0, C_GROUNDING = 0.7, C_REVIEW = 0.55, SELF_REPORT = 0.3, COVERAGE_FLOOR = 0.3;

export type CompletionScore = {
  score: number; base: number; coverage: number;
  verifiers: { executable: boolean; grounding: boolean; independentReview: boolean };
};

export function composedScore(t: TemplateTransition): CompletionScore {
  const ev = t.transition.evidence;
  const rf = t.transition.refute;
  const zero = (): CompletionScore => ({ score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  if (rf?.verdict === "refuted") return zero();
  if (ev?.verdict === "failed") return zero();

  const executable = ev?.oracleAdequacy.sufficient === true;   // sufficiency-gated
  const grounding = ev?.grounding?.verdict === "passed";
  const independentReview = rf?.verdict === "upheld";
  const cs: number[] = [];
  if (executable) cs.push(C_EXECUTABLE);
  if (grounding) cs.push(C_GROUNDING);
  if (independentReview) cs.push(C_REVIEW);
  const base = cs.length === 0 ? SELF_REPORT : 1 - cs.reduce((p, c) => p * (1 - c), 1);

  const coverage = computeCoverage(t, ev);
  return { score: base * coverage, base, coverage, verifiers: { executable, grounding, independentReview } };
}

function computeCoverage(t: TemplateTransition, ev: TemplateTransition["transition"]["evidence"]): number {
  if (!ev || ev.oracleAdequacy.sufficient) return 1.0;
  const codeFiles = (t.transition.stateDeps?.write_set ?? [])
    .filter((w) => w.kind === "file" && isCodeFile(w.ref))
    .map((w) => w.ref);
  if (codeFiles.length === 0) return 1.0; // non-code output → no double-penalty
  const untestedCode = codeFiles.filter((f) => ev.untestedRegions.some((r) => r.startsWith(f))).length;
  return Math.max(COVERAGE_FLOOR, 1 - untestedCode / codeFiles.length);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- composed-score.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/composed-score.ts apps/daemon/src/metrics/composed-score.test.ts
git commit -m "feat(daemon): composedScore — compounding × coverage on designed per-source priors"
```

---

## Task 3: Wire into `scoreOver` + inspectable breakdown

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (optional `scoreBreakdown`)
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`contribution` → composed; build `scoreBreakdown`)
- Test: `apps/daemon/src/metrics/aggregate.test.ts` (or the scoring test file)

**Interfaces:**
- Consumes: `composedScore` (Task 2).
- Produces: `StepMetrics.quality.scoreBreakdown` (optional): `{ meanBase, meanCoverage, coverageLimited, verifierMix }`.

- [ ] **Step 1: Add the optional contract field**

In `packages/contracts/src/metrics/index.ts`, inside `StepMetrics.quality` (the `.strict()` object at ~line 98-110), add before its closing brace:
```ts
    scoreBreakdown: z.object({
      meanBase: z.number().nullable(),
      meanCoverage: z.number().nullable(),
      coverageLimited: z.number().int().nonnegative(),
      verifierMix: z.object({
        executable: z.number().int().nonnegative(),
        grounding: z.number().int().nonnegative(),
        independentReview: z.number().int().nonnegative(),
        selfReportOnly: z.number().int().nonnegative(),
      }).strict(),
    }).strict().optional(),
```
> Optional — existing fixtures that omit it stay valid; no required-field ripple.

- [ ] **Step 2: Write the failing test**

Add to `apps/daemon/src/metrics/aggregate.test.ts` (adapt to the file's existing `computeStepMetrics` fixture builders):
```ts
it("scores identical-evidence completions identically (composed, not tier-quantized)", () => {
  // Two completions, each: grounding FAIL → evidence.verdict 'failed' → composed 0.
  // (Same evidence must yield the same score — the Research/Proposal incoherence fix.)
  const mk = (runId: string) => txStepComplete(runId, { evidence: { sensorsRun: [], verdict: "failed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, grounding: { verdict: "failed" } }, refute: { verdict: "upheld" } });
  const steps = computeStepMetrics(inputWith([mk("r1"), mk("r2")]));
  expect(steps[0].score).toBe(0); // both failed grounding → 0, no 66-vs-100 split
});

it("emits an inspectable scoreBreakdown", () => {
  const evidence = { sensorsRun: [{ kind: "unit" }], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } };
  const steps = computeStepMetrics(inputWith([txStepComplete("r1", { evidence })]));
  expect(steps[0].quality.scoreBreakdown?.meanBase).toBe(1);
  expect(steps[0].quality.scoreBreakdown?.verifierMix.executable).toBe(1);
});
```
> Use the test file's real fixture helpers (`txStepComplete`/`inputWith` are illustrative names) — match the existing `computeStepMetrics` test setup; the assertions are the contract.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- aggregate.test.ts`
Expected: FAIL — `scoreBreakdown` undefined / old tier score.

- [ ] **Step 4: Wire composedScore + breakdown into `computeStepMetrics`**

In `apps/daemon/src/metrics/aggregate.ts`:
- Import: `import { composedScore, type CompletionScore } from "./composed-score.js";`
- Compute once per completion (near the existing `tierByCompletion` map, ~line 314):
```ts
  const scoreByCompletion = new Map(finalStepCompletes.map((t) => [t, composedScore(t)] as const));
```
- Replace `contribution` (`:320-321`):
```ts
  const contribution = (t: (typeof stepCompletes)[number]) => scoreByCompletion.get(t)!.score;
```
  (Leave `vFail`, the `conclusive`/`unverified` gate, `supersededByHardFail`, and `scoreOver` itself unchanged — only the per-completion value source changed. `effectiveTierConfidence` import may now be unused in the scoring path; keep it if `computeCalibration`/summary still reference it, else drop the unused import.)
- Build the breakdown from the conclusive completions (the `conclusive` array already computed at ~:315). Near where the `StepMetrics` object is assembled (~:468-501), add:
```ts
    const concScores = conclusive.map((t) => scoreByCompletion.get(t)!);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const scoreBreakdown = {
      meanBase: mean(concScores.map((s) => s.base)),
      meanCoverage: mean(concScores.map((s) => s.coverage)),
      coverageLimited: concScores.filter((s) => s.coverage < 1).length,
      verifierMix: {
        executable: concScores.filter((s) => s.verifiers.executable).length,
        grounding: concScores.filter((s) => s.verifiers.grounding).length,
        independentReview: concScores.filter((s) => s.verifiers.independentReview).length,
        selfReportOnly: concScores.filter((s) => !s.verifiers.executable && !s.verifiers.grounding && !s.verifiers.independentReview).length,
      },
    };
```
  and add `scoreBreakdown` to the `quality: { ... }` block of the emitted `StepMetrics`.

- [ ] **Step 5: Run + regression sweep**

Run: `pnpm --filter @orca/daemon test -- aggregate.test.ts` then `pnpm --filter @orca/daemon test -- metrics` then `pnpm --filter @orca/daemon typecheck`.
Expected: PASS. Existing scoring tests whose numbers legitimately change under the composed score (partial→graded; a grounding-only step 100→70; calibration no longer bumping partially_verified) must be updated to the correct new value — recompute by hand from the composed formula and note each in the report; never weaken an assertion to pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics/index.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.test.ts
git commit -m "feat(metrics): composed verification score replaces tier weight; inspectable breakdown"
```

---

## Task 4: Desktop breakdown line + verification

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (expanded step detail)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx`

**Interfaces:**
- Consumes: `StepMetrics.quality.scoreBreakdown` (optional).

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/metrics/StepPerformance.test.tsx` (build a step fixture whose `quality.scoreBreakdown` is set):
```ts
it("renders a plain-language 'how this score was reached' line from scoreBreakdown", () => {
  render(<StepRow step={stepWithBreakdown} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/how this score was reached/i)).toBeInTheDocument();
  // no jargon
  expect(document.body.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- StepPerformance.test.tsx`
Expected: FAIL — line absent.

- [ ] **Step 3: Render the breakdown (optional-safe)**

In `StepPerformance.tsx`'s expanded body (near the "Checks run"/scope sections), add — rendering only when present, jargon-free:
```tsx
{step.quality.scoreBreakdown && (
  <>
    <SectionLabel>How this score was reached</SectionLabel>
    <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
      {step.quality.scoreBreakdown.meanCoverage != null && step.quality.scoreBreakdown.coverageLimited > 0
        ? `${step.quality.scoreBreakdown.coverageLimited} completion(s) capped by what wasn't covered · `
        : ""}
      {(() => { const m = step.quality.scoreBreakdown!.verifierMix;
        const parts = [m.executable && "ran & tested", m.grounding && "claims checked", m.independentReview && "second-model review"].filter(Boolean);
        return parts.length ? `verified by: ${parts.join(", ")}` : "self-reported only"; })()}
    </div>
  </>
)}
```

- [ ] **Step 4: Run + no-jargon**

Run: `pnpm --filter @orca/desktop test -- StepPerformance.test.tsx no-jargon.test.tsx` then `pnpm --filter @orca/desktop typecheck`.
Expected: PASS.

- [ ] **Step 5: Full workspace verify**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`.
Expected: all green (update any remaining fixture whose composed score legitimately changed — never weaken).

- [ ] **Step 6: Live drive (per `/verify`, needs daemon restart — ask the user first)**

On `orca/adaptive-delivery` in the browser: confirm **Research and Proposal now show the same score**; a grounding-only/reasoning step scores below a full-sensor step (Triage ~86, Execution 100); the step-detail shows the "How this score was reached" line; no adequately-verified step dropped misleadingly. Optional DB check: recompute one completion's composed score by hand from `evidence_json` + `state_deps_json` and confirm it matches the rendered step score's contribution.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx
git commit -m "feat(desktop): 'how this score was reached' breakdown line in step detail"
```

---

## Self-Review notes
- **Spec coverage:** shared code-file helper (§3.1 → Task 1); composedScore incl. sufficiency-gated executable, fail edges, floor, coverage/no-double-penalty (§3.1 → Task 2); scoreOver wiring preserving conclusive/hard-fail discipline + optional inspectable breakdown (§3.2/§3.3 → Task 3); numeric-shift test updates (§3.4 → Task 3 Step 5); desktop breakdown line + live convergence check (§4 → Task 4).
- **Deviation from spec:** none material — `vFail` is left unchanged (the precise minimal change is replacing `contribution` only; `composedScore` handles partial→graded internally), which the spec's "adjust vFail" wording over-stated. Noted in Task 3.
- **Type consistency:** `composedScore`'s `CompletionScore` fields match the Task 3 breakdown aggregation and the contract's `scoreBreakdown`/`verifierMix` shape; `isCodeFile` signature identical pre/post factor-out.
