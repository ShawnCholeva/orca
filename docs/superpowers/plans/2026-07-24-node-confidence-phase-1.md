# Node Confidence Model — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make step scores honest — remove the `self_report` floor so "unchecked" reads as *unknown* not a fake 30, consume the discarded worker-gate approvals as evidence (read-time, no migration), and enforce that every step declares a verifier.

**Architecture:** Extend the existing metrics engine in place. Scoring stays **recompute-on-read** from `harness_transitions` (no migrations, retroactive-safe). `composedScore` gains an `established` flag (unknown ≠ a low score) and an optional `gateApproved` signal (an independent review, compounded via the existing `1−∏(1−cᵢ)` base). Gate→step linkage is resolved at read time from graph topology (the gate's predecessor step). A new `validateStepVerifiers` graph rule enforces the guaranteed-verifier invariant hard.

**Tech Stack:** TypeScript, Zod contracts (`@orca/contracts`), Vitest (`vitest run`). Daemon package `@orca/daemon`.

## Global Constraints

- **Recompute-on-read; NO database migrations.** Everything derives from persisted `harness_transitions` + `workflow_gate_decisions` at read time. Formula changes must be retroactive-safe.
- **CRUX:** never calibrate a source against the `refute` signal (circular). Phase 1 keeps **designed priors** (`SOURCE_CONFIDENCE`), unchanged. No calibration-formula changes here (that is Phase 2).
- **Score shape unchanged:** `base = 1 − ∏(1−cᵢ)` over independent passing verifiers, `score = base × coverage`. Phase 1 removes the `self_report` floor as a *value* and adds gate-approval as an independent-review `cᵢ`.
- **`self_report` stays a designed prior conceptually, but is never a scored value** — a completion with no passing verifier is **unknown** (excluded from the mean), not `0.3`.
- **Unknown ≠ zero.** Unknown completions are excluded from the score mean; a real `0` (refuted / evidence-failed) still counts.
- **No-jargon:** any user-facing string added must avoid `oracle | sensor | verdict | refute | veto` (enforced by `no-jargon.test.tsx`). Phase 1 adds no user-facing copy.
- **Deterministic core:** all of this is deterministic TypeScript over facets; no LLM calls.
- **Test runner:** `pnpm --filter @orca/daemon test -- <path>` (or `npx vitest run <path>` from `apps/daemon`). Test files are `.test.ts` co-located next to source.

---

## File Structure

- `apps/daemon/src/metrics/composed-score.ts` — MODIFY: add `established`; add `gateApproved` opt; compound gate-approval as independent review.
- `apps/daemon/src/metrics/composed-score.test.ts` — MODIFY: update floor test → unknown; add gate-approval cases.
- `apps/daemon/src/metrics/gate-review.ts` — CREATE: pure `gateApprovalsByStep(graph, gateDecisions)` resolver.
- `apps/daemon/src/metrics/gate-review.test.ts` — CREATE.
- `apps/daemon/src/metrics/aggregate.ts` — MODIFY: filter the score mean by `established`; thread `gateApproved` into the per-completion `composedScore` call.
- `apps/daemon/src/metrics/aggregate.steps.test.ts` — MODIFY: update floor expectations → unknown; add gate-approval integration test.
- `apps/daemon/src/metrics/usecases.ts` — MODIFY: load gate decisions + graph, build the per-completion gate-approval lookup, pass into `computeStepMetrics`.
- `apps/daemon/src/metrics/fetch.ts` — MODIFY (if needed): expose gate decisions to the usecase (a reader already exists: `listGateDecisionsByTemplate`).
- `apps/daemon/src/workflows/graph/validate-graph.ts` — MODIFY: add `validateStepVerifiers(graph, steps, guardrails)`.
- `apps/daemon/src/workflows/graph/validate-graph.test.ts` — MODIFY: add invariant cases.
- Template-validation call site (locate via grep) — MODIFY: call `validateStepVerifiers` alongside `validateGraph`.

---

## Task 1: `composedScore` — unknown state (remove the `self_report` floor)

**Files:**
- Modify: `apps/daemon/src/metrics/composed-score.ts`
- Test: `apps/daemon/src/metrics/composed-score.test.ts`

**Interfaces:**
- Produces: `CompletionScore` gains `established: boolean`. Unknown (no passing verifier, not refuted/failed) → `{ established: false, score: 0, base: 0, coverage: 0, verifiers: {all false} }`. Every other outcome → `established: true`.

- [ ] **Step 1: Write the failing tests** — append to `composed-score.test.ts`:

```ts
describe("composedScore — unknown state", () => {
  it("no passing verifier, not refuted → unknown (established:false)", () => {
    // bare evidence: no sensors, no grounding, no refute
    const r = composedScore(tx({ evidence: ev({}) }));
    expect(r.established).toBe(false);
    expect(r.base).toBe(0);
  });
  it("no evidence and no refute → unknown (established:false)", () => {
    const r = composedScore(tx({}));
    expect(r.established).toBe(false);
  });
  it("refuted is a real zero, still established", () => {
    const r = composedScore(tx({ refute: { verdict: "refuted" } }));
    expect(r.established).toBe(true);
    expect(r.score).toBe(0);
  });
  it("grounding pass is established at 0.70", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: groundingPassed }) }));
    expect(r.established).toBe(true);
    expect(r.score).toBeCloseTo(0.7, 5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics/composed-score.test.ts` (from `apps/daemon`)
Expected: FAIL — `established` is `undefined` on the returned object.

- [ ] **Step 3: Implement** — edit `composed-score.ts`. Change the type and the `cs.length === 0` branch:

```ts
export type CompletionScore = {
  established: boolean;
  score: number; base: number; coverage: number;
  verifiers: { executable: boolean; grounding: boolean; independentReview: boolean };
};

export function composedScore(t: TemplateTransition, calibration?: CalibrationEntry[]): CompletionScore {
  const ev = t.transition.evidence;
  const rf = t.transition.refute;
  const zero = (): CompletionScore => ({ established: true, score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  const unknown = (): CompletionScore => ({ established: false, score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  if (rf?.verdict === "refuted") return zero();
  if (ev?.verdict === "failed") return zero();

  const { executable, grounding, independentReview } = sourcesPassed(ev, rf);
  const cs: number[] = [];
  if (executable) cs.push(effectiveSourceConfidence("executable", calibration));
  if (grounding) cs.push(effectiveSourceConfidence("grounding", calibration));
  if (independentReview) cs.push(SOURCE_CONFIDENCE.independent_review);
  if (cs.length === 0) return unknown(); // no passing verifier, not refuted/failed → unknown, excluded from the mean
  const base = 1 - cs.reduce((p, c) => p * (1 - c), 1);

  const coverage = computeCoverage(t, ev);
  return { established: true, score: base * coverage, base, coverage, verifiers: { executable, grounding, independentReview } };
}
```

- [ ] **Step 4: Update the stale floor test.** Find the existing self-report-floor case in `composed-score.test.ts` (asserts `.score` ≈ `0.3`). It encodes the removed floor. Replace its assertion with `expect(r.established).toBe(false)` (delete the `0.3` expectation).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/metrics/composed-score.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/composed-score.ts apps/daemon/src/metrics/composed-score.test.ts
git commit -m "feat(metrics): composedScore unknown state — drop the self_report floor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `aggregate` — exclude unknown completions from the score mean & band

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts` (the `scoreOver` / `conclusive` region, ~319–348 and ~502)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Consumes: `CompletionScore.established` from Task 1.
- Produces: a step whose completions are all unknown → `score: null`, `verification.band.level: "needs_evidence"`.

**Background:** today `conclusive` and `scoreOver`'s `conc` filter on `tierByCompletion.get(t) !== "unverified"`. That still admits self-report/bare completions (tier `self_reported`/`ai_reviewed`) which then contribute `0.3` via `composedScore`. Switching the filter to `established` drops exactly those, and keeps refuted zeros (established) — implementing the unknown state end-to-end.

- [ ] **Step 1: Write the failing test** — add to `aggregate.steps.test.ts` (follow its existing `stepComplete(...)` / `computeStepMetrics(...)` fixture pattern):

```ts
it("a step with only self-reported completions scores unknown (null / needs_evidence)", () => {
  // Two step_complete transitions with NO sensors, NO grounding, NO refute.
  const txs = [
    stepComplete("s1", "run1", "mystep", 1),
    stepComplete("s1", "run2", "mystep", 1),
  ];
  const runs = [stepRun("run1", "mystep", 1, "completed", 1), stepRun("run2", "mystep", 1, "completed", 1)];
  const steps = computeStepMetrics({ /* build the same input shape the file already uses */ transitions: txs, stepRuns: runs, /* ...calibration:[], etc. */ } as never);
  const mystep = steps.find((s) => s.stepTemplateId === "mystep")!;
  expect(mystep.score).toBeNull();
  expect(mystep.verification.band.level).toBe("needs_evidence");
});
```

> Note: match the exact `computeStepMetrics` input object the existing tests in this file construct — copy a passing test's setup and strip the evidence/refute so the completions are bare. Do not invent input fields.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics/aggregate.steps.test.ts`
Expected: FAIL — `score` is a low number (~30) and band is `weak`, not `null`/`needs_evidence` (the old floor).

- [ ] **Step 3: Implement** — in `aggregate.ts`, change the two `tierByCompletion.get(t) !== "unverified"` filters to `established`. There are two occurrences: inside `scoreOver` (~321) and the `conclusive` definition (~326).

`conclusive` (~326):
```ts
    const conclusive = finalStepCompletes.filter((t) =>
      scoreByCompletion.get(t)!.established && !supersededByHardFail.has(t.transition.workflowRunId ?? ""));
```

`scoreOver` (~340), its inner `conc`:
```ts
    const scoreOver = (completes: typeof finalStepCompletes, hardFails: number): { n: number; value: number | null } => {
      const conc = completes.filter((t) =>
        scoreByCompletion.get(t)!.established && !supersededByHardFail.has(t.transition.workflowRunId ?? ""));
      const n = conc.length + hardFails;
      return n === 0 ? { n, value: null } : { n, value: conc.reduce((acc, t) => acc + contribution(t), 0) / n };
    };
```

(Leave `concScores = conclusive.map(...).filter((s) => s.base !== 0)` as-is — unknown completions have `base === 0` and are already excluded there; refuted zeros likewise, matching current band behavior.)

- [ ] **Step 4: Fix stale floor expectations across the metrics tests.** Run the whole metrics suite and update any test that asserted a low score / `weak` band for a self-report-only step to expect `null` / `needs_evidence`:

Run: `npx vitest run src/metrics`
Expected initially: FAIL on pre-existing floor-encoding tests. Update each to the unknown-state expectation (these are deliberate behavior changes per spec T2). Do **not** weaken tests that assert real scores from real verifiers.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/metrics`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts apps/daemon/src/metrics/*.test.ts
git commit -m "feat(metrics): exclude unknown completions from the score mean

Self-report-only steps now read needs_evidence, not a floored ~30.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `gate-review` — resolve the reviewed step from graph topology

**Files:**
- Create: `apps/daemon/src/metrics/gate-review.ts`
- Test: `apps/daemon/src/metrics/gate-review.test.ts`

**Interfaces:**
- Produces:
```ts
// Which runs had the gate that reviews a given STEP node approve it.
// Key: reviewed step node id. Value: set of workflowRunIds where that step's gate approved.
export function gateApprovalsByStep(
  graph: WorkflowGraph,
  gateDecisions: { nodeId: string; outcome: "approved" | "rejected"; workflowRunId: string }[],
): Map<string, Set<string>>;
```
The reviewed step for a gate node = the `step`-type node with an edge `step -> gate`.

- [ ] **Step 1: Write the failing test** — `gate-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { gateApprovalsByStep } from "./gate-review.js";

const graph: WorkflowGraph = {
  nodes: [
    { id: "proposal", type: "step", name: "Proposal", stepId: "proposal" },
    { id: "critique", type: "gate", name: "Critique", instructions: "x" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution", terminal: true },
  ],
  edges: [
    { from: "proposal", to: "critique" },
    { from: "critique", to: "execution", port: "approved" },
    { from: "critique", to: "proposal", port: "rejected" },
  ],
  positions: {},
} as never;

describe("gateApprovalsByStep", () => {
  it("maps an approved gate decision to its predecessor step + run", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "critique", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.get("proposal")?.has("r1")).toBe(true);
  });
  it("ignores rejected decisions", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "critique", outcome: "rejected", workflowRunId: "r1" }]);
    expect(m.get("proposal")?.has("r1") ?? false).toBe(false);
  });
  it("ignores a gate with no step predecessor", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "unknown_gate", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics/gate-review.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `gate-review.ts`:

```ts
import type { WorkflowGraph } from "@orca/contracts";

export function gateApprovalsByStep(
  graph: WorkflowGraph,
  gateDecisions: { nodeId: string; outcome: "approved" | "rejected"; workflowRunId: string }[],
): Map<string, Set<string>> {
  // gate node id -> reviewed step node id (the step whose edge feeds the gate)
  const reviewedStepOf = new Map<string, string>();
  const stepNodeIds = new Set(graph.nodes.filter((n) => n.type === "step").map((n) => n.id));
  for (const n of graph.nodes) {
    if (n.type !== "gate") continue;
    const pred = graph.edges.find((e) => e.to === n.id && stepNodeIds.has(e.from));
    if (pred) reviewedStepOf.set(n.id, pred.from);
  }
  const out = new Map<string, Set<string>>();
  for (const d of gateDecisions) {
    if (d.outcome !== "approved") continue;
    const stepNode = reviewedStepOf.get(d.nodeId);
    if (!stepNode) continue;
    (out.get(stepNode) ?? out.set(stepNode, new Set()).get(stepNode)!).add(d.workflowRunId);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/metrics/gate-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/gate-review.ts apps/daemon/src/metrics/gate-review.test.ts
git commit -m "feat(metrics): resolve gate-reviewed step from graph topology

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `composedScore` — accept `gateApproved`, compound as independent review

**Files:**
- Modify: `apps/daemon/src/metrics/composed-score.ts`
- Test: `apps/daemon/src/metrics/composed-score.test.ts`

**Interfaces:**
- Produces: `composedScore(t, calibration?, opts?: { gateApproved?: boolean })`. When `gateApproved`, push another `SOURCE_CONFIDENCE.independent_review` into `cs` and set `verifiers.independentReview = true`. This also flips a would-be-unknown completion to **established** — the core bug fix.

> **DESIGN NOTE (flagged for review):** a worker-gate approval and a refute-upheld are two independent reviews, so the `1−∏(1−cᵢ)` base compounds them (0.55 + 0.55 → ≈0.7975). Gate-approved-only → 0.55. This is deliberate; veto at review if you'd rather cap at a single review.

- [ ] **Step 1: Write the failing tests** — add to `composed-score.test.ts`:

```ts
describe("composedScore — gate approval as evidence", () => {
  it("gate-approved, otherwise self-report → established 0.55", () => {
    const r = composedScore(tx({}), undefined, { gateApproved: true });
    expect(r.established).toBe(true);
    expect(r.verifiers.independentReview).toBe(true);
    expect(r.score).toBeCloseTo(0.55, 5);
  });
  it("gate-approved + refute-upheld compound to ~0.7975", () => {
    const r = composedScore(tx({ refute: { verdict: "upheld" } }), undefined, { gateApproved: true });
    expect(r.score).toBeCloseTo(0.7975, 4);
  });
  it("no gate approval → unchanged unknown", () => {
    const r = composedScore(tx({}), undefined, { gateApproved: false });
    expect(r.established).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics/composed-score.test.ts`
Expected: FAIL — third arg ignored; gate-approved returns unknown.

- [ ] **Step 3: Implement** — edit `composed-score.ts` signature + `cs` build:

```ts
export function composedScore(
  t: TemplateTransition,
  calibration?: CalibrationEntry[],
  opts?: { gateApproved?: boolean },
): CompletionScore {
  const ev = t.transition.evidence;
  const rf = t.transition.refute;
  const zero = (): CompletionScore => ({ established: true, score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  const unknown = (): CompletionScore => ({ established: false, score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  if (rf?.verdict === "refuted") return zero();
  if (ev?.verdict === "failed") return zero();

  const sp = sourcesPassed(ev, rf);
  const gateApproved = opts?.gateApproved === true;
  const independentReview = sp.independentReview || gateApproved;
  const cs: number[] = [];
  if (sp.executable) cs.push(effectiveSourceConfidence("executable", calibration));
  if (sp.grounding) cs.push(effectiveSourceConfidence("grounding", calibration));
  if (sp.independentReview) cs.push(SOURCE_CONFIDENCE.independent_review);
  if (gateApproved) cs.push(SOURCE_CONFIDENCE.independent_review); // second independent review — compounds
  if (cs.length === 0) return unknown();
  const base = 1 - cs.reduce((p, c) => p * (1 - c), 1);

  const coverage = computeCoverage(t, ev);
  return { established: true, score: base * coverage, base, coverage, verifiers: { executable: sp.executable, grounding: sp.grounding, independentReview } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/metrics/composed-score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/composed-score.ts apps/daemon/src/metrics/composed-score.test.ts
git commit -m "feat(metrics): composedScore consumes gate approval as independent review

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire gate approvals into `aggregate` / `computeStepMetrics`

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts` (the `composedScore(t, input.calibration)` call ~330; `computeStepMetrics` input type ~215)
- Modify: `apps/daemon/src/metrics/usecases.ts` (`getTemplateMetricsDetail` ~99, the `computeStepMetrics(...)` call ~129)
- Modify (read path): use existing `listGateDecisionsByTemplate` (`apps/daemon/src/metrics/fetch.ts:94-117`)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Consumes: `gateApprovalsByStep` (Task 3), `CompletionScore` established/gateApproved (Tasks 1,4).
- Produces: `computeStepMetrics` input gains `gateApprovedByCompletion?: (t: TemplateTransition) => boolean` (or an equivalent `Map`). A step reviewed by an approving gate scores as independent-review, not unknown.

- [ ] **Step 1: Write the failing integration test** — `aggregate.steps.test.ts`:

```ts
it("a self-reported step reviewed by an APPROVING gate scores ~55, not unknown", () => {
  const txs = [stepComplete("s1", "run1", "proposal", 1)]; // bare completion
  const runs = [stepRun("run1", "proposal", 1, "completed", 1)];
  const gateApprovedByCompletion = (t: TemplateTransition) =>
    t.stepTemplateId === "proposal" && t.transition.workflowRunId === "run1";
  const steps = computeStepMetrics({ /* same input shape */ transitions: txs, stepRuns: runs, gateApprovedByCompletion } as never);
  const proposal = steps.find((s) => s.stepTemplateId === "proposal")!;
  expect(proposal.score).toBe(55);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics/aggregate.steps.test.ts`
Expected: FAIL — `score` is `null` (input field ignored; completion still unknown).

- [ ] **Step 3: Implement in `aggregate.ts`.** Add `gateApprovedByCompletion?: (t: TemplateTransition) => boolean` to the `computeStepMetrics` input type (~215). At the per-completion score map (~330), pass the signal:

```ts
    const scoreByCompletion = new Map(
      finalStepCompletes.map((t) =>
        [t, composedScore(t, input.calibration, { gateApproved: input.gateApprovedByCompletion?.(t) ?? false })] as const)
    );
```

- [ ] **Step 4: Run the aggregate test to verify pass**

Run: `npx vitest run src/metrics/aggregate.steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Plumb the real signal in `usecases.ts`.** In `getTemplateMetricsDetail`:
  1. Load gate decisions for the window: `const gateDecisions = listGateDecisionsByTemplate(db, templateId, sinceIso, untilIso);` (confirm the exact param names against `fetch.ts:94-117`).
  2. Get the template graph already loaded there (the current-shape `WorkflowGraph`); if not loaded, load it from the template record.
  3. `const approvals = gateApprovalsByStep(graph, gateDecisions.map((d) => ({ nodeId: d.nodeId, outcome: d.outcome, workflowRunId: d.workflowRunId })));`
  4. Build the predicate keyed by the **reviewed step's node id** and run id. The step transition's `stepTemplateId` is the step template id; map it to its graph node id (in the Adaptive graph these are equal, e.g. `proposal`). Pass:

```ts
    const gateApprovedByCompletion = (t: TemplateTransition) => {
      const runId = t.transition.workflowRunId;
      const stepNodeId = t.stepTemplateId; // step node id == step template id in these graphs
      return runId != null && stepNodeId != null && (approvals.get(stepNodeId)?.has(runId) ?? false);
    };
```
  5. Pass `gateApprovedByCompletion` into the `computeStepMetrics({ ... })` call (~129).

> If `stepTemplateId` and the graph node id can diverge, build a `stepId -> nodeId` map from `graph.nodes` (`n.type === "step"` → `n.stepId ?? n.id` maps to `n.id`) and translate. In the Adaptive catalog they are identical, so the direct form above is correct there; add the map only if a template is found where they differ.

- [ ] **Step 6: Verify the whole metrics suite + typecheck**

Run: `npx vitest run src/metrics` then `pnpm --filter @orca/daemon typecheck` (or `npx tsc --noEmit` in `apps/daemon`)
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "feat(metrics): score gate-approved steps as independent-review evidence

Stops discarding worker-gate approvals; gate-approved steps stop reading unknown.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Guaranteed-verifier invariant — `validateStepVerifiers` (hard)

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts`
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts`
- Modify: the template-validation call site (locate via `grep -rn "validateGraph(" apps/daemon/src`)

**Interfaces:**
- Produces:
```ts
export function validateStepVerifiers(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[],
  guardrails: WorkflowGuardrailConfig[],
): string[];
```
A step node is valid iff **any**: (a) ≥1 grounding check with `mode === "enforce"`; (b) a `validation_rule` guardrail's `appliesToSteps` includes its step id; (c) its outgoing edge leads to a `gate` node; (d) `completionPolicy ∈ {"interview","handoff"}`; (e) the node is `terminal` (human-authoritative `mark_done`). Otherwise: `errors.push("step '<id>' has no verifier: needs enforce grounding, a validation_rule, a gate, an interview/handoff policy, or terminal")`.

- [ ] **Step 1: Write the failing tests** — add to `validate-graph.test.ts` (reuse its `step(id, ordinal)` factory + `WorkflowGraph` literal pattern):

```ts
import { validateStepVerifiers } from "./validate-graph.js";
import type { WorkflowGuardrailConfig } from "@orca/contracts";

describe("validateStepVerifiers", () => {
  const g: WorkflowGraph = {
    nodes: [
      { id: "reason", type: "step", name: "Reason", stepId: "reason" },
      { id: "gate", type: "gate", name: "Gate", instructions: "x" },
      { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
    ],
    edges: [{ from: "reason", to: "gate" }, { from: "gate", to: "done", port: "approved" }, { from: "gate", to: "reason", port: "rejected" }],
    positions: {},
  } as never;

  it("passes: gate successor + terminal", () => {
    const steps = [step("reason", 0), step("done", 1)];
    expect(validateStepVerifiers(g, steps, [])).toEqual([]);
  });

  it("fails a bare reasoning step with no verifier", () => {
    const bare: WorkflowGraph = {
      nodes: [{ id: "reason", type: "step", name: "Reason", stepId: "reason" }, { id: "done", type: "step", name: "Done", stepId: "done", terminal: true }],
      edges: [{ from: "reason", to: "done" }],
      positions: {},
    } as never;
    const steps = [step("reason", 0), step("done", 1)];
    expect(validateStepVerifiers(bare, steps, [])).toContain(
      "step 'reason' has no verifier: needs enforce grounding, a validation_rule, a gate, an interview/handoff policy, or terminal"
    );
  });

  it("passes a bare step covered by a validation_rule guardrail", () => {
    const bare: WorkflowGraph = {
      nodes: [{ id: "reason", type: "step", name: "Reason", stepId: "reason" }, { id: "done", type: "step", name: "Done", stepId: "done", terminal: true }],
      edges: [{ from: "reason", to: "done" }],
      positions: {},
    } as never;
    const steps = [step("reason", 0), step("done", 1)];
    const guardrails = [{ id: "v", kind: "validation_rule", label: "v", configJson: { appliesToSteps: ["reason"], required: ["unit_tests"] } }] as WorkflowGuardrailConfig[];
    expect(validateStepVerifiers(bare, steps, guardrails)).toEqual([]);
  });

  it("passes a step with an enforce grounding check", () => {
    const bare: WorkflowGraph = {
      nodes: [{ id: "reason", type: "step", name: "Reason", stepId: "reason" }, { id: "done", type: "step", name: "Done", stepId: "done", terminal: true }],
      edges: [{ from: "reason", to: "done" }],
      positions: {},
    } as never;
    const grounded = { ...step("reason", 0), grounding: [{ rule: "paths_exist", field: "f", mode: "enforce" }] } as never;
    expect(validateStepVerifiers(bare, [grounded, step("done", 1)], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/workflows/graph/validate-graph.test.ts`
Expected: FAIL — `validateStepVerifiers` is not exported.

- [ ] **Step 3: Implement** — add to `validate-graph.ts`:

```ts
import { stepRequiresExecution } from "../orchestrator/requires-execution.js";
// (WorkflowGuardrailConfig type import from "@orca/contracts")

export function validateStepVerifiers(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[],
  guardrails: WorkflowGuardrailConfig[],
): string[] {
  const errors: string[] = [];
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const gateNodeIds = new Set(graph.nodes.filter((n) => n.type === "gate").map((n) => n.id));
  for (const node of graph.nodes) {
    if (node.type !== "step") continue;
    const templateId = node.stepId ?? node.id;
    const tpl = stepById.get(templateId);
    const enforceGrounding = (tpl?.grounding ?? []).some((g) => (g as { mode?: string }).mode === "enforce");
    const hasSensors = stepRequiresExecution(guardrails, templateId) != null;
    const gateSuccessor = graph.edges.some((e) => e.from === node.id && gateNodeIds.has(e.to));
    const humanPolicy = tpl?.completionPolicy === "interview" || tpl?.completionPolicy === "handoff";
    const terminal = node.terminal === true;
    if (!(enforceGrounding || hasSensors || gateSuccessor || humanPolicy || terminal)) {
      errors.push(
        `step '${node.id}' has no verifier: needs enforce grounding, a validation_rule, a gate, an interview/handoff policy, or terminal`
      );
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/workflows/graph/validate-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Add an Adaptive-catalog regression test.** Add a test that loads the real Adaptive template and asserts it passes (no verifier-less steps):

```ts
// In a test with access to the Adaptive template (import the catalog builder used elsewhere in the repo;
// grep: `grep -rn "adaptive-delivery" apps/daemon/src` to find the catalog export/builder).
it("the Adaptive Delivery template satisfies the verifier invariant", () => {
  const tpl = /* build/import the orca/adaptive-delivery WorkflowTemplate */;
  expect(validateStepVerifiers(tpl.graph, tpl.steps, tpl.guardrails)).toEqual([]);
});
```

Run: `npx vitest run src/workflows/graph/validate-graph.test.ts`
Expected: PASS (audit confirmed all six steps are covered).

- [ ] **Step 6: Wire the invariant at the template-validation call site (HARD).**

Run: `grep -rn "validateGraph(" apps/daemon/src` to find where templates are validated on create/update. At that site (which has the template's `graph`, `steps`, and `guardrails`), append the invariant to the existing error handling:

```ts
const errors = [...validateGraph(graph, steps, opts), ...validateStepVerifiers(graph, steps, guardrails)];
// (feed `errors` into the same rejection path validateGraph's result already uses)
```

If the call site currently throws on a non-empty `validateGraph` result, route `validateStepVerifiers` through the identical throw so a verifier-less template is rejected hard.

- [ ] **Step 7: Verify the workflows suite + full daemon typecheck**

Run: `npx vitest run src/workflows` then `npx tsc --noEmit` (in `apps/daemon`)
Expected: PASS — including any existing template-registration tests (the Adaptive catalog passes the new rule).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts <call-site-file>
git commit -m "feat(workflows): enforce guaranteed-verifier invariant on step templates

Every step must declare a verifier (enforce grounding, validation_rule, gate,
interview/handoff policy, or terminal); a verifier-less workflow is rejected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full daemon suite: `pnpm --filter @orca/daemon test` → all pass.
- [ ] `npx tsc --noEmit` in `apps/daemon` → no type errors.
- [ ] Manual sanity (browser, optional): a gate-approved reasoning step (e.g. Proposal) on the Metrics tab now shows a real score (~55+), and a genuinely unchecked step shows "Not checked yet" rather than a floored ~30.

## Self-review checklist (done)

- **Spec coverage:** floor→unknown (T2) = Tasks 1–2; discarded gate evidence (§1 finding, wired read-time no-migration) = Tasks 3–5; guaranteed-verifier invariant hard (T2) = Task 6; uncertainty scaffolding = the honest `scoredSampleSize`/`null`-score surfaced by Tasks 1–2 (Beta posterior deferred to Phase 2, per spec). Retrospective vindication, attenuation, calibration, drawer vocabulary = **out of scope (Phases 2–4)**.
- **Not in Phase 1 (guardrail):** no `Beta`/calibration math, no retrospective vindication, no attenuation, no drawer copy — do not implement these here.
- **Type consistency:** `CompletionScore.established` (Task 1) is consumed by `aggregate` (Task 2) and produced with `gateApproved` (Task 4); `gateApprovalsByStep` (Task 3) feeds `gateApprovedByCompletion` (Task 5); `validateStepVerifiers` signature identical across Task 6 steps.
- **Design decision flagged for review:** gate-approval compounding with refute (Task 4 note).
