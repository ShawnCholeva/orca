# Node Confidence Model — Phase 2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the downstream-vindication signal (Phase 2a) **load-bearing on the score** via unified per-source empirical-Bayes (Beta) calibration, with **prior-weighted one-hop attenuation** — so `independent_review` finally calibrates (non-circular), and scores reflect measured survival rather than only designed priors.

**Architecture:** Extend the existing calibration path (`verification.ts` `computeCalibration`/`effectiveSourceConfidence`, already load-bearing for executable/grounding). Each source gets a `Beta(α,β)` posterior seeded by its designed prior as low-weight pseudo-counts, updated by **refute** labels (executable/grounding only — CRUX: never calibrate a source against the refute signal it *is*) **and weighted vindication** labels (all calibratable sources, including `independent_review` — the vindication oracle is independent of refute). Each vindication label is weighted by its vindicator's *designed-prior strength* (`vindicatorWeight(byNodeId, graph)`) — no computed scores, so no circularity and no Phase-3 dependency; weighting by *computed* downstream confidence is the deferred fuller version. Recompute-on-read, **no migration**.

**Tech Stack:** TypeScript, Zod contracts, Vitest. Daemon `@orca/daemon`.

## Global Constraints

- **Recompute-on-read; NO migration.**
- **CRUX (locked):** `independent_review` is the refute signal — it must **only** be calibrated by the **vindication** oracle, never by refute labels. `self_report` is never calibrated (it is the unknown/floor state, not a scored value).
- **This phase MOVES scores.** That is expected and intended (crossing the SP3 "display-only" boundary = FUTURE_WORK 5.2 "coefficient governance"). But score movement must be *only* where vindication/refute evidence justifies it: a completion with no vindication data and no refute must score exactly as before.
- **Empirical-Bayes shrinkage:** the designed prior (`SOURCE_CONFIDENCE`) enters as pseudo-counts; the posterior mean replaces the prior in `effectiveSourceConfidence` only once effective observed sample size ≥ `CALIBRATION_SCORE_MIN` (10). `executable` still caps *down* only (`Math.min`).
- **Attenuation weights are designed priors** (a table by downstream node type) — computed-confidence attenuation is deferred to gate/splitter scoring (Phase 3).
- **Version-safety** unchanged (2a already latest-version-filters the vindication feed).
- Deterministic; no LLM calls. Test runner from `apps/daemon`: `npx vitest run <path>`; run FULL `npx vitest run src/metrics` + `npx tsc --noEmit` before every commit.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure
- `apps/daemon/src/metrics/vindicator-weight.ts` — CREATE: pure `vindicatorWeight(byNodeId, graph)`.
- `apps/daemon/src/metrics/vindicator-weight.test.ts` — CREATE.
- `apps/daemon/src/metrics/verification.ts` — MODIFY: Beta-reformulate `computeCalibration` (accept vindication + graph + gateApproved); add `independent_review` to the calibratable set (vindication-only); `effectiveSourceConfidence` posterior-mean semantics.
- `apps/daemon/src/metrics/verification.test.ts` (or the existing calibration test) — MODIFY.
- `apps/daemon/src/metrics/composed-score.ts` — MODIFY: use `effectiveSourceConfidence("independent_review", calibration)` instead of the raw `SOURCE_CONFIDENCE.independent_review`.
- `apps/daemon/src/metrics/usecases.ts` — MODIFY: pass vindication + graph + gateApproved into `computeCalibration`; split version-excluded out of the `pending` vindication bucket.
- `apps/daemon/src/metrics/aggregate.ts` — MODIFY (minor): surface per-source calibration sample counts for uncertainty (reuse `scoreBreakdown`/insights; no new heavy contract object).
- Test files as needed.

---

## Task 1: `vindicatorWeight` — prior-weighted attenuation table

**Files:** Create `apps/daemon/src/metrics/vindicator-weight.ts` + `.test.ts`.

**Interfaces:**
```ts
// Designed-prior strength of a vindicator (the downstream node that accepted/bounced a step),
// used to weight its vindication as a soft calibration label. Prior-only (no computed score) —
// computed-confidence weighting is deferred to gate/splitter scoring (Phase 3).
export function vindicatorWeight(byNodeId: string | null, graph: WorkflowGraph): number;
```
Weights: terminal/human (`byNodeId === null`, i.e. `mark_done`) → **1.0** (anchor); worker gate (`evalSubstrate === "worker"`) → **0.55**; shadow gate (gate, not worker) → **0.4**; step → **0.5**; splitter → **0.3**; delegate → **0.55**; unknown node → **0.3** (conservative).

- [ ] **Step 1: failing tests** — assert each node type maps to its weight (build a small graph with a worker gate, a shadow gate, a step, a splitter, a delegate; `byNodeId=null` → 1.0).
- [ ] **Step 2: RED** — `npx vitest run src/metrics/vindicator-weight.test.ts`.
- [ ] **Step 3: implement**
```ts
import type { WorkflowGraph } from "@orca/contracts";
export function vindicatorWeight(byNodeId: string | null, graph: WorkflowGraph): number {
  if (byNodeId === null) return 1.0; // terminal — human mark_done, the anchor
  const n = graph.nodes.find((x) => x.id === byNodeId);
  if (!n) return 0.3;
  switch (n.type) {
    case "gate": return n.evalSubstrate === "worker" ? 0.55 : 0.4;
    case "step": return 0.5;
    case "splitter": return 0.3;
    case "delegate": return 0.55;
    default: return 0.3;
  }
}
```
- [ ] **Step 4: GREEN** + full `npx vitest run src/metrics` + `npx tsc --noEmit`.
- [ ] **Step 5: commit** `feat(metrics): vindicatorWeight — prior-weighted attenuation by downstream type`.

---

## Task 2: Beta-reformulate `computeCalibration` (build the new calibration; do NOT wire to score yet)

**Files:** `apps/daemon/src/metrics/verification.ts` + its test.

**Interfaces:**
```ts
export function computeCalibration(
  transitions: TemplateTransition[],
  opts?: {
    vindication?: Map<string, { outcome: "vindicated" | "bounced" | "pending"; byNodeId: string | null }>;
    graph?: WorkflowGraph;
    gateApprovedByCompletion?: (t: TemplateTransition) => boolean;
  },
): CalibrationEntry[];
```
`CalibrationEntry` stays `{ source, assumed, measured, sampleSize, state }` — but now: `measured` = Beta posterior mean; `sampleSize` = **effective observed count** (weighted labels, excluding the prior pseudo-counts); `state = "measured"` once `sampleSize ≥ CALIBRATION_MIN` (existing 5) — but `effectiveSourceConfidence` only *applies* it at `CALIBRATION_SCORE_MIN` (10), unchanged.

**Semantics per source:**
- `self_report` → unmeasurable (unchanged).
- `executable`, `grounding` → labels from **refute** (upheld=+1, refuted=+1 to β) **and** weighted **vindication** (vindicated=+w, bounced=+w to β), over completions that passed that source (`sourcesPassed`).
- `independent_review` → **NEW: calibratable via vindication ONLY** (CRUX: no refute labels). Bucket = completions that passed independent review (`sourcesPassed(...).independentReview || opts.gateApprovedByCompletion?.(t)`). Labels from weighted vindication only.
- Prior pseudo-counts: `α₀ = prior·K`, `β₀ = (1−prior)·K`, `K = PRIOR_STRENGTH = 4`. Posterior `mean = α/(α+β)`.

Backward-compat: called with no `opts` (or empty vindication), executable/grounding fall back to *refute-only* labels → the posterior mean over refute counts + prior pseudo-counts. **Note this already differs numerically from the old pure `upheld/claims` ratio (shrinkage) — a deliberate change; update the existing calibration tests to the Beta values.**

- [ ] **Step 1: failing tests** — cover: (a) `independent_review` now calibrates from vindication labels (e.g. bucket of gate-approved completions mostly bounced → posterior mean < 0.55); (b) executable/grounding combine refute + weighted vindication; (c) no-vindication + no-refute → posterior mean == prior (`measured` may be null/insufficient at low n); (d) `self_report` unmeasurable. Assert posterior means with `toBeCloseTo`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: implement** the Beta reformulation in `verification.ts`: add `PRIOR_STRENGTH = 4`; add `independent_review` to a new `VINDICATION_CALIBRATABLE = ["executable","grounding","independent_review"]` (executable/grounding also get refute; independent_review vindication-only); a `weightedLabels` accumulator using `vindicatorWeight(v.byNodeId, opts.graph)` (import from Task 1; if `graph` absent, weight defaults to 1.0). Keep `finalCompletions`. Key vindication lookups by `${runId}::${stepTemplateId}`.
- [ ] **Step 4: GREEN** + full `src/metrics`. **Expect existing calibration tests to fail on the shrinkage change — update them to the Beta posterior values (documenting each as the intended empirical-Bayes change).** `npx tsc --noEmit`.
- [ ] **Step 5: commit** `feat(metrics): Beta empirical-Bayes calibration incl. independent_review via vindication`.

> Note: `effectiveSourceConfidence` still restricts to executable/grounding in Task 2, so **scores do not move for independent_review yet** — Task 3 flips that. Executable/grounding scores may shift slightly from the shrinkage; that is the intended crossing.

---

## Task 3: Flip the score onto the new calibration + wire the feed + uncertainty + split pending

**Files:** `verification.ts` (`effectiveSourceConfidence`), `composed-score.ts`, `usecases.ts`, `aggregate.ts`, tests + E2E.

- [ ] **Step 1: failing test** — an `independent_review`-passing (gate-approved) step whose completions were mostly **bounced** downstream (≥10 labels) now scores **below** the raw 0.55 for that source (its `composedScore.base` drops); a mostly-**vindicated** one rises toward 1.0. And a step with no vindication/refute is unchanged.
- [ ] **Step 2: RED.**
- [ ] **Step 3: implement:**
  1. `effectiveSourceConfidence`: extend the calibratable check to include `independent_review` (posterior mean when `state==="measured" && sampleSize ≥ CALIBRATION_SCORE_MIN`, else prior). `executable` keeps the `Math.min` cap.
  2. `composed-score.ts`: replace `cs.push(SOURCE_CONFIDENCE.independent_review)` with `cs.push(effectiveSourceConfidence("independent_review", calibration))`. (The cap-at-one single-push stays.)
  3. `usecases.ts` `getTemplateMetricsDetail`: compute the vindication map + gate-approval predicate **before** calibration, and pass `computeCalibration(transitions, { vindication, graph, gateApprovedByCompletion })`. Also **split version-excluded from pending**: in the `vindicationByCompletion` predicate, a version-mismatched completion should be *excluded from the tally* (return a sentinel the aggregate skips) rather than counted `pending` — add an `excluded` handling so `pending` means only "latest-version, no downstream verdict yet". Update `aggregate.ts`'s tally to skip excluded.
  4. `aggregate.ts`: surface per-source calibration sample counts + measured-vs-assumed for uncertainty in the existing `scoreBreakdown`/insights (a `calibrationMix` sub-object: per source `{ assumed, measured, sampleSize, state }`) — reuse `input.calibration`, no heavy new contract.
- [ ] **Step 4: GREEN** + **full `npx vitest run src/metrics`** — update any score-asserting test whose fixture carries vindication/refute to the new calibrated value; a fixture with neither must be unchanged (prove no unintended movement). `npx vitest run src/workflows` unaffected. `npx tsc --noEmit` (daemon + contracts + desktop).
- [ ] **Step 5: E2E** in a `usecases.*.test.ts`: seed a latest-version step, gate-approved, with ≥10 downstream-bounced completions → its score reflects a calibrated-down `independent_review`; and a version-safety case (older-version labels don't calibrate).
- [ ] **Step 6: commit** `feat(metrics): make vindication calibration load-bearing on the score`.

---

## Final verification
- [ ] Full `npx vitest run src/metrics` + `npx vitest run src/workflows` + `npx tsc --noEmit` (daemon, contracts, desktop) all green.
- [ ] Sanity: a step with no vindication and no refute scores identically to pre-2b (no unintended movement).

## Self-review checklist (done)
- **Spec coverage:** unified per-source Beta (both oracles) = Task 2; prior-weighted attenuation = Task 1 consumed in Task 2; independent_review calibrates (non-circular) = Tasks 2–3; load-bearing on score = Task 3; uncertainty surfacing = Task 3 Step 4; split-pending 2a deferral = Task 3 Step 3. **Out of scope (guardrail):** computed-confidence attenuation, gate/splitter *scoring*, and the drawer vocabulary are Phase 3 / Phase 4 — do not build here.
- **CRUX guard:** `independent_review` uses vindication labels ONLY, never refute — assert this explicitly in a Task 2 test.
- **No unintended score movement:** a no-evidence completion must score identically — an explicit Task 3 test.
- **Type consistency:** `vindicatorWeight` (T1) → `computeCalibration` opts (T2) → `effectiveSourceConfidence`/`composedScore`/`usecases` (T3). `CalibrationEntry` shape preserved (semantics of `measured`/`sampleSize` documented as Beta posterior + effective n).
