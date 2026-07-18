# Gate-Groundedness Re-weight (Scoring Evolution — Phase 2c-ii)

**Date:** 2026-07-18
**Status:** Design — approved, pending spec review
**Scope:** Phase 2c-ii. Replace the gate's binary `isGrounded` (executable-only) groundedness signal with the graded composed-evidence model already used by the step score. Epistemic bands (2c-i) shipped; completion-gate telemetry (2c-iii) is a separate slice.

---

## 1. Context & motivation

The gate-health score (`gate-metrics.ts`) blends three terms:
`health = 0.5·(1 − overturnRate) + 0.3·groundedness + 0.2·convergence`.

The **groundedness** term asks "did the step this gate reviewed stand on real checks?" — but it answers with a **binary** (`gate-metrics.ts:52`):

```ts
const isGrounded = (d) =>
  !!ev && (ev.sensorsRun?.length ?? 0) > 0 && ev.oracleAdequacy?.sufficient === true;
```

That is **executable-only**: a step verified by strong grounding checks (but no sensors) counts as *ungrounded* — identical to a step with zero verification. This is exactly the failure the paper names (§5.2.2, p.62): *"a harness can become overconfident precisely because it has executable feedback… the green test is not the full specification."* Phases 2b–2c-i already replaced this binary for the **step score** with the graded `composedScore`. The gate's groundedness term is still stuck in the pre-2b binary world. 2c-ii routes it through the same graded model, so the gate and the step agree on how strong a completion's evidence was.

### `agent-harness.pdf` alignment
- §5.2.2 (p.62) — *"Treating feedback as calibrated evidence, rather than as a binary success signal, is essential."* → graded groundedness, not a 0/1 fraction.
- §5.2.1 (p.62) — verification strength is a **rate** ("test coverage, oracle diversity, rate of false acceptance") → groundedness = mean graded strength.
- p.65 — *"verify whether the intended grounded state changed as expected, rather than relying only on the model's self-report."* → the `blind_approve` redefinition (approved with **no independent verifier**, i.e. self-report/refuted only).

---

## 2. Goals & non-goals

### Goals
- Per-decision groundedness becomes **graded** (`[0,1]`) via `composedScore(reviewed, calibration).base`, replacing the binary `isGrounded`.
- The gate `groundedness` term = **mean** of per-decision graded values (was fraction-grounded).
- `blind_approve` and `ungroundedDecisionIds` use an honest "no independent verifier" cut, so strongly grounding-verified approvals are no longer mislabelled ungrounded/blind.
- The gate and the step score agree on a completion's evidence strength (same `composedScore`, same calibration).

### Non-goals (2c-ii)
- Completion-gate telemetry (2c-iii).
- Changing the gate-health **formula** or its weights (`W_OVERTURN 0.5 / W_GROUNDED 0.3 / W_CONVERGE 0.2`) — only the groundedness **input** changes.
- Changing `composedScore`, calibration, or the step score.
- Adding a new UI surface — the desktop still renders `groundedness` as a percentage (one copy line updated to match the graded meaning).
- Touching the gate→step **join** (which completion the gate reviewed) — unchanged.

---

## 3. Design

### 3.1 Basis: `base`, not `score` (decided)

Per-decision groundedness uses `composedScore(reviewed, calibration).base` — the compounding over **passing independent verifiers** (executable 1.0 / grounding 0.7 / review 0.55; self-report 0.3 floor; refuted/failed → 0), **excluding** coverage. Rationale:
- Groundedness measures **verification strength/independence** — the gate's three terms stay orthogonal (overturn = independence, groundedness = evidence strength, convergence = efficiency).
- `coverage` (the untested-code penalty) is the *step's own output-adequacy* and already lives in the step score. Folding it into the gate term would double-count it and conflate "the gate approved weak evidence" with "the step under review had coverage gaps" — two different failures.
- Matches §5.2.1 "verification strength as a rate."

### 3.2 The three changes (`apps/daemon/src/metrics/gate-metrics.ts`)

Import: `import { composedScore } from "./composed-score.js";` and `import { SOURCE_CONFIDENCE } from "./source-signals.js";` (and the `CalibrationEntry` type — see 3.3).

Replace the binary `isGrounded` block (`:51-60`) with:

```ts
// --- Groundedness: how strongly did the reviewed step's evidence stand up? (graded) ---
const GROUNDED_FLOOR = SOURCE_CONFIDENCE.self_report; // 0.3 — at/below ⇒ no independent verifier passed
const groundednessOf = (d: GateDecisionRow): number => {
  const completes = stepCompletesByRun.get(d.workflowRunId) ?? [];
  const reviewed = [...completes].reverse().find((t) => t.transition.createdAt < d.createdAt);
  return reviewed ? composedScore(reviewed, calibration).base : 0; // no reviewed step / refuted / failed ⇒ 0
};
const isUngrounded = (d: GateDecisionRow): boolean => groundednessOf(d) <= GROUNDED_FLOOR;

const groundedness = mean(decisions.map(groundednessOf)); // mean() ⇒ null on empty
const ungroundedDecisionIds = decisions.filter(isUngrounded).slice(0, GATE_SAMPLE_CAP).map((d) => d.id);
```

Notes:
- `mean` already returns `null` for an empty list, so `groundedness` stays `number | null` — **no contract change**.
- `base` uses `SOURCE_CONFIDENCE.self_report` (0.3) as its floor and never calibrates self-report, so `GROUNDED_FLOOR` is stable. A grounding-only step has `base ≈ 0.7 > 0.3` → **grounded** (not in the ungrounded/blind sets). Only self-report-only (`base === 0.3`) or refuted/failed (`base === 0`) fall at/below the floor.
- `groundednessOf` is called a few times per decision (term + sample list + `blind_approve`); `composedScore` is pure and cheap. Acceptable — do **not** prematurely memoize unless a test shows cost.

Update the `blind_approve` failure mode (`:106`) from the binary to `isUngrounded`:

```ts
pushMode("blind_approve", decisions.filter((d) => d.outcome === "approved" && isUngrounded(d)));
```

`limitingTerm`, health, and everything downstream read the same `groundedness` variable — unchanged.

### 3.3 Thread calibration into `buildGateMetrics`

`composedScore` takes an optional `CalibrationEntry[]`; the gate must pass the **same** calibration the step score uses, so a gate and its reviewed step see identical strengths.

- `buildGateMetrics` input type gains `calibration?: CalibrationEntry[]` (import the type from `./verification.js`). Inside, bind `const calibration = input.calibration;` for the closures.
- Call site `apps/daemon/src/metrics/usecases.ts:82` (`getTemplateMetricsDetail`) has `transitions` in scope. Add `const calibration = computeCalibration(transitions);` (import `computeCalibration` from `./verification.js`) and pass `calibration` into `buildGateMetrics({ … , calibration })`. This is the same transition window the gate→step join already uses.
- Passing `undefined` (the test call sites that omit it) makes `composedScore` fall back to designed priors — safe, and the existing gate tests that don't exercise groundedness keep working.

### 3.4 Contract — label copy only (no type change)

`groundedness` (`z.number().nullable()`) and `ungroundedDecisionIds` (`z.array(z.string())`) already exist — **no schema change**.

The `blind_approve` label (`packages/contracts/src/metrics/gate-failure-labels.ts:8`) is currently binary-framed and now inaccurate (a grounding check *did* run, it just wasn't executable):

```
blind_approve: "Approved without any checks run behind it",
```
→
```
blind_approve: "Approved on self-report alone — no independent verification",
```

`gate-failure-labels.test.ts` only asserts each label is non-empty plus a regex on `overturned_approve`, so this copy change is safe.

### 3.5 Desktop — one copy line

`apps/desktop/src/metrics/GatePerformance.tsx:56` currently reads:
```
{pct(gate.scored.groundedness)} of calls stood on checks that actually ran.
```
The "actually ran" framing is the retired binary. Update to the graded meaning, jargon-free:
```
{pct(gate.scored.groundedness)} average strength of the evidence behind gate calls.
```
No type or structural change; `pct(...)` and the value are unchanged.

### 3.6 Backward-compat
Recompute-from-persisted (no migration). Existing gates recompute their groundedness graded on next read. No new fields; consumers unaffected.

---

## 4. Testing & verification

### Unit (daemon, `gate-metrics.test.ts`)
Build decisions whose reviewed step-complete transitions carry evidence at each strength, and assert:
- **Grounding-only step (base ≈ 0.7) is grounded.** A decision reviewing a step with `grounding.verdict === "passed"` + an enforce check but **no sensors** contributes ≈0.7 to `groundedness` and is **absent** from `ungroundedDecisionIds` — the headline honesty case (was flagged ungrounded under the binary).
- **Executable step (base 1.0)** contributes ≈1.0.
- **Self-report-only step (base 0.3)** is `≤ GROUNDED_FLOOR` → in `ungroundedDecisionIds`; and if `outcome === "approved"`, in the `blind_approve` mode.
- **Refuted step (base 0)** → ungrounded.
- **Mixed set**: `groundedness` equals the mean of the per-decision `base` values (assert the arithmetic, e.g. one 1.0 + one 0.7 + one 0.3 → ≈0.667).
- **No reviewed step** (decision with no prior step-complete in its run) → contributes 0, is ungrounded.
- **Empty decisions** → `groundedness === null` (unchanged null-behaviour).

### Contract (`gate-failure-labels.test.ts`)
- All labels non-empty (existing generic assertion still passes with the new `blind_approve` copy).

### Desktop
- `GatePerformance.test.tsx` — the groundedness line renders the new copy; `no-jargon` passes.

### Regression
- Full workspace green (`pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`).

### Live (per `/verify`, needs daemon restart)
On the **Adaptive Delivery** workflow (Metrics → Gates): the two gates (Critique, Verify) review grounding-heavy steps. Confirm their `groundedness` percentage **rises** vs the binary (grounding-only reviews now count as ~0.7 instead of 0) and that `blind_approve` no longer fires on strongly-grounded approvals — the same honesty correction 2c-i showed for step bands, now on the gate side.

---

## 5. Open items for the implementation plan
- Confirm the exact `mean` import/behaviour (already defined at `gate-metrics.ts:13`, returns `null` on empty) so `groundedness` typing is preserved.
- Confirm `computeCalibration` is exported from `./verification.js` and importable in `usecases.ts` (it is used in `aggregate.ts:161`).
- Decide whether `groundednessOf` needs memoization — default **no** (pure, cheap; only memoize if a test surfaces cost).
- Verify no other consumer of `blind_approve` label copy exists beyond `gate-failure-labels.test.ts` (default: none).
