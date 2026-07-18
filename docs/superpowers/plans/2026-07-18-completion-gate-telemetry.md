# Completion-Gate Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the completion gate's evidence-veto outcomes as a template-level governance readout (upheld · escalated · evidence-vetoed · refute-vetoed), mirroring the existing tool-safety policy-gateway panel.

**Architecture:** A new pure `buildCompletionGateMetrics(transitions)` buckets gated `step_complete` transitions (those carrying an `evidence` facet) by `telemetry.outcome.{failure_code, status}` into a 4-way distribution + sampled vetoed ids. A new required `completionGate` field on `TemplateMetricsDetail` carries it; the daemon producer always emits it; a new `CompletionGateReadout` desktop component renders it beside `PolicyGatewayReadout`. Pure telemetry derivation — no `service.ts`/scoring change, recompute-on-read.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`apps/daemon`, `apps/desktop`, `packages/contracts`).

## Global Constraints

- `completionGate` is REQUIRED on `TemplateMetricsDetail` (the daemon always emits it). This ripples to every fixture building a `TemplateMetricsDetail`; Task 1 updates the contract-package + daemon fixtures, Task 2 updates the desktop fixtures. The exact empty value to paste verbatim:
  `completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } }`
- A gated completion is detected ONLY by `transition.evidence != null` on a `step_complete` transition (confirmed: non-gated emit paths attach no evidence). Do not use any other heuristic.
- Buckets are mutually exclusive + exhaustive over gated completions; `evidence_veto` splits by `status` (`escalated` → escalated bucket, else → evidence_veto bucket).
- `sampleTransitionIds` capped at `GATE_SAMPLE_CAP` (=5, already in `gate-metrics.ts`); `vetoed.count` is the TRUE total (escalated + evidence_veto + refute_veto).
- No change to `service.ts`, the veto logic, or any score/calibration/band.
- Paper anchors: §5.2.5 p.64 (executable accountability: filters/vetoes/escalates/records), §3.5.1 p.33 (policy gateways as an inspectable telemetry channel).

---

### Task 1: Contract + daemon — `CompletionGateMetrics` type, builder, wire-up

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (add `CompletionGateMetrics`; add `completionGate` to `TemplateMetricsDetail` ~:225)
- Modify: `packages/contracts/src/metrics/index.test.ts` (~:81 — add `completionGate` to the round-trip fixture)
- Modify: `apps/daemon/src/metrics/gate-metrics.ts` (import type; add `buildCompletionGateMetrics`)
- Modify: `apps/daemon/src/metrics/usecases.ts` (import + wire at ~:102)
- Modify: `apps/daemon/src/learning/diagnose.test.ts` (~:35 — add `completionGate` to fixture)
- Test: `apps/daemon/src/metrics/gate-metrics.test.ts`

**Interfaces:**
- Consumes: `TemplateTransition` (exposes `.transition.id`, `.transition.boundary`, `.transition.evidence`, `.transition.telemetry.outcome.{status, failure_code}`, `.stepTemplateId` — all already read in this file / `aggregate.ts`); `GATE_SAMPLE_CAP` (=5, `gate-metrics.ts`).
- Produces: `buildCompletionGateMetrics(transitions: TemplateTransition[]): CompletionGateMetrics`; `CompletionGateMetrics` contract type; `TemplateMetricsDetail.completionGate`.

- [ ] **Step 1: Add the contract type + field**

In `packages/contracts/src/metrics/index.ts`, next to `PolicyGatewayMetrics` (~:135):

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

In the `TemplateMetricsDetail` object (the line with `policyGateway: PolicyGatewayMetrics,` ~:225), add directly after it:
```ts
  completionGate: CompletionGateMetrics,
```

- [ ] **Step 2: Update the contract round-trip fixture**

In `packages/contracts/src/metrics/index.test.ts`, the `detail` fixture (~:81) has a `policyGateway: { … },` block. Add directly after that block:
```ts
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
```

- [ ] **Step 3: Write the failing daemon tests**

Add to `apps/daemon/src/metrics/gate-metrics.test.ts` (import `buildCompletionGateMetrics` from `./gate-metrics.js` alongside the existing `buildGateMetrics, buildPolicyGatewayMetrics`):

```ts
const cgT = (over: { id?: string; evidence?: unknown; status?: string; failure_code?: string | null; boundary?: string; stepTemplateId?: string }): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: over.stepTemplateId ?? "s1",
  transition: {
    id: over.id ?? "t", workflowRunId: "r1", boundary: over.boundary ?? "step_complete",
    createdAt: "2026-07-16T00:00:00.000Z",
    evidence: over.evidence,
    telemetry: { outcome: { status: over.status ?? "succeeded", failure_code: over.failure_code ?? null } },
  } as never,
});

describe("buildCompletionGateMetrics", () => {
  it("buckets gated completions 4 ways and ignores non-gated / gate / non-complete transitions", () => {
    const cg = buildCompletionGateMetrics([
      cgT({ id: "up1", evidence: {}, status: "succeeded", failure_code: null }),
      cgT({ id: "esc1", evidence: {}, status: "escalated", failure_code: "evidence_veto" }),
      cgT({ id: "veto1", evidence: {}, status: "failed", failure_code: "evidence_veto" }),
      cgT({ id: "ref1", evidence: {}, status: "failed", failure_code: "refute_veto" }),
      cgT({ id: "nongated", status: "succeeded", failure_code: null }),                       // NO evidence → ignored
      cgT({ id: "gatenode", evidence: {}, stepTemplateId: "__gate__:review" }),               // gate node → ignored
      cgT({ id: "toolgate", evidence: {}, boundary: "tool_gate" }),                           // wrong boundary → ignored
    ]);
    expect(cg.verdictDist).toEqual({ upheld: 1, escalated: 1, evidence_veto: 1, refute_veto: 1 });
    expect(cg.vetoed.count).toBe(3);
    expect([...cg.vetoed.sampleTransitionIds].sort()).toEqual(["esc1", "ref1", "veto1"]);
  });

  it("caps sampleTransitionIds at GATE_SAMPLE_CAP while count stays the true total", () => {
    const cg = buildCompletionGateMetrics(
      Array.from({ length: 6 }, (_, i) => cgT({ id: `v${i}`, evidence: {}, status: "failed", failure_code: "evidence_veto" })),
    );
    expect(cg.verdictDist.evidence_veto).toBe(6);
    expect(cg.vetoed.count).toBe(6);
    expect(cg.vetoed.sampleTransitionIds).toHaveLength(5);
  });

  it("no gated completions → all zero", () => {
    expect(buildCompletionGateMetrics([]).verdictDist).toEqual({ upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 });
  });
});
```

- [ ] **Step 4: Run daemon tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- gate-metrics`
Expected: the three new tests FAIL (`buildCompletionGateMetrics is not a function`).

- [ ] **Step 5: Add the builder**

In `apps/daemon/src/metrics/gate-metrics.ts`, add `CompletionGateMetrics` to the `@orca/contracts` type import at the top, then add this function next to `buildPolicyGatewayMetrics`:

```ts
export function buildCompletionGateMetrics(transitions: TemplateTransition[]): CompletionGateMetrics {
  const dist = { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 };
  const vetoedIds: string[] = [];
  for (const t of transitions) {
    const tr = t.transition;
    if (tr.boundary !== "step_complete") continue;
    if (t.stepTemplateId?.startsWith("__gate__:")) continue;
    if (!(tr as { evidence?: unknown }).evidence) continue; // only gated completions carry an evidence facet
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
      dist.upheld++;
    }
  }
  return {
    verdictDist: dist,
    vetoed: { count: dist.escalated + dist.evidence_veto + dist.refute_veto, sampleTransitionIds: vetoedIds },
  };
}
```

- [ ] **Step 6: Wire into the producer**

In `apps/daemon/src/metrics/usecases.ts`, add `buildCompletionGateMetrics` to the existing `import { buildGateMetrics, buildPolicyGatewayMetrics } from "./gate-metrics.js";`. Then next to `policyGateway: buildPolicyGatewayMetrics(transitions),` (~:102) add:
```ts
    completionGate: buildCompletionGateMetrics(transitions),
```

- [ ] **Step 7: Update the daemon fixture**

In `apps/daemon/src/learning/diagnose.test.ts`, the fixture with `policyGateway: { … }` (~:35) — add directly after that block:
```ts
    completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
```

- [ ] **Step 8: Run daemon tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- gate-metrics` (new tests PASS), then `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/contracts typecheck`.
Expected: contracts + daemon green. (Desktop typecheck will be RED until Task 2 — that is expected and correct.)

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/metrics/index.ts packages/contracts/src/metrics/index.test.ts apps/daemon/src/metrics/gate-metrics.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/learning/diagnose.test.ts apps/daemon/src/metrics/gate-metrics.test.ts
git commit -m "feat(metrics): completion-gate evidence-veto telemetry (4-way verdict distribution)"
```

---

### Task 2: Desktop — `CompletionGateReadout` panel + fixtures

**Files:**
- Modify: `apps/desktop/src/metrics/GatePerformance.tsx` (add `CompletionGateReadout` component)
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx` (import + mount at ~:82)
- Modify: `apps/desktop/src/api.metrics.test.ts` (~:71 — add `completionGate` inline)
- Modify: `apps/desktop/src/App.test.tsx` (~:131 — add `completionGate` after `policyGateway` block)
- Modify: `apps/desktop/src/metrics/MetricsPage.test.tsx` (~:24, :33, :59 — add `completionGate` inline to all three mocks)
- Test: `apps/desktop/src/metrics/MetricsPage.test.tsx` (render assertion) + `no-jargon.test.tsx` (existing scan)

**Interfaces:**
- Consumes: `TemplateMetricsDetail.completionGate` (from Task 1); `Panel` (already imported in `GatePerformance.tsx`); `PolicyGatewayReadout` mount pattern (`MetricsPage.tsx:82`).
- Produces: `CompletionGateReadout({ detail })` exported from `GatePerformance.tsx`.

- [ ] **Step 1: Add the component**

In `apps/desktop/src/metrics/GatePerformance.tsx`, directly after the `PolicyGatewayReadout` function (ends ~:96), add:

```tsx
export function CompletionGateReadout({ detail }: { detail: TemplateMetricsDetail | null }) {
  const cg = detail?.completionGate;
  if (!cg) return null;
  const d = cg.verdictDist;
  const total = d.upheld + d.escalated + d.evidence_veto + d.refute_veto;
  if (total === 0) return null;
  return (
    <Panel title="Completion gate" kicker="EVIDENCE VETO" style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
        {d.upheld} upheld · {d.escalated} escalated · {d.evidence_veto} vetoed · {d.refute_veto} overturned
      </div>
      {cg.vetoed.count > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-3)" }}>
          {cg.vetoed.count} completion(s) the harness didn't accept as-is.
        </div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 2: Mount it beside the policy gateway**

In `apps/desktop/src/metrics/MetricsPage.tsx`: add `CompletionGateReadout` to the existing import `import { GatePerformancePanel, PolicyGatewayReadout } from "./GatePerformance";` (~:7). Then directly after `<PolicyGatewayReadout detail={detail} />` (~:82) add:
```tsx
        <CompletionGateReadout detail={detail} />
```

- [ ] **Step 3: Update the desktop fixtures**

Add the `completionGate` value to each `TemplateMetricsDetail` mock (identical value everywhere):
`completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } }`

- `apps/desktop/src/api.metrics.test.ts:71` — inline object; add the key before the closing `}`.
- `apps/desktop/src/App.test.tsx:131` — add after the `policyGateway: { … }` block.
- `apps/desktop/src/metrics/MetricsPage.test.tsx:24, :33, :59` — three inline mocks; add the key to each.

- [ ] **Step 4: Write a render assertion**

In `apps/desktop/src/metrics/MetricsPage.test.tsx`, add a test that a non-empty `completionGate` renders the four counts. Use the existing render harness in that file; set the mock's `completionGate` to `{ verdictDist: { upheld: 3, escalated: 1, evidence_veto: 2, refute_veto: 0 }, vetoed: { count: 3, sampleTransitionIds: ["a","b","c"] } }` and assert the rendered text contains `3 upheld`, `1 escalated`, `2 vetoed`, `0 overturned`.

- [ ] **Step 5: Run desktop tests + typecheck + no-jargon**

Run: `pnpm --filter @orca/desktop test -- MetricsPage api.metrics App no-jargon && pnpm --filter @orca/desktop typecheck`
Expected: green. If `no-jargon` flags "vetoed"/"overturned"/"escalated"/"upheld", replace with plainer synonyms that keep the four outcomes distinct and ordered (e.g. "escalated"→"sent up", "vetoed"→"blocked by checks", "overturned"→"overturned on review"), and update the Step 4 assertion to match. Record the final wording in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/metrics/GatePerformance.tsx apps/desktop/src/metrics/MetricsPage.tsx apps/desktop/src/api.metrics.test.ts apps/desktop/src/App.test.tsx apps/desktop/src/metrics/MetricsPage.test.tsx
git commit -m "feat(desktop): completion-gate readout panel beside the policy gateway"
```

---

### Task 3: Verify — full workspace, whole-branch review, live check

**Files:** none (verification only).

- [ ] **Step 1: Full-workspace deterministic verify**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
Expected: all four green.

- [ ] **Step 2: Whole-branch review**

Dispatch a fresh reviewer over the phase diff (base = the commit before Task 1 .. HEAD). Verify: gated-completion detection is `evidence != null` only; the 4-way buckets are mutually exclusive + exhaustive; `escalated` splits from `evidence_veto` by `status`; `sampleTransitionIds` capped at `GATE_SAMPLE_CAP` while `count` is the true total; the desktop component mirrors `PolicyGatewayReadout` (null-guard, zero-guard); no `service.ts`/scoring change; the required-field ripple covered all `TemplateMetricsDetail` fixtures (no consumer left red). Feed it the ledger's Minor-findings list for triage.

- [ ] **Step 3: Live check (needs daemon restart — ask the user first)**

On **Adaptive Delivery** (Metrics tab): the new "Completion gate" panel appears beside "Tool safety gateway" with a sane distribution (Execution is the gated/sensor step → at least 1 upheld; any vetoes consistent with the step failure modes). Capture a screenshot.

- [ ] **Step 4: Mark the phase complete in the ledger and update the phase memory (`phase2-scoring-evolution.md`).**

---

## Self-Review

**Spec coverage:** builder + 4-way buckets + gated-detector (T1 S5), contract type + required field (T1 S1), producer wire-up (T1 S6), fixture ripple across all 6 sites (T1 S2/S7 + T2 S3), desktop panel mirroring PolicyGatewayReadout (T2 S1-2), no-jargon (T2 S5), live check (T3 S3). All spec §3 items map to a task.

**Placeholder scan:** none — every code step is complete; test bodies carry concrete expected values; the empty-fixture value is given verbatim.

**Type consistency:** `buildCompletionGateMetrics → CompletionGateMetrics`; `verdictDist` keys (`upheld/escalated/evidence_veto/refute_veto`) match between contract, builder, tests, and desktop reads; `vetoed.{count, sampleTransitionIds}` consistent; the empty-fixture value matches the schema (all four counts + count + ids). `cgT` fixture uses the same `as never` transition-shape pattern as the existing `riskT` helper.
