# Version-Aware Metrics A-i — Current-Shape Filtering (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the Metrics tab to the **current template shape** so a node that was refactored across versions (step→gate) or retired no longer double-counts — steps show only the current template's steps, gates show only the current template's gates.

**Architecture:** The metrics window pools runs across all template versions. `computeStepMetrics` builds its step list from the *data* (`stepTemplateId` seen in transitions), and `buildGateMetrics` groups all gate decisions by `nodeId`, so fossils (`validate_build`) and cross-era ids (`critique`/`verify` as steps, when they are now gates) leak in. This plan filters both to the **current node set** already loaded by `stepNames` (from `steps_json`) and `gateNodeNames` (from `graph_json`, `type === "gate"`). Recompute-on-read; no migration; no contract change.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`apps/daemon`).

**Design spec:** `docs/superpowers/specs/2026-07-19-metrics-health-console-design.md` (Phase A). **Scope note:** this is A-i (the filter). Change-markers (`⤳ was a step`), the per-node cross-version history strip, and the `Current shape / Latest only / All versions` toggles are **A-ii**, planned separately.

## Global Constraints

- **Current node set is the source of truth:** current steps = keys of `stepNames` (from `steps_json`); current gates = keys of `gateNodeNames`/the `names` map (from `graph_json`). A data id not in the current set is excluded from that panel.
- **Defensive fallback:** if the current-set map is **empty** (template row missing / `graph_json` absent), do **not** filter — fall back to today's behavior, so a template lacking metadata still shows its activity.
- No contract change; no scope UI (that is A-ii). This makes "current shape" the behavior, not yet a toggle.
- Recompute-on-read: no migration; retroactive and safe.
- Do not change scoring, bands, calibration, gate-health formula, or the gate→step join.

---

### Task 1: Filter the step list to the current template's steps

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`computeStepMetrics`, the `byStep` build ~:224-228)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Consumes: `input.stepNames: Map<string, {name; ordinal}>` (already passed; keys are the current template's step ids).
- Produces: `computeStepMetrics` returns only steps whose `stepTemplateId` is in `stepNames` (unless `stepNames` is empty).

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/metrics/aggregate.steps.test.ts` (reuse the file's existing transition/step-run builders — the passing-completion helper and `TemplateStepRun` shape already used throughout; vary only `stepTemplateId` and the `stepNames` map):

```ts
it("shows only the current template's steps — fossils and retyped/renamed ids drop out", () => {
  const at = "2026-05-01T00:00:00.000Z";
  // three step_complete transitions: one current step, one retired step, one that is now a gate (plain step-era id)
  const tx = (id: string, run: string) => ({
    templateVersion: 1, stepTemplateId: id,
    transition: { workflowRunId: run, boundary: "step_complete", createdAt: at,
      evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
      telemetry: { outcome: { status: "succeeded", failure_code: null } } } as never,
  });
  const run = (id: string, r: string): TemplateStepRun => ({ workflowRunId: r, stepTemplateId: id, attempt: 1, status: "passed", startedAt: at, finishedAt: at, blockedReason: null, templateVersion: 1 });
  const stepNames = new Map([["triage", { name: "Triage", ordinal: 0 }]]); // current template has ONE step

  const steps = computeStepMetrics({
    transitions: [tx("triage", "r1"), tx("validate_build", "r2"), tx("critique", "r3")],
    stepRuns: [run("triage", "r1"), run("validate_build", "r2"), run("critique", "r3")],
    stepNames, nowIso: "2026-05-08T00:00:00.000Z", period: "7d",
  });
  expect(steps.map((s) => s.stepTemplateId)).toEqual(["triage"]); // fossil + now-a-gate id excluded
});

it("falls back to showing all steps when the template's step set is unknown (empty stepNames)", () => {
  const at = "2026-05-01T00:00:00.000Z";
  const tx = (id: string, run: string) => ({
    templateVersion: 1, stepTemplateId: id,
    transition: { workflowRunId: run, boundary: "step_complete", createdAt: at,
      evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
      telemetry: { outcome: { status: "succeeded", failure_code: null } } } as never,
  });
  const run = (id: string, r: string): TemplateStepRun => ({ workflowRunId: r, stepTemplateId: id, attempt: 1, status: "passed", startedAt: at, finishedAt: at, blockedReason: null, templateVersion: 1 });
  const steps = computeStepMetrics({
    transitions: [tx("a", "r1"), tx("b", "r2")], stepRuns: [run("a", "r1"), run("b", "r2")],
    stepNames: new Map(), nowIso: "2026-05-08T00:00:00.000Z", period: "7d",
  });
  expect(steps.map((s) => s.stepTemplateId).sort()).toEqual(["a", "b"]); // no filtering when set is unknown
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- aggregate.steps`
Expected: the first test FAILS (fossil `validate_build` and `critique` currently appear as steps).

- [ ] **Step 3: Implement the filter**

In `apps/daemon/src/metrics/aggregate.ts`, in `computeStepMetrics`, the `byStep` build currently is:

```ts
  const byStep = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (!t.stepTemplateId) continue;
    if (t.stepTemplateId.startsWith("__gate__:")) continue;
    (byStep.get(t.stepTemplateId) ?? byStep.set(t.stepTemplateId, []).get(t.stepTemplateId)!).push(t);
  }
```

Add a current-set guard (place it right after the function's opening, before `byStep`):

```ts
  // Scope to the CURRENT template's steps: a step id not in stepNames is a fossil
  // from a retired version, or the step-era of a node that is now a gate — either way
  // it isn't part of today's pipeline. If the step set is unknown (empty), don't filter.
  const currentSteps = input.stepNames;
  const inCurrentShape = (id: string) => currentSteps.size === 0 || currentSteps.has(id);
```

Then add `if (!inCurrentShape(t.stepTemplateId)) continue;` inside the `byStep` loop (after the `__gate__:` skip), and the same guard inside the `runsByStep` loop:

```ts
  for (const t of input.transitions) {
    if (!t.stepTemplateId) continue;
    if (t.stepTemplateId.startsWith("__gate__:")) continue;
    if (!inCurrentShape(t.stepTemplateId)) continue;
    (byStep.get(t.stepTemplateId) ?? byStep.set(t.stepTemplateId, []).get(t.stepTemplateId)!).push(t);
  }
  const runsByStep = new Map<string, TemplateStepRun[]>();
  for (const r of input.stepRuns) {
    if (r.stepTemplateId.startsWith("__gate__:")) continue;
    if (!inCurrentShape(r.stepTemplateId)) continue;
    (runsByStep.get(r.stepTemplateId) ?? runsByStep.set(r.stepTemplateId, []).get(r.stepTemplateId)!).push(r);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- aggregate.steps` → both new tests PASS.

- [ ] **Step 5: Full daemon suite + typecheck; fix any fixture that used a non-current step id**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: green. If a pre-existing test builds a step whose `stepTemplateId` is **not** a key in the `stepNames` map it passes (relying on the old `{name, ordinal:999}` fallback), that step now filters out and the test breaks. Fix by adding that id to the test's `stepNames` map (making it "current") — a faithful adaptation, since the test's intent is that the id IS a current step. Note each such fixture in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "fix(metrics): scope step list to the current template's steps (drop fossils + retyped ids)"
```

---

### Task 2: Filter the gate list to the current template's gates

**Files:**
- Modify: `apps/daemon/src/metrics/gate-metrics.ts` (`buildGateMetrics`, the `byNode` build ~:26-27)
- Test: `apps/daemon/src/metrics/gate-metrics.test.ts`

**Interfaces:**
- Consumes: `input.names: Map<string, {name; evalSubstrate}>` (already passed; keys are the current template's gate node ids from `gateNodeNames`).
- Produces: `buildGateMetrics` returns only gates whose `nodeId` is in `names` (unless `names` is empty).

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/metrics/gate-metrics.test.ts` (reuse the file's `decision()` helper; the `names` map at the top currently is `new Map([["review", …]])`):

```ts
it("shows only the current template's gates — a decision for a retired gate node drops out", () => {
  const decisions = [
    decision({ id: "d1", nodeId: "review", workflowRunId: "r1", recommendedOutcome: null }),   // current gate
    decision({ id: "d2", nodeId: "designgate", workflowRunId: "r2", recommendedOutcome: null }), // retired gate — not in `names`
  ];
  const gates = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
  expect(gates.map((g) => g.nodeId)).toEqual(["review"]); // designgate excluded
});

it("falls back to showing all gates when the gate set is unknown (empty names)", () => {
  const decisions = [decision({ id: "d1", nodeId: "review", workflowRunId: "r1", recommendedOutcome: null })];
  const gates = buildGateMetrics({ decisions, transitions: [], names: new Map(), period: "7d" });
  expect(gates.map((g) => g.nodeId)).toEqual(["review"]); // no filtering when the set is unknown
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- gate-metrics` → the first new test FAILS (`designgate` currently appears).

- [ ] **Step 3: Implement the filter**

In `apps/daemon/src/metrics/gate-metrics.ts`, `buildGateMetrics` builds `byNode`:

```ts
  const byNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.decisions) (byNode.get(d.nodeId) ?? byNode.set(d.nodeId, []).get(d.nodeId)!).push(d);
```

Add the current-set guard:

```ts
  // Scope to the CURRENT template's gates: a node id not in `names` is a retired gate
  // from an older version. If the gate set is unknown (empty), don't filter.
  const currentGates = input.names;
  const byNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.decisions) {
    if (currentGates.size > 0 && !currentGates.has(d.nodeId)) continue;
    (byNode.get(d.nodeId) ?? byNode.set(d.nodeId, []).get(d.nodeId)!).push(d);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- gate-metrics` → both new tests PASS.

- [ ] **Step 5: Full daemon suite + typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: green. If a pre-existing gate test used a `nodeId` not in its `names` map, add it to `names` (faithful adaptation). Note it in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/gate-metrics.ts apps/daemon/src/metrics/gate-metrics.test.ts
git commit -m "fix(metrics): scope gate list to the current template's gates (drop retired gate nodes)"
```

---

### Task 3: Verify — full workspace, whole-branch review, live check

**Files:** none (verification only).

- [ ] **Step 1: Full-workspace deterministic verify**

Run: `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
Expected: all green (no contract/desktop change, so those are unaffected except via the shared build).

- [ ] **Step 2: Whole-branch review**

Dispatch a fresh reviewer over the phase diff (base = the commit before Task 1 .. HEAD). Verify: the filter keys off the current-set maps (`stepNames` / `names`), the empty-set fallback is present in both, the `__gate__:` skip and gate→step join are unchanged, no scoring/band/formula change, and no contract change. Feed the ledger's Minor list for triage.

- [ ] **Step 3: Live check (needs daemon restart — ask the user first)**

On **Adaptive Delivery** (Metrics tab): confirm the Step list now shows exactly the **6 current steps** (Triage, Clarify, Research, Proposal, Execution, Done) with **no** `critique`/`verify`/`validate_build`; and the Gates show exactly the current gates (Critique, Verify) with **no** `designgate`. The double-appearance you reported is gone. Capture a screenshot.

- [ ] **Step 4: Mark the phase complete in the ledger and note A-ii (change-markers + history strip + scope toggles) as the next plan.**

---

## Self-Review

**Spec coverage:** stable identity via the current node set + current-shape default (Task 1 steps, Task 2 gates); the fallback for unknown sets; live confirmation of no double-appearance (Task 3). Change-markers/history/toggles are explicitly deferred to A-ii (Global Constraints + Task 3 Step 4).

**Placeholder scan:** none — both tasks carry complete before/after code and concrete failing-first tests with exact expected arrays.

**Type consistency:** `inCurrentShape(id: string) → boolean` uses `stepNames: Map<string,…>`; the gate guard uses `input.names: Map<string,…>`. Both `.size`/`.has` calls match the existing map types. Test builders mirror the shapes already used in each test file (`TemplateStepRun`, `decision()`, the `as never` transition pattern).
