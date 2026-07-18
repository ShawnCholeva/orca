# Completion-Gate Telemetry (Scoring Evolution — Phase 2c-iii)

**Date:** 2026-07-18
**Status:** Design — approved, pending spec review
**Scope:** Phase 2c-iii (final slice of 2c). Surface the **completion gate's evidence-veto outcomes** as a template-level governance readout, mirroring the existing tool-safety policy-gateway panel. Epistemic bands (2c-i) and gate-groundedness re-weight (2c-ii) already shipped.

---

## 1. Context & motivation

When a step's completion is **gated** (`stepCompletionGate`), the harness runs the sensor ladder + declared grounding checks in the workspace and **vetoes the agent's self-declared completion** if the merged verdict isn't "passed" (`service.ts:1290-1385`). The outcome is recorded on the single `step_complete` transition:
- verdict **passed** (and not refuted) → completion **upheld**;
- verdict **partial** → status `escalated`, `failure_code: "evidence_veto"` (soft veto — sent up);
- verdict **failed** → status `failed`, `failure_code: "evidence_veto"` (hard veto);
- evidence passed but an independent refuter overturned it → status `failed`, `failure_code: "refute_veto"`.

This is the harness's **executable accountability** layer — the deterministic veto on every gated completion. The data is fully persisted on `harness_transitions`, but nothing surfaces it as a control-surface readout. The tool-safety **policy gateway** already has exactly this treatment (`buildPolicyGatewayMetrics` → `PolicyGatewayMetrics` → the "Tool safety gateway" desktop panel). 2c-iii gives the completion gate the same inspectable panel.

**Not a duplicate of per-step failure modes.** `evidence_veto` may appear inside a *single step's* `failureModes` list (`aggregate.ts:410`), but that is per-step diagnosis. The completion-gate panel is **template-level and cross-step**: "across every gated completion, how often did the harness uphold vs escalate vs veto?" — the accountability view, not a per-step breakdown.

### `agent-harness.pdf` alignment
- §5.2.5 (p.64) — *"reliable code-as-agent-harness systems require… executable accountability: a safety layer that **filters, vetoes, escalates, and records** agent actions… high-stakes approvals should be **auditable state transitions**: what action was proposed, what evidence was shown."* → the 4-way distribution (upheld / escalated / evidence-vetoed / refute-vetoed) + sampled ids for drill-through.
- §3.5.1 (p.33) — telemetry channels: *"policy gateways expose boundary violations."* The completion gate is a second policy gateway; this makes it an inspectable channel.
- The 4-way split (escalated separate from evidence-vetoed) is deliberate: the paper names *"vetoes"* and *"escalates"* as distinct outcomes — an escalated completion (a human was asked) must not read identical to a hard rejection.

---

## 2. Goals & non-goals

### Goals
- Add a template-level `completionGate` readout to `TemplateMetricsDetail`: the 4-way distribution of gated-completion outcomes + a sampled list of the vetoed transitions for drill-through.
- Render it as a desktop panel beside "Tool safety gateway."
- Derive purely from already-persisted transition telemetry (recompute-on-read, no migration).

### Non-goals (2c-iii)
- No change to the completion gate's behavior (`service.ts`), the veto logic, or any scoring/calibration/band.
- No per-sensor failure-cluster breakdown of vetoes (YAGNI — mirror the policy gateway's flat readout).
- No new drill-through modal — sample ids are surfaced in the contract for a future click-through, matching `overPermissive.sampleTransitionIds` (which is also not yet a modal).

---

## 3. Design

### 3.1 Detecting a gated completion

A `step_complete` transition went through the completion gate **iff it carries an `evidence` facet**. The non-gated emit paths (`service.ts:1454, 1514`) explicitly attach no evidence; only the gated branch (`:1329-1373`) builds and records it (confirmed by the in-code comments "Gated steps already carry it on the evidence-gate emit above"). So `transition.evidence != null` is the exact, reliable denominator.

### 3.2 Daemon builder (`apps/daemon/src/metrics/gate-metrics.ts`)

New pure function next to `buildPolicyGatewayMetrics`:

```ts
export function buildCompletionGateMetrics(transitions: TemplateTransition[]): CompletionGateMetrics {
  const dist = { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 };
  const vetoedIds: string[] = [];
  for (const t of transitions) {
    const tr = t.transition;
    if (tr.boundary !== "step_complete") continue;
    if (t.stepTemplateId?.startsWith("__gate__:")) continue;
    if (!tr.evidence) continue; // only gated completions passed through the completion gate
    const oc = (tr as { telemetry?: { outcome?: { status?: string; failure_code?: string | null } } }).telemetry?.outcome;
    const fc = oc?.failure_code ?? null;
    if (fc === "refute_veto") {
      dist.refute_veto++;
      if (vetoedIds.length < GATE_SAMPLE_CAP) vetoedIds.push(tr.id);
    } else if (fc === "evidence_veto") {
      if (oc?.status === "escalated") dist.escalated++;
      else dist.evidence_veto++;
      if (vetoedIds.length < GATE_SAMPLE_CAP) vetoedIds.push(tr.id);
    } else {
      dist.upheld++; // evidence present, no veto failure_code ⇒ the gate upheld the completion
    }
  }
  return {
    verdictDist: dist,
    vetoed: { count: dist.escalated + dist.evidence_veto + dist.refute_veto, sampleTransitionIds: vetoedIds },
  };
}
```

Notes:
- `GATE_SAMPLE_CAP` (=5) already exists in this file; reuse it so sample lists match the other panels.
- `count` is the TRUE total of non-upheld outcomes; `sampleTransitionIds` is capped — exactly mirrors `overPermissive`.
- Buckets are mutually exclusive and exhaustive over gated completions: `upheld + escalated + evidence_veto + refute_veto` = number of gated completions.

### 3.3 Contract (`packages/contracts/src/metrics/index.ts`)

Add alongside `PolicyGatewayMetrics`:

```ts
export const CompletionGateMetrics = z.object({
  verdictDist: z.object({
    upheld: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    evidence_veto: z.number().int().nonnegative(),
    refute_veto: z.number().int().nonnegative(),
  }).strict(),
  vetoed: z.object({
    count: z.number().int().nonnegative(),
    sampleTransitionIds: z.array(z.string()),
  }).strict(),
}).strict();
export type CompletionGateMetrics = z.infer<typeof CompletionGateMetrics>;
```

Add `completionGate: CompletionGateMetrics` to `TemplateMetricsDetail` (next to `policyGateway`, index.ts:225). **REQUIRED** — the daemon always emits it. Per the 2c-i lesson, this ripples to every fixture building a `TemplateMetricsDetail`; the plan enumerates all of them.

### 3.4 Wire-up (`apps/daemon/src/metrics/usecases.ts:102`)

Next to `policyGateway: buildPolicyGatewayMetrics(transitions),` add:
```ts
    completionGate: buildCompletionGateMetrics(transitions),
```
(import `buildCompletionGateMetrics` from `./gate-metrics.js` alongside the existing import).

### 3.5 Desktop panel (`apps/desktop/src/metrics/GatePerformance.tsx`)

Immediately after the "Tool safety gateway" `<Panel>` (`:87-94`), add a sibling, gated on presence:

```tsx
  const cg = detail?.completionGate;
  // …
  {cg && (
    <Panel title="Completion gate" kicker="EVIDENCE VETO" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13, color: "var(--text-2)" }}>
        {cg.verdictDist.upheld} upheld · {cg.verdictDist.escalated} escalated · {cg.verdictDist.evidence_veto} vetoed · {cg.verdictDist.refute_veto} overturned
      </div>
      {cg.vetoed.count > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-3)" }}>
          {cg.vetoed.count} completion(s) the harness didn't accept as-is.
        </div>
      )}
    </Panel>
  )}
```

Copy intent: `upheld` = evidence passed, completion accepted; `escalated` = partial → sent up; `vetoed` = failed checks → rejected; `overturned` = an independent reviewer refuted it. **Run `no-jargon`**; if it flags "vetoed"/"overturned"/"escalated", substitute plainer synonyms that keep the four outcomes distinct (e.g. "escalated" → "sent up", "vetoed" → "blocked by checks", "overturned" → "overturned on review"). The four counts and their order must stay.

### 3.6 Backward-compat
Recompute-on-read; no migration. Old templates recompute their completion-gate distribution from persisted transitions on next read.

---

## 4. Testing & verification

### Unit (daemon — new `describe` in `gate-metrics.test.ts`)
Build `step_complete` transitions with an evidence facet and varied telemetry outcomes; assert `buildCompletionGateMetrics`:
- Counts an **upheld** completion (evidence present, `failure_code: null`).
- Counts an **escalated** (`failure_code: "evidence_veto"`, `status: "escalated"`) separately from a hard **evidence_veto** (`failure_code: "evidence_veto"`, `status: "failed"`).
- Counts a **refute_veto** (`failure_code: "refute_veto"`).
- **Ignores non-gated completions** (a `step_complete` with NO evidence facet contributes to nothing).
- **Ignores `__gate__:` transitions** and non-`step_complete` boundaries.
- `vetoed.count` = escalated + evidence_veto + refute_veto; `sampleTransitionIds` capped at `GATE_SAMPLE_CAP` (build 6 vetoes → 5 ids, count 6).

### Contract (`gate-failure-labels`/`index.test.ts`)
- `CompletionGateMetrics` parses; a `TemplateMetricsDetail` fixture with `completionGate` round-trips. (The required field forces every `TemplateMetricsDetail` fixture to add it — see plan.)

### Desktop
- `MetricsPage.test.tsx` (or `GatePerformance.test.tsx`): the panel renders the four counts in order; hidden when `completionGate` absent; `no-jargon` passes.

### Regression
- Full workspace green.

### Live (per `/verify`, needs daemon restart)
On **Adaptive Delivery**: the Execution step is the gated one (sensors). Confirm the new "Completion gate" panel shows a sane distribution (upheld ≥ 1; any escalations/vetoes match what the step failure modes imply). The panel sits beside "Tool safety gateway" and reads as its governance sibling.

> **Contract note:** `completionGate` is REQUIRED. Fixture ripple sites (from `grep policyGateway:`): `apps/daemon/src/metrics/usecases.ts` (producer — always emits), `apps/daemon/src/learning/diagnose.test.ts`, `packages/contracts/src/metrics/index.test.ts`, `apps/desktop/src/api.metrics.test.ts`, `apps/desktop/src/App.test.tsx`, `apps/desktop/src/metrics/MetricsPage.test.tsx`. The plan updates all of them (a shared empty-fixture helper if one exists).

---

## 5. Open items for the implementation plan
- Confirm `TemplateTransition` exposes `.transition.id`, `.transition.evidence`, and `.transition.telemetry.outcome.{status, failure_code}` (all already read elsewhere in `gate-metrics.ts`/`aggregate.ts`/`composed-score.ts`).
- Enumerate the exact `completionGate` empty-fixture value to paste into the 6 ripple sites: `{ verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } }`.
- Decide the final panel copy after running `no-jargon` (§3.5).
- Confirm whether any desktop fixture uses a shared `TemplateMetricsDetail` factory (update the factory once) vs inline objects (update each).
