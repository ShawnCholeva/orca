# Epistemic Bands (Phase 2c-i) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the 5-tier display pill into a per-step epistemic band (strong / weak / needs-more-evidence) derived from the composed evidence model, so a high-scoring but only-reviewed step honestly reads "Weakly verified."

**Architecture:** A daemon-computed `verification.band` on `StepMetrics`, derived from the scored completions' `verifiers` (the same `concScores` set `scoreBreakdown` uses) — orthogonal to the score grade. The desktop step pill + strength meter render the band instead of `tierLabel`; `classifyTier`/`tier`/`tierLabel` stay as internal fields.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Vitest, pnpm workspace. Daemon (derivation + contract) + desktop (render).

**Spec:** `docs/superpowers/specs/2026-07-18-epistemic-bands-design.md`

## Global Constraints

- **Band derives from verification KIND, not score magnitude.** `needs_evidence` = `score == null`; `strong` = execution verified the MAJORITY (`> scoredCount/2`, strict) of scored completions; `weak` = scored but execution minority/absent. A high-scoring grounding-only step MUST band `weak`.
- **`scoredCount`** = the `concScores` set (conclusive completions with `base !== 0`) — the same set `scoreBreakdown` is built over (`aggregate.ts:488`).
- **`verification.band` is REQUIRED** on the contract; the daemon always emits it. Fixtures that hand-build a `verification` object must add it (daemon + desktop) — the ripple is handled in the tasks below.
- **Retire the tier from the UI, keep it internal:** the desktop pill + meter stop rendering `tierLabel`/`tier`; `classifyTier`/`strongestTier`/`verification.tier`/`tierLabel` remain (conclusiveness gate, `reconciliation.verifiedTierLabel`, back-compat).
- **No scoring/calibration change** — band is a label over existing signals.
- **Jargon-free** band labels: "Strongly verified" / "Weakly verified" / "Needs more evidence".
- **No migration** (recompute-from-persisted).

---

## File Structure

**Modify:**
- `packages/contracts/src/metrics/index.ts:193-197` — add `band` to `StepMetrics.verification`.
- `apps/daemon/src/metrics/aggregate.ts` — derive `band` (near `concScores`, ~:488) and emit it in the `verification` block (~:517).
- `apps/daemon/src/metrics/aggregate.steps.test.ts` (+ any daemon `StepMetrics`-literal fixture, e.g. `deriveInsights` tests) — add `band` / assert derivation.
- `apps/desktop/src/metrics/metrics-data.ts` — add `bandMeta`.
- `apps/desktop/src/metrics/StepPerformance.tsx:76,100-110` — pill + meter render the band.
- `apps/desktop/src/metrics/StepPerformance.test.tsx`, `no-jargon.test.tsx`, `metrics-data.test.ts` (+ any fixture building `verification`) — add `band`.

---

## Task 1: Daemon — derive + emit `verification.band`

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts:193-197`
- Modify: `apps/daemon/src/metrics/aggregate.ts` (~:488 derive, ~:517 emit)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Produces: `StepMetrics.verification.band: { level: "strong"|"weak"|"needs_evidence"; label: string }`.

- [ ] **Step 1: Add the contract field**

In `packages/contracts/src/metrics/index.ts`, inside the `verification: z.object({ ... })` block (lines 193-197), add before its closing `}).strict()`:
```ts
    band: z.object({ level: z.enum(["strong", "weak", "needs_evidence"]), label: z.string() }).strict(),
```

- [ ] **Step 2: Write the failing test**

In `apps/daemon/src/metrics/aggregate.steps.test.ts`, add (adapt fixture builders to the file's existing `computeStepMetrics` setup — the assertions are the contract):
```ts
it("bands a majority-executed step 'strong'", () => {
  const steps = computeStepMetrics(inputWith([
    txStepComplete("r1", { evidence: sensorsOk() }),   // executable
    txStepComplete("r2", { evidence: sensorsOk() }),   // executable (2/3 majority)
    txStepComplete("r3", { evidence: groundingOk() }),
  ]));
  expect(steps[0].verification.band).toEqual({ level: "strong", label: "Strongly verified" });
});

it("bands a HIGH-scoring grounding-only step 'weak' (kind ≠ magnitude)", () => {
  // grounding-only completions → score can be high, but no execution → weak.
  const steps = computeStepMetrics(inputWith([
    txStepComplete("r1", { evidence: groundingOk() }),
    txStepComplete("r2", { evidence: groundingOk() }),
  ]));
  expect(steps[0].verification.band.level).toBe("weak");
  expect(steps[0].verification.band.label).toBe("Weakly verified");
});

it("bands a step with no conclusive verification 'needs_evidence'", () => {
  const steps = computeStepMetrics(inputWith([txStepComplete("r1", { /* self-report only, score null */ })]));
  expect(steps[0].verification.band.level).toBe("needs_evidence");
});
```
> `sensorsOk()`/`groundingOk()` mirror the file's existing evidence-fixture helpers (sensors ran + sufficient; grounding enforce-passed). If none exist, inline `{ sensorsRun:[{kind:"unit"}], verdict:"passed", untestedRegions:[], residualRisk:[], oracleAdequacy:{sufficient:true,gaps:[]} }` and `{ ..., sensorsRun:[], oracleAdequacy:{sufficient:false,gaps:[]}, grounding:{verdict:"passed",checks:[{mode:"enforce",result:"passed"}]} }`.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon test -- aggregate.steps.test.ts`
Expected: FAIL — `verification.band` undefined.

- [ ] **Step 4: Derive the band**

In `apps/daemon/src/metrics/aggregate.ts`, right after `const concScores = ...` (line 488), add:
```ts
    const scoredCount = concScores.length;
    const executableCount = concScores.filter((s) => s.verifiers.executable).length;
    // Epistemic band = verification KIND (strong/weak/needs-evidence), ORTHOGONAL to the
    // score magnitude: a high-scoring grounding-only step is honestly "Weakly verified".
    const bandLevel: "strong" | "weak" | "needs_evidence" =
      scoreValue == null ? "needs_evidence"
      : executableCount > scoredCount / 2 ? "strong"
      : "weak";
    const BAND_LABEL = { strong: "Strongly verified", weak: "Weakly verified", needs_evidence: "Needs more evidence" } as const;
```

- [ ] **Step 5: Emit it in the verification block**

In the `verification: { ... }` object (~line 517-519), add:
```ts
        band: { level: bandLevel, label: BAND_LABEL[bandLevel] },
```

- [ ] **Step 6: Fix any daemon StepMetrics-literal fixtures**

Run `pnpm --filter @orca/daemon typecheck`. Any test that hand-builds a `StepMetrics` `verification` object literal (e.g. `deriveInsights` tests) now needs `band`. Add `band: { level: "weak", label: "Weakly verified" }` (or the level the test intends) to each. `computeStepMetrics`-based tests get it automatically — no change needed.

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- aggregate.steps.test.ts` then `pnpm --filter @orca/daemon test -- metrics` then `pnpm --filter @orca/daemon typecheck`.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/metrics/index.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "feat(metrics): epistemic band on StepMetrics.verification (strong/weak/needs-evidence)"
```

---

## Task 2: Desktop — render the band, retire the pill + meter

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-data.ts` (add `bandMeta`)
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx:76` (pill), `:100-110` (meter)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx`, `no-jargon.test.tsx`, `metrics-data.test.ts`

**Interfaces:**
- Consumes: `StepMetrics.verification.band` (Task 1).

- [ ] **Step 1: Add `bandMeta`**

In `apps/desktop/src/metrics/metrics-data.ts`, add:
```ts
export const bandMeta: Record<"strong" | "weak" | "needs_evidence", { tone: "run" | "warn" | "accent"; color: string }> = {
  strong: { tone: "run", color: "var(--run)" },
  weak: { tone: "warn", color: "var(--warn)" },
  needs_evidence: { tone: "accent", color: "var(--accent)" },
};
```

- [ ] **Step 2: Write the failing test**

In `apps/desktop/src/metrics/StepPerformance.test.tsx`, add (fixtures include `verification.band`):
```ts
it("renders the epistemic band pill, not the tier label", () => {
  const step = stepFixture({ verification: { ...baseVerification, tierLabel: "Run & tested", band: { level: "weak", label: "Weakly verified" } } });
  render(<StepRow step={step} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText("Weakly verified")).toBeInTheDocument();
  expect(screen.queryByText("Run & tested")).toBeNull();   // tier pill retired
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- StepPerformance.test.tsx`
Expected: FAIL — still renders `tierLabel`.

- [ ] **Step 4: Render the band in the pill**

In `apps/desktop/src/metrics/StepPerformance.tsx`, import `bandMeta` from `./metrics-data`, and replace the pill (line 76):
```tsx
            <Pill tone={bandMeta[step.verification.band.level].tone} size="xs">{step.verification.band.label}</Pill>
```
(Remove the `status === "unverified" ? "No check yet" : step.verification.tierLabel` expression.)

- [ ] **Step 5: Replace the 5-segment tier meter with a 3-segment band indicator**

Replace the IIFE at lines 100-110 (the `rank = [...tiers...].indexOf(...)` 5-segment bar) with:
```tsx
            {(() => {
              const rank = { needs_evidence: 1, weak: 2, strong: 3 }[step.verification.band.level];
              const color = bandMeta[step.verification.band.level].color;
              return (
                <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
                  {[0, 1, 2].map((i) => <div key={i} style={{ height: 6, flex: 1, borderRadius: 3, background: i < rank ? color : "rgba(255,255,255,0.08)" }} />)}
                </div>
              );
            })()}
```

- [ ] **Step 6: Fix desktop fixtures + no-jargon**

Add `band: { level: <intended>, label: <matching label> }` to every `verification: {...}` object literal in `StepPerformance.test.tsx`, `no-jargon.test.tsx`, `metrics-data.test.ts` (and any other desktop fixture building `verification`). Confirm `no-jargon` passes (band labels are jargon-free).

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- StepPerformance.test.tsx no-jargon.test.tsx metrics-data.test.ts` then `pnpm --filter @orca/desktop typecheck`.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/metrics/metrics-data.ts apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx apps/desktop/src/metrics/no-jargon.test.tsx apps/desktop/src/metrics/metrics-data.test.ts
git commit -m "feat(desktop): render epistemic band pill + strength meter, retire tier pill"
```

---

## Task 3: Verification (full workspace + live)

**Files:** none (verification only).

- [ ] **Step 1: Full workspace green**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`.
Expected: all green (any remaining `verification`-literal fixture that legitimately needs `band` — add it; never weaken).

- [ ] **Step 2: Live drive (per `/verify`, needs daemon restart — ask the user first)**

On `orca/adaptive-delivery`: confirm the grounding-verified steps (Triage/Proposal — high scores post-2b-ii) now show **"Weakly verified"** while Execution (sensors) shows **"Strongly verified"** and any never-checked step shows **"Needs more evidence"** — the band separating verification KIND from the score grade. Confirm the 3-segment strength meter matches, no jargon, the tier label no longer appears.

- [ ] **Step 3: Final commit (if verification fixups were needed)**

```bash
git add -A && git commit -m "test(metrics): verification-band fixture updates (Phase 2c-i)"
```

---

## Self-Review notes
- **Spec coverage:** band field + derivation majority-executed/high-grounding-weak/null-needs-evidence (§3.1 → Task 1); contract additive-required (§3.2 → Task 1 Step 1); desktop pill + meter retire tier (§3.3 → Task 2); jargon-free (§3.3 → Task 2 Step 6); live kind-vs-magnitude check (§4 → Task 3).
- **Type consistency:** `band.level` enum + labels identical across contract (Task 1 Step 1), daemon `BAND_LABEL` (Task 1 Step 4), and desktop `bandMeta`/`{needs_evidence:1,weak:2,strong:3}` (Task 2). `scoredCount`/`executableCount` derive from the `concScores`/`s.verifiers.executable` shape 2b-i established.
- **Required-field ripple:** handled explicitly in Task 1 Step 6 (daemon literals) + Task 2 Step 6 (desktop literals); `computeStepMetrics`-based tests get `band` free.
