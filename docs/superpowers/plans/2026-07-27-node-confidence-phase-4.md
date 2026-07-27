# Node Confidence Model — Phase 4 — Drawer Reason Vocabulary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every node's *confidence evidence* in the Metrics drawer — a system-owned, node-naming, no-jargon reason line for steps (killing the "No problems detected" gap at score < 100), plus gate `decisionConfidence` and splitter `confidence` display gated by the measured-state guard.

**Architecture:** The daemon computes a deterministic `confidenceReason` on each `StepMetrics` from the *same evidence the score already used* (band, verifier mix, downstream vindication) — never editorial copy — resolving the real verifying-gate **name** from graph topology (which only the daemon has). The desktop renders the reason through a contracts-level enumerated catalog (extending the `failure-labels.ts` discipline) and surfaces the already-shipped Phase-3 gate/splitter confidence numbers, showing a value **only when `state === "measured"`**.

**Tech Stack:** TypeScript, Zod contracts (`@orca/contracts`), Vitest, React (desktop), Testing Library.

## Global Constraints

- **No migration; recompute-on-read.** `confidenceReason` derives at read time from persisted transitions/vindication. No DB writes, no schema migration. New contract field is **optional** so existing fixtures stay valid.
- **Never editorial copy.** The reason is derived from the score's own evidence computation (band level, `verifierMix`, `vindication` tally). No hand-authored per-step strings.
- **Must NOT move any score.** Phase 4 is display-only. `composedScore`, band, calibration, `StepMetrics.score` are untouched. A test asserts scores are byte-identical with and without the new field.
- **Node-naming from real graph nodes.** `weak_verifier` names the actual gate node (e.g. "Critique"), resolved from graph topology in `usecases.ts` — never a hardcoded name.
- **No-jargon (hard).** No rendered string may contain `oracle`, `sensor`, `verdict`, `refute`, or `veto` (word-boundary, case-insensitive). Guarded by `no-jargon.test.tsx`.
- **Measured-state guard (from Phase-3 review).** Render `GateMetrics.decisionConfidence.value` and `SplitterMetrics.confidence.value` as a number **only when `state === "measured"`**. At `insufficient` the value is present but thin-sampled — show an honest "not enough … yet" line, never the number.
- **Version-safety inherited.** The derivation consumes already-latest-version-filtered inputs (`computeStepMetrics` scope + the `latestVersion*` arrays in `usecases.ts`); do not re-introduce cross-version mixing.

---

### Task 1: Confidence-reason catalog + contract field (contracts)

**Files:**
- Create: `packages/contracts/src/metrics/confidence-reasons.ts`
- Create: `packages/contracts/src/metrics/confidence-reasons.test.ts`
- Modify: `packages/contracts/src/metrics/index.ts` (add `ConfidenceReason` schema + `StepMetrics.confidenceReason` field; re-export the label helper)
- Modify: `packages/contracts/src/index.ts` (re-export `labelForConfidenceReason` + `ConfidenceReason` if the package's public surface is barrelled there — check and match how `labelForFailure` is exported)

**Interfaces:**
- Produces:
  - `CONFIDENCE_REASON_CODES: readonly ["no_check_yet","review_only","weak_verifier","vindication_pending","downstream_bounced"]`
  - `ConfidenceReason` (zod): `{ code: enum(CONFIDENCE_REASON_CODES), nodeName?: string }`
  - `labelForConfidenceReason(reason: ConfidenceReason): string`
  - `StepMetrics.confidenceReason?: ConfidenceReason` (optional, nullable-by-absence)

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/metrics/confidence-reasons.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CONFIDENCE_REASON_CODES, labelForConfidenceReason } from "./confidence-reasons";

describe("labelForConfidenceReason", () => {
  it("returns a non-empty, jargon-free label for every code", () => {
    for (const code of CONFIDENCE_REASON_CODES) {
      const label = labelForConfidenceReason({ code, nodeName: "Critique" });
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
    }
  });

  it("interpolates the node name for weak_verifier", () => {
    expect(labelForConfidenceReason({ code: "weak_verifier", nodeName: "Critique" }))
      .toBe("Critique approved this, but that hasn't held up downstream yet.");
  });

  it("has a sensible fallback when weak_verifier has no node name", () => {
    expect(labelForConfidenceReason({ code: "weak_verifier" }))
      .toBe("A review approved this, but that hasn't held up downstream yet.");
  });

  it("ignores nodeName for codes that don't use it", () => {
    expect(labelForConfidenceReason({ code: "no_check_yet", nodeName: "Critique" }))
      .toBe("Nothing independent has checked this step yet.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test confidence-reasons`
Expected: FAIL — module `./confidence-reasons` not found.

- [ ] **Step 3: Write the catalog** — `packages/contracts/src/metrics/confidence-reasons.ts`

```ts
// Deterministic, human-readable labels for the confidence-reason enum — the drawer's
// "why isn't this a 100?" line. Renders the score's own evidence computation; never
// editorial copy. No jargon (guarded). Mirrors the failure-labels.ts discipline.
export const CONFIDENCE_REASON_CODES = [
  "no_check_yet",
  "review_only",
  "weak_verifier",
  "vindication_pending",
  "downstream_bounced",
] as const;

export type ConfidenceReasonCode = (typeof CONFIDENCE_REASON_CODES)[number];

export function labelForConfidenceReason(reason: { code: ConfidenceReasonCode; nodeName?: string }): string {
  switch (reason.code) {
    case "no_check_yet":
      return "Nothing independent has checked this step yet.";
    case "review_only":
      return "Only lightly checked — nothing has run to confirm it.";
    case "weak_verifier":
      return `${reason.nodeName ?? "A review"} approved this, but that hasn't held up downstream yet.`;
    case "vindication_pending":
      return "The next step hasn't accepted this work yet.";
    case "downstream_bounced":
      return "Downstream sent this work back.";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test confidence-reasons`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the contract schema + field** — `packages/contracts/src/metrics/index.ts`

Near the other small schemas (above `StepMetrics`), add:

```ts
export const ConfidenceReason = z.object({
  code: z.enum(CONFIDENCE_REASON_CODES),
  nodeName: z.string().optional(),
}).strict();
export type ConfidenceReason = z.infer<typeof ConfidenceReason>;
```

Add the import at the top of `index.ts` (match the existing `labelForFailure` re-export pattern):

```ts
import { CONFIDENCE_REASON_CODES } from "./confidence-reasons.js";
export { labelForConfidenceReason, CONFIDENCE_REASON_CODES } from "./confidence-reasons.js";
export type { ConfidenceReasonCode } from "./confidence-reasons.js";
```

Inside the `StepMetrics` object schema, alongside `vindication` (the other Phase-2a optional), add:

```ts
  // Phase 4 (display-only): the derived reason the step's confidence is below full —
  // rendered through labelForConfidenceReason, naming the real verifying node where
  // relevant. Derived from the score's own evidence (band, verifierMix, vindication);
  // does not move the score. Absent/undefined ⇔ nothing is limiting (strong & clean,
  // or hard failures already listed in failureClusters).
  confidenceReason: ConfidenceReason.optional(),
```

- [ ] **Step 6: Verify the label helper is re-exported from the package root**

Check how `labelForFailure` reaches consumers (`import { labelForFailure } from "@orca/contracts"` is used in `StepPerformance.tsx`). Ensure `labelForConfidenceReason`, `ConfidenceReason`, and `CONFIDENCE_REASON_CODES` are exported the same way (via `packages/contracts/src/index.ts` or the metrics barrel — mirror `labelForFailure` exactly).

Run: `pnpm --filter @orca/contracts test`
Expected: PASS (all contracts tests, including the new file).

- [ ] **Step 7: Rebuild the contracts dist** (desktop + daemon import the built package)

Run: `pnpm --filter @orca/contracts build`
Expected: clean build; `dist/metrics/confidence-reasons.js` and updated `dist/metrics/index.d.ts` emitted.

- [ ] **Step 8: Typecheck the workspace**

Run: `pnpm -w tsc --noEmit` (or the repo's typecheck script — check `package.json`)
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/metrics/confidence-reasons.ts packages/contracts/src/metrics/confidence-reasons.test.ts packages/contracts/src/metrics/index.ts packages/contracts/src/index.ts packages/contracts/dist
git commit -m "feat(metrics): confidence-reason catalog + StepMetrics.confidenceReason (contracts)"
```

---

### Task 2: Daemon derivation — `deriveConfidenceReason` + wire into step metrics

**Files:**
- Create: `apps/daemon/src/metrics/confidence-reason.ts`
- Create: `apps/daemon/src/metrics/confidence-reason.test.ts`
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`computeStepMetrics`: accept an optional `verifyingGateNameByStep` map + populate `confidenceReason` on each step)
- Modify: `apps/daemon/src/metrics/usecases.ts` (`getTemplateMetricsDetail`: build `verifyingGateNameByStep` from graph topology, pass it into `computeStepMetrics`)
- Modify: `apps/daemon/src/metrics/usecases.node-vindication.test.ts` **or** add to `aggregate.steps.test.ts` — an E2E assertion that a gate-approved-but-not-vindicated step surfaces `weak_verifier` with the gate name, and that scores are unchanged.

**Interfaces:**
- Consumes (from Task 1): `ConfidenceReason`, `ConfidenceReasonCode`.
- Produces:
  - `deriveConfidenceReason(input: { bandLevel: "strong"|"weak"|"needs_evidence"; verifierMix: { executable: number; grounding: number; independentReview: number; selfReportOnly: number }; verifiedSampleSize: number; vindication?: { vindicated: number; bounced: number; pending: number }; hasFailureClusters: boolean; verifyingGateName?: string }): ConfidenceReason | null`
  - `computeStepMetrics` gains optional input `verifyingGateNameByStep?: Map<string, string>` (stepTemplateId → gate node name).

- [ ] **Step 1: Write the failing test** — `apps/daemon/src/metrics/confidence-reason.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { deriveConfidenceReason } from "./confidence-reason.js";

const mix = (o: Partial<{ executable: number; grounding: number; independentReview: number; selfReportOnly: number }>) =>
  ({ executable: 0, grounding: 0, independentReview: 0, selfReportOnly: 0, ...o });

describe("deriveConfidenceReason", () => {
  it("returns null when hard failure clusters already tell the story", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 3 }), verifiedSampleSize: 3, hasFailureClusters: true })).toBeNull();
  });

  it("no_check_yet when nothing was independently verified", () => {
    expect(deriveConfidenceReason({ bandLevel: "needs_evidence", verifierMix: mix({ selfReportOnly: 5 }), verifiedSampleSize: 0, hasFailureClusters: false }))
      .toEqual({ code: "no_check_yet" });
  });

  it("downstream_bounced dominates when a completion was sent back", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 4 }), verifiedSampleSize: 4, vindication: { vindicated: 1, bounced: 2, pending: 0 }, hasFailureClusters: false, verifyingGateName: "Critique" }))
      .toEqual({ code: "downstream_bounced" });
  });

  it("weak_verifier names the gate when only a review verified it", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 5 }), verifiedSampleSize: 5, vindication: { vindicated: 0, bounced: 0, pending: 3 }, hasFailureClusters: false, verifyingGateName: "Critique" }))
      .toEqual({ code: "weak_verifier", nodeName: "Critique" });
  });

  it("review_only when review-verified but no named gate", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 5 }), verifiedSampleSize: 5, hasFailureClusters: false }))
      .toEqual({ code: "review_only" });
  });

  it("vindication_pending when a real check ran but downstream hasn't accepted it", () => {
    expect(deriveConfidenceReason({ bandLevel: "strong", verifierMix: mix({ executable: 6 }), verifiedSampleSize: 6, vindication: { vindicated: 0, bounced: 0, pending: 4 }, hasFailureClusters: false }))
      .toEqual({ code: "vindication_pending" });
  });

  it("null when strong, verified, and clean — nothing limiting", () => {
    expect(deriveConfidenceReason({ bandLevel: "strong", verifierMix: mix({ executable: 6 }), verifiedSampleSize: 6, vindication: { vindicated: 5, bounced: 0, pending: 0 }, hasFailureClusters: false }))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test confidence-reason`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure derivation** — `apps/daemon/src/metrics/confidence-reason.ts`

```ts
import type { ConfidenceReason } from "@orca/contracts";

// Deterministic, evidence-only derivation of WHY a step's confidence is below full.
// Consumes the same signals the score already computed (band, verifier mix, downstream
// vindication) — display-only, never moves the score. Returns null when nothing limits
// confidence (strong & clean) or when hard failures already populate failureClusters.
export function deriveConfidenceReason(input: {
  bandLevel: "strong" | "weak" | "needs_evidence";
  verifierMix: { executable: number; grounding: number; independentReview: number; selfReportOnly: number };
  verifiedSampleSize: number;
  vindication?: { vindicated: number; bounced: number; pending: number };
  hasFailureClusters: boolean;
  verifyingGateName?: string;
}): ConfidenceReason | null {
  const { bandLevel, verifierMix, verifiedSampleSize, vindication, hasFailureClusters, verifyingGateName } = input;

  // Hard failures already speak in the failureClusters list — don't double up.
  if (hasFailureClusters) return null;

  // Never independently checked → the coverage gap, in plain words.
  if (verifiedSampleSize === 0 || bandLevel === "needs_evidence") return { code: "no_check_yet" };

  // A completion that got sent back downstream is the strongest limiter.
  if (vindication && vindication.bounced > 0) return { code: "downstream_bounced" };

  const pendingUnaccepted = !!vindication && vindication.pending > 0 && vindication.vindicated === 0;

  if (bandLevel === "strong") {
    // Strong verification; only an unaccepted downstream can still limit it.
    if (pendingUnaccepted) return { code: "vindication_pending" };
    return null; // strong, verified, accepted → nothing limiting
  }

  // Weak band: verified, but not by a hard anchor.
  const onlyReview = verifierMix.independentReview > 0 && verifierMix.executable === 0 && verifierMix.grounding === 0;
  if (onlyReview && verifyingGateName) return { code: "weak_verifier", nodeName: verifyingGateName };
  if (pendingUnaccepted) return { code: "vindication_pending" };
  return { code: "review_only" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test confidence-reason`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into `computeStepMetrics`** — `apps/daemon/src/metrics/aggregate.ts`

Add to the input type (after `vindicationByCompletion`):

```ts
  verifyingGateNameByStep?: Map<string, string>;
```

Add the import at the top of `aggregate.ts`:

```ts
import { deriveConfidenceReason } from "./confidence-reason.js";
```

Where the `step: StepMetrics` object is assembled (near `scoreBreakdown`/`vindication`, ~line 559), compute the reason from the already-computed locals in scope (`bandLevel`, `scoreBreakdown.verifierMix`, `verifiedCompletes.length`, `vindTally`, `failureClusters`) and add the field. `vindTally` is only meaningful when `input.vindicationByCompletion` was supplied (mirror how `vindication:` is set):

```ts
    const confidenceReason = deriveConfidenceReason({
      bandLevel,
      verifierMix: scoreBreakdown.verifierMix,
      verifiedSampleSize: verifiedCompletes.length,
      vindication: input.vindicationByCompletion ? vindTally : undefined,
      hasFailureClusters: failureClusters.length > 0,
      verifyingGateName: input.verifyingGateNameByStep?.get(stepTemplateId),
    });
```

Add `confidenceReason: confidenceReason ?? undefined,` to the `step` object literal (alongside `vindication`).

> **Note for the implementer:** confirm the exact local variable names (`bandLevel`, `scoreBreakdown`, `verifiedCompletes`, `vindTally`, `failureClusters`) against the current `computeStepMetrics` body before wiring — use whatever the code actually calls them; the plan lists the expected names but the source is authoritative.

- [ ] **Step 6: Build `verifyingGateNameByStep` in usecases + pass it** — `apps/daemon/src/metrics/usecases.ts`

In `getTemplateMetricsDetail`, the graph and `gateApprovalsByStep(graph, latestVersionGateDecisions)` (→ `Map<stepId, Set<gateNodeId>>`) are already computed (~line 149, `approvals`). Build a step→gate-name map from the graph's gate node names:

```ts
  // Phase 4: name the gate that reviews each step, for the weak_verifier confidence
  // reason. gateApprovalsByStep gives stepId → set of approving gate node ids; resolve
  // the first to its graph node name. Read-time, latest-version (approvals already are).
  const gateNameById = new Map<string, string>();
  if (graph) for (const n of graph.nodes) if (n.type === "gate") gateNameById.set(n.id, n.name ?? n.id);
  const verifyingGateNameByStep = new Map<string, string>();
  for (const [stepId, gateIds] of approvals) {
    const first = [...gateIds][0];
    if (first && gateNameById.has(first)) verifyingGateNameByStep.set(stepId, gateNameById.get(first)!);
  }
```

Pass it into the `computeStepMetrics({ ... })` call (alongside `gateApprovedByCompletion`):

```ts
      verifyingGateNameByStep,
```

> **Note:** confirm `WorkflowGraph.nodes[].name`/`.type` field names against the graph type already parsed in `usecases.ts` (the file already reads `graph.nodes` with `type`/`name` for splitter/gate names — reuse that shape).

- [ ] **Step 7: E2E test — reason surfaces, scores unchanged** — add to `apps/daemon/src/metrics/usecases.node-vindication.test.ts` (it already builds a graph + gate decisions + transitions fixture).

Add a case asserting: for a step approved by a gate whose approval is not yet vindicated (pending), the returned `StepMetrics.confidenceReason` equals `{ code: "weak_verifier", nodeName: "<gate name>" }`; and (critical) capture `steps.map(s => s.score)` from a run WITHOUT the new wiring vs WITH — assert identical. If a no-wiring baseline is awkward in this file, instead assert the specific step's `score` matches the exact pre-Phase-4 expected value already asserted elsewhere in the suite (the derivation must not perturb it).

```ts
// (sketch — adapt to the file's existing fixture builders)
it("surfaces weak_verifier naming the gate, without moving the score", async () => {
  const detail = await getTemplateMetricsDetail(/* existing fixture args */);
  const step = detail.steps.find((s) => s.stepTemplateId === "<gated step id>")!;
  expect(step.confidenceReason).toEqual({ code: "weak_verifier", nodeName: "<gate name>" });
  expect(step.score).toBe(/* the exact score this fixture already produces pre-P4 */);
});
```

- [ ] **Step 8: Run the daemon metrics suite**

Run: `pnpm --filter @orca/daemon test src/metrics`
Expected: PASS (all metrics tests, including the two new/updated files). Confirm no existing score assertion changed.

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @orca/daemon tsc --noEmit` (or repo typecheck)
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/metrics/confidence-reason.ts apps/daemon/src/metrics/confidence-reason.test.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/usecases.node-vindication.test.ts
git commit -m "feat(metrics): derive StepMetrics.confidenceReason from score evidence (naming the verifying gate); display-only"
```

---

### Task 3: Desktop step drawer — render the confidence-reason line

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (the "What's going wrong" block in `StepRow`)
- Modify: `apps/desktop/src/metrics/no-jargon.test.tsx` (add a `confidenceReason` to the fixture + assert it renders)

**Interfaces:**
- Consumes: `StepMetrics.confidenceReason` (Task 1), `labelForConfidenceReason` (Task 1).

- [ ] **Step 1: Write the failing test** — extend `apps/desktop/src/metrics/no-jargon.test.tsx`

Add `confidenceReason: { code: "weak_verifier", nodeName: "Critique" }` to the `step` fixture object (line ~10-27). Then add a test in the `describe("no jargon in the metrics step detail")` block:

```ts
it("renders the confidence-reason line naming the real node, not the empty fallback", () => {
  render(<StepRow step={step} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/Critique approved this, but that hasn't held up downstream yet\./i)).toBeTruthy();
});
```

Note: the existing fixture has a `failureClusters` entry, which would suppress the reason (`hasFailureClusters`). For THIS test, render a variant with `failureClusters: []` so the reason line is the one that shows:

```ts
it("renders the confidence-reason line naming the real node, not the empty fallback", () => {
  render(<StepRow step={{ ...step, failureClusters: [], confidenceReason: { code: "weak_verifier", nodeName: "Critique" } }} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/Critique approved this, but that hasn't held up downstream yet\./i)).toBeTruthy();
  expect(screen.queryByText(/No problems detected this period\./i)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test no-jargon`
Expected: FAIL — reason text not found; "No problems detected" still rendered.

- [ ] **Step 3: Render the reason** — `apps/desktop/src/metrics/StepPerformance.tsx`

Import the helper (line 3, alongside `labelForFailure`):

```ts
import { labelForFailure, labelForConfidenceReason } from "@orca/contracts";
```

Replace the empty-state fallback line (currently line 195):

```tsx
{step.failureClusters.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
```

with a version that prefers the derived confidence reason when present:

```tsx
{step.failureClusters.length === 0 && (
  step.confidenceReason
    ? <div style={{ fontSize: 12, color: "var(--warn)" }}>{labelForConfidenceReason(step.confidenceReason)}</div>
    : <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>
)}
```

(Rationale: `confidenceReason` is only ever non-null when the score is below full for a non-failure reason — so this line honestly fills the gap. When it's null AND there are no clusters, the step is strong & clean → keep the positive message.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test no-jargon`
Expected: PASS — including the existing `not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i)` assertion (the reason vocabulary is jargon-free by construction).

- [ ] **Step 5: Run the step-performance test file** (guard against regressions)

Run: `pnpm --filter @orca/desktop test StepPerformance`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/no-jargon.test.tsx
git commit -m "feat(metrics-ui): step drawer renders the confidence-reason line, closing the 'No problems detected' gap"
```

---

### Task 4: Desktop gate + splitter confidence display (measured-guard)

**Files:**
- Modify: `apps/desktop/src/metrics/GatePerformance.tsx` (`GateRow` drawer: add a decision-confidence line; `FusedPipelinePanel` splitter branch: surface splitter confidence + attribution)
- Modify: `apps/desktop/src/metrics/GatePerformance.test.tsx` (assert measured vs insufficient rendering)

**Interfaces:**
- Consumes: `GateMetrics.decisionConfidence` (`{ value, sampleSize, state }`), `SplitterMetrics` (`{ confidence: { value, sampleSize, state }, deterministic, attributedToNodeId, retrospectiveOnly, misrouteRate }`), `TemplateMetricsDetail.splitters`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/metrics/GatePerformance.test.tsx`

Add (or extend) a test that renders a `GateRow` open with `decisionConfidence.state === "measured"` and asserts the percentage line appears; and a second gate with `state === "insufficient"` asserting the number is NOT shown and the honest fallback IS.

```ts
it("shows the decision-confidence percentage only when measured", () => {
  const measured = { ...baseGate, decisionConfidence: { value: 0.82, sampleSize: 12, state: "measured" as const } };
  render(<GateRow gate={measured} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/82% of its approvals held up downstream/i)).toBeTruthy();
});

it("hides the number and shows an honest line when sample is insufficient", () => {
  const thin = { ...baseGate, decisionConfidence: { value: 0.9, sampleSize: 1, state: "insufficient" as const } };
  render(<GateRow gate={thin} index={0} isLast open onToggle={() => {}} />);
  expect(screen.queryByText(/90%/)).toBeNull();
  expect(screen.getByText(/Not enough decisions yet to tell whether its approvals hold up\./i)).toBeTruthy();
});
```

(Reuse or build a `baseGate` fixture from the existing test file's gate shape — it already renders `GateRow`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test GatePerformance`
Expected: FAIL — the decision-confidence line does not exist yet.

- [ ] **Step 3: Render gate decision-confidence** — `apps/desktop/src/metrics/GatePerformance.tsx`

In the `GateRow` open-drawer body, after the "Grounded in checks" section (line ~59), add:

```tsx
<SectionLabel>Do its approvals hold up?</SectionLabel>
<div style={{ fontSize: 12, color: "var(--text-2)" }}>
  {gate.decisionConfidence.state === "measured" && gate.decisionConfidence.value != null
    ? `${Math.round(gate.decisionConfidence.value * 100)}% of its approvals held up downstream (${gate.decisionConfidence.sampleSize} checked).`
    : "Not enough decisions yet to tell whether its approvals hold up."}
</div>
```

- [ ] **Step 4: Surface splitter confidence** — `apps/desktop/src/metrics/GatePerformance.tsx`, `FusedPipelinePanel`

The splitter branch currently renders a thin marker (line ~129-135). Look up the splitter's metrics from `detail?.splitters` and add a confidence sub-line honoring the measured-guard + the deterministic-attribution honesty:

```tsx
// Splitter: a marker showing where the flow branches, plus its routing confidence.
const branches = (node.branchesTo ?? []).map((id) => nameById.get(id) ?? id).join(" · ");
const sp = (detail?.splitters ?? []).find((x) => x.nodeId === node.nodeId);
const routeLine = sp
  ? (sp.confidence.state === "measured" && sp.confidence.value != null
      ? `${Math.round(sp.confidence.value * 100)}% of routes weren't walked back`
      : "not enough routes yet to rate")
  : null;
const creditLine = sp?.deterministic && sp.attributedToNodeId
  ? ` · routing decided by ${nameById.get(sp.attributedToNodeId) ?? sp.attributedToNodeId}`
  : "";
return (
  <div key={node.nodeId} className="mono" style={{ borderBottom: border, padding: "8px 14px", fontSize: 10.5, color: "var(--text-3)", background: "rgba(255,255,255,0.015)" }}>
    {node.name} — branches to {branches}
    {routeLine && <span style={{ color: "var(--text-4)" }}> · {routeLine}{creditLine}</span>}
  </div>
);
```

> **Note:** `attributedToNodeId` is a `stepTemplateId` (join key), which in the Adaptive graph equals the pipeline node id, so `nameById.get(...)` resolves it; the `?? id` fallback keeps it honest otherwise.

- [ ] **Step 5: Extend the no-jargon guard to gate/splitter copy** — add to `no-jargon.test.tsx` (or keep within `GatePerformance.test.tsx`) an assertion that the rendered gate drawer + splitter line contain none of `oracle|sensor|verdict|refute|veto`. (The new strings are jargon-free by construction; this locks it.)

```ts
it("gate + splitter confidence copy stays jargon-free", () => {
  const measured = { ...baseGate, decisionConfidence: { value: 0.82, sampleSize: 12, state: "measured" as const } };
  const { container } = render(<GateRow gate={measured} index={0} isLast open onToggle={() => {}} />);
  expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test GatePerformance`
Expected: PASS.

- [ ] **Step 7: Full desktop metrics + typecheck**

Run: `pnpm --filter @orca/desktop test src/metrics` then `pnpm --filter @orca/desktop tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/metrics/GatePerformance.tsx apps/desktop/src/metrics/GatePerformance.test.tsx apps/desktop/src/metrics/no-jargon.test.tsx
git commit -m "feat(metrics-ui): surface gate decisionConfidence + splitter confidence (value only when measured)"
```

---

## Final verification (whole-branch)

- [ ] `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test src/metrics && pnpm --filter @orca/desktop test src/metrics` — all green.
- [ ] Repo typecheck clean (contracts + daemon + desktop).
- [ ] No score assertion anywhere in the daemon suite changed (Phase 4 is display-only).
- [ ] Grep the metrics UI for the jargon set — zero rendered matches.
- [ ] Update `FUTURE_WORK.md` §5.6: mark Phase 4 landed; note the deferred remainder (computed-confidence attenuation + full propagation, guaranteed-verifier hard enforcement) still open.
