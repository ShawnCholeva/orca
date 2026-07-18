# Gate-Groundedness Re-weight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gate's binary `isGrounded` (executable-only) groundedness signal with the graded composed-evidence model already used by the step score, so a gate that reviewed strongly grounding-verified work is no longer mislabelled ungrounded/blind.

**Architecture:** Per-decision groundedness becomes `composedScore(reviewedTransition, calibration).base` (a `[0,1]` verification-strength value, coverage excluded). The gate `groundedness` term becomes the **mean** of those values; `ungroundedDecisionIds` and the `blind_approve` failure mode use an honest "no independent verifier" cut (`base ≤ 0.3`). Calibration is threaded from the metrics use-case into `buildGateMetrics` so the gate and its reviewed step see identical strengths. The gate-health formula and weights are unchanged — only the groundedness *input*. Two user-facing copy lines are updated to match the graded meaning.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`apps/daemon`, `apps/desktop`, `packages/contracts`).

## Global Constraints

- No contract **type/schema** change: `groundedness` (`z.number().nullable()`) and `ungroundedDecisionIds` (`z.array(z.string())`) already exist. Only the `blind_approve` **label string** changes.
- Do not change `composedScore`, calibration, the step score, or the gate-health formula/weights (`W_OVERTURN 0.5 / W_GROUNDED 0.3 / W_CONVERGE 0.2`).
- Do not change the gate→step **join** (which completion a gate reviewed).
- Basis is `composedScore(...).base` (verification strength) — **not** `.score` (excludes coverage, by design; see spec §3.1).
- Recompute-from-persisted: no migration.
- Paper anchors: §5.2.2 p.62 (calibrated evidence not binary), §5.2.1 (verification strength as a rate), p.65 (not relying on self-report).

---

### Task 1: Daemon — graded gate groundedness + calibration threading

**Files:**
- Modify: `apps/daemon/src/metrics/gate-metrics.ts` (imports; `buildGateMetrics` signature ~`:20-25`; groundedness block `:51-60`; `blind_approve` `:106`)
- Modify: `apps/daemon/src/metrics/usecases.ts` (imports; call site `:82`)
- Test: `apps/daemon/src/metrics/gate-metrics.test.ts`

**Interfaces:**
- Consumes: `composedScore(t: TemplateTransition, calibration?: CalibrationEntry[]): CompletionScore` (from `./composed-score.js`; `.base ∈ [0,1]`, refuted/failed → 0); `SOURCE_CONFIDENCE.self_report` (= 0.3, from `./source-signals.js`); `computeCalibration(transitions): CalibrationEntry[]` and the `CalibrationEntry` type (from `./verification.js`); `mean` (already defined `gate-metrics.ts:13`, returns `null` on empty).
- Produces: `buildGateMetrics` now accepts an optional `calibration?: CalibrationEntry[]` in its input object; when omitted, `composedScore` falls back to designed priors (base 1.0 executable / 0.7 grounding / 0.3 self-report).

- [ ] **Step 1: Write the failing tests**

Add these fixtures + tests to `apps/daemon/src/metrics/gate-metrics.test.ts`. Put the fixtures near the top (after the existing `decision` helper), and the tests inside the `describe("buildGateMetrics", …)` block.

```ts
// --- fixtures for graded groundedness (mirror composed-score.test.ts shapes) ---
const evf = (o: Record<string, unknown>) => ({
  sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
  oracleAdequacy: { sufficient: false, gaps: [] }, ...o,
});
const groundingPassed = { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] };
const stepTx = (over: { workflowRunId?: string; createdAt?: string; evidence?: unknown; refute?: unknown }): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s",
  transition: {
    workflowRunId: over.workflowRunId ?? "r", boundary: "step_complete",
    createdAt: over.createdAt ?? "2026-07-15T00:00:00.000Z",
    evidence: over.evidence, refute: over.refute,
  } as never,
});
```

```ts
it("groundedness is the graded MEAN of reviewed-step evidence strength (not a binary fraction)", () => {
  const mk = (run: string, evidence: unknown) => ({
    d: decision({ id: `dec-${run}`, workflowRunId: run, recommendedOutcome: null }),
    t: stepTx({ workflowRunId: run, evidence }),
  });
  const exe = mk("r1", evf({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } })); // base 1.0
  const grd = mk("r2", evf({ grounding: groundingPassed }));                                                     // base 0.7
  const slf = mk("r3", evf({}));                                                                                 // base 0.3
  const gates = buildGateMetrics({
    decisions: [exe.d, grd.d, slf.d], transitions: [exe.t, grd.t, slf.t], names, period: "7d",
  });
  expect(gates[0].scored.groundedness).toBeCloseTo((1.0 + 0.7 + 0.3) / 3, 5); // 0.6667 — graded, not 1/3
});

it("a strongly grounding-verified reviewed step is GROUNDED — not ungrounded, not blind (honesty fix)", () => {
  const d = decision({ workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
  const t = stepTx({ workflowRunId: "r1", evidence: evf({ grounding: groundingPassed }) }); // base 0.7 > 0.3
  const gates = buildGateMetrics({ decisions: [d], transitions: [t], names, period: "7d" });
  expect(gates[0].scored.groundedness).toBeCloseTo(0.7, 5);
  expect(gates[0].scored.ungroundedDecisionIds).toEqual([]);
  expect(gates[0].failureModes.find((f) => f.label.match(/self-report|independent/i))).toBeUndefined();
});

it("self-report-only and refuted reviewed steps are ungrounded; an approved self-report is blind", () => {
  const dSelf = decision({ id: "dSelf", workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
  const tSelf = stepTx({ workflowRunId: "r1", evidence: evf({}) });                                            // base 0.3 (== floor)
  const dRef = decision({ id: "dRef", workflowRunId: "r2", outcome: "rejected", recommendedOutcome: null });
  const tRef = stepTx({ workflowRunId: "r2", refute: { verdict: "refuted" }, evidence: evf({ grounding: groundingPassed }) }); // refuted → base 0
  const gates = buildGateMetrics({ decisions: [dSelf, dRef], transitions: [tSelf, tRef], names, period: "7d" });
  expect([...gates[0].scored.ungroundedDecisionIds].sort()).toEqual(["dRef", "dSelf"]);
  const blind = gates[0].failureModes.find((f) => f.label.match(/self-report|independent/i));
  expect(blind?.count).toBe(1);                 // only the approved one; dRef was rejected
  expect(blind?.sampleDecisionIds).toEqual(["dSelf"]);
});

it("a decision with no reviewed step-complete contributes 0 to groundedness", () => {
  const d = decision({ workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
  const gates = buildGateMetrics({ decisions: [d], transitions: [], names, period: "7d" });
  expect(gates[0].scored.groundedness).toBe(0);
  expect(gates[0].scored.ungroundedDecisionIds).toEqual(["d"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- gate-metrics`
Expected: the four new tests FAIL — the current binary `isGrounded` makes `groundedness` a 0/1 fraction (e.g. the mean test gets `1/3 ≈ 0.333` because only the executable step is "grounded"), and the grounding-only step is wrongly in `ungroundedDecisionIds`.

- [ ] **Step 3: Add imports to `gate-metrics.ts`**

At the top of `apps/daemon/src/metrics/gate-metrics.ts`, after the existing `import type { GateDecisionRow, TemplateTransition } from "./fetch.js";` (line 3), add:

```ts
import { composedScore } from "./composed-score.js";
import { SOURCE_CONFIDENCE } from "./source-signals.js";
import type { CalibrationEntry } from "./verification.js";
```

- [ ] **Step 4: Add `calibration` to the `buildGateMetrics` signature**

In the input object type (`gate-metrics.ts:20-25`), add the optional field:

```ts
export function buildGateMetrics(input: {
  decisions: GateDecisionRow[];
  transitions: TemplateTransition[];
  names: Map<string, { name: string; evalSubstrate: "shadow" | "worker" }>;
  period: MetricPeriod;
  calibration?: CalibrationEntry[];
}): GateMetrics[] {
```

Immediately inside the function body (before the loop, alongside the other top-level binds), add:

```ts
  const calibration = input.calibration;
```

- [ ] **Step 5: Replace the binary groundedness block with the graded version**

Replace the whole block at `gate-metrics.ts:51-60` (the `isGrounded` closure, `grounded`, `groundedness`, `ungroundedDecisionIds`) with:

```ts
    // --- Groundedness: how strongly did the reviewed step's evidence stand up? (graded, composed) ---
    const GROUNDED_FLOOR = SOURCE_CONFIDENCE.self_report; // 0.3 — at/below ⇒ no independent verifier passed
    const groundednessOf = (d: GateDecisionRow): number => {
      const completes = stepCompletesByRun.get(d.workflowRunId) ?? [];
      const reviewed = [...completes].reverse().find((t) => t.transition.createdAt < d.createdAt);
      return reviewed ? composedScore(reviewed, calibration).base : 0; // no reviewed step / refuted / failed ⇒ 0
    };
    const isUngrounded = (d: GateDecisionRow): boolean => groundednessOf(d) <= GROUNDED_FLOOR;
    const groundedness = mean(decisions.map(groundednessOf)); // number | null (null only on empty — unreachable per node)
    const ungroundedDecisionIds = decisions.filter(isUngrounded).slice(0, GATE_SAMPLE_CAP).map((d) => d.id);
```

- [ ] **Step 6: Update the `blind_approve` failure mode**

At `gate-metrics.ts:106`, change the predicate from the binary to `isUngrounded`:

```ts
    pushMode("blind_approve", decisions.filter((d) => d.outcome === "approved" && isUngrounded(d)));
```

- [ ] **Step 7: Thread calibration through the use-case call site**

In `apps/daemon/src/metrics/usecases.ts`, confirm `computeCalibration` is imported from `./verification.js`; if not present, add it to that import (it is already used in `aggregate.ts`). Then at `usecases.ts:82`, compute calibration from the same transitions and pass it in:

```ts
  const calibration = computeCalibration(transitions);
  const gates = buildGateMetrics({ decisions: gateDecisions, transitions, names: gateNodeNames(db, templateId), period, calibration });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- gate-metrics`
Expected: the four new tests PASS; all pre-existing `gate-metrics` tests still PASS (they pass `transitions: []` / `costTransitions()` and no `calibration`, so `composedScore` uses designed priors and those gates simply have `groundedness` driven by whatever transitions they include — unchanged for the overturn/park/cost tests, which don't assert groundedness).

- [ ] **Step 9: Full daemon suite + typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: all green (2900+ tests). If `usecases.gate.test.ts` asserts a specific groundedness value under the old binary, update it to the graded expectation (compute the mean of the reviewed steps' `base` values it sets up) — this is a faithful adaptation, not a weakening.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/metrics/gate-metrics.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/gate-metrics.test.ts
git commit -m "feat(metrics): graded gate groundedness via composed evidence (base), retire binary isGrounded"
```

---

### Task 2: Copy — align gate labels with the graded meaning

**Files:**
- Modify: `packages/contracts/src/metrics/gate-failure-labels.ts:8` (`blind_approve` label)
- Modify: `apps/desktop/src/metrics/GatePerformance.tsx:56` (groundedness line)
- Test: `packages/contracts/src/metrics/gate-failure-labels.test.ts` (existing generic assertion), `apps/desktop/src/metrics/no-jargon.test.tsx` (existing scan)

**Interfaces:**
- Consumes: nothing new. Both are string-literal edits.
- Produces: user-facing copy that reflects graded groundedness ("no independent verification" / "average strength of the evidence").

- [ ] **Step 1: Update the `blind_approve` contract label**

In `packages/contracts/src/metrics/gate-failure-labels.ts`, change line 8 from:

```ts
  blind_approve: "Approved without any checks run behind it",
```
to:
```ts
  blind_approve: "Approved on self-report alone — no independent verification",
```

- [ ] **Step 2: Update the desktop groundedness copy**

In `apps/desktop/src/metrics/GatePerformance.tsx`, change line 56 from:

```tsx
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>{pct(gate.scored.groundedness)} of calls stood on checks that actually ran.</div>
```
to:
```tsx
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>{pct(gate.scored.groundedness)} average strength of the evidence behind gate calls.</div>
```

- [ ] **Step 3: Run contract + desktop suites**

Run: `pnpm --filter @orca/contracts test -- gate-failure-labels && pnpm --filter @orca/desktop test -- GatePerformance no-jargon`
Expected: PASS. `gate-failure-labels.test.ts` only asserts each label is non-empty (plus a regex on `overturned_approve`, unaffected); `no-jargon` passes because "strength"/"evidence" are plain words. If `no-jargon` renders `GatePerformance` and flags a term, pick a plainer synonym that keeps the graded meaning.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/metrics/gate-failure-labels.ts apps/desktop/src/metrics/GatePerformance.tsx
git commit -m "docs(metrics): align gate blind-approve + groundedness copy with graded evidence"
```

---

### Task 3: Verify — full workspace, whole-branch review, live check

**Files:** none (verification only).

- [ ] **Step 1: Full-workspace deterministic verify**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
Expected: all four green.

- [ ] **Step 2: Whole-branch review**

Dispatch a fresh reviewer over the phase diff (base = the commit before Task 1 .. HEAD). Verify: groundedness uses `composedScore(...).base` (not `.score`); `GROUNDED_FLOOR` uses `SOURCE_CONFIDENCE.self_report`; the gate-health formula/weights are untouched; calibration is threaded from `usecases.ts` (same transitions); no contract **type** change; the two copy lines match the graded meaning; the join is unchanged. Confirm no scoring/formula regression.

- [ ] **Step 3: Live check (needs daemon restart — ask the user first)**

On the **Adaptive Delivery** workflow (Metrics → Gates, Critique + Verify): confirm each gate's `groundedness` percentage **rises** vs the binary (grounding-only reviews now contribute ~0.7 instead of 0), and `blind_approve` no longer fires on strongly-grounded approvals. This is the gate-side mirror of the 2c-i band honesty fix. Capture a screenshot.

- [ ] **Step 4: Mark the phase complete in the ledger and update the phase memory (`phase2-scoring-evolution.md`).**

---

## Self-Review

**Spec coverage:** graded groundedness (Task 1 Steps 3-5), `blind_approve` redefinition (Step 6), calibration threading (Steps 4,7), `base`-not-`score` basis (Step 5 + Global Constraints), copy alignment (Task 2), no contract type change (Global Constraints), live check (Task 3 Step 3). All spec §3 items map to a task.

**Placeholder scan:** none — every code step shows complete code; test bodies are concrete with exact expected values.

**Type consistency:** `groundednessOf → number`, `isUngrounded → boolean`, `groundedness = mean(...) → number | null` matches the contract `z.number().nullable()`. `calibration?: CalibrationEntry[]` matches `composedScore`'s optional second arg and `computeCalibration`'s return. Fixture `evf`/`groundingPassed`/`stepTx` mirror the verified shapes in `composed-score.test.ts`.
