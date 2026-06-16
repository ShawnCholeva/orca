# Workflow Terminal-Step Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every Orca workflow ends in a dedicated terminal step and every branch reaches a terminal — enforced as a hard error on create/update — and give all built-ins explicit graphs with terminal Done steps.

**Architecture:** Replace the graph validator's "exactly one terminal" rule with "≥1 terminal AND every reachable node can reach a terminal" (fan-out-ready). Run that validator on the *effective* graph for every template create/update. Author explicit graphs for the 5 linear built-ins (adding Done steps to the 3 lacking one) and bump their versions. Default a terminal in the desktop graph materialization so UI-authored workflows are valid by default.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Zod, Vitest; React desktop app. Monorepo run via `pnpm`.

**Spec:** `docs/superpowers/specs/2026-06-15-workflow-terminal-step-coverage-design.md`

---

### Task 1: Terminal validation — ≥1 terminal + terminal-reachability

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts:30-34` (terminal count rule) and `:72-92` (reachability block)
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts`

- [ ] **Step 1: Update the failing-message test and add new cases**

In `validate-graph.test.ts`, change the existing assertion (line 43) from the old message to the new one:

```ts
  it("rejects when there is no terminal step", () => {
    const g = { ...valid, nodes: valid.nodes.map((n) => (n.id === "done" ? { ...n, terminal: false } : n)) };
    expect(validateGraph(g, steps)).toContain("at least one terminal step is required (found 0)");
  });
```

Add these two tests inside the `describe("validateGraph", ...)` block:

```ts
  it("accepts multiple terminal steps (one per branch)", () => {
    const s = [step("a", 0), step("done1", 1), step("done2", 2)];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "gate", type: "gate", name: "Gate", instructions: "x" },
        { id: "done1", type: "step", name: "Done1", stepId: "done1", terminal: true },
        { id: "done2", type: "step", name: "Done2", stepId: "done2", terminal: true },
      ],
      edges: [
        { from: "a", to: "gate" },
        { from: "gate", to: "done1", port: "approved" },
        { from: "gate", to: "done2", port: "rejected" },
      ],
      positions: {},
    };
    expect(validateGraph(g, s)).toEqual([]);
  });

  it("rejects a branch that never reaches a terminal", () => {
    const s = [step("a", 0), step("done", 1), step("x", 2), step("y", 3)];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "gate", type: "gate", name: "Gate", instructions: "x" },
        { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
        { id: "x", type: "step", name: "X", stepId: "x" },
        { id: "y", type: "step", name: "Y", stepId: "y" },
      ],
      edges: [
        { from: "a", to: "gate" },
        { from: "gate", to: "done", port: "approved" },
        { from: "gate", to: "x", port: "rejected" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ],
      positions: {},
    };
    const errs = validateGraph(g, s);
    expect(errs).toContain("branch from 'x' never reaches a terminal step");
    expect(errs).toContain("branch from 'y' never reaches a terminal step");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- validate-graph`
Expected: FAIL — the new-message test fails (still emits "exactly one…"), `accepts multiple terminal steps` fails (old rule rejects 2 terminals), `rejects a branch…` fails (message not produced yet).

- [ ] **Step 3: Relax the terminal-count rule**

In `validate-graph.ts`, replace lines 30-34:

```ts
  // Terminal: at least one terminal step node.
  const terminals = graph.nodes.filter((n) => n.type === "step" && n.terminal);
  if (terminals.length < 1) {
    errors.push(`at least one terminal step is required (found ${terminals.length})`);
  }
```

- [ ] **Step 4: Add terminal-reachability inside the reachability block**

In `validate-graph.ts`, the `else` branch (currently lines 75-92) computes the forward-`reachable` set and reports unreachable nodes. Append the terminal-reachability check at the end of that `else` block, immediately before its closing `}` (after the existing `for (const node of graph.nodes) { if (!reachable.has(node.id)) … }` loop):

```ts
    // Terminal-reachability: every reachable node must have a path to a terminal.
    // Branch-source-agnostic — covers gate ports and (future) step fan-out alike.
    if (terminals.length >= 1) {
      const reverse = new Map<string, string[]>();
      for (const e of graph.edges) {
        const preds = reverse.get(e.to) ?? [];
        preds.push(e.from);
        reverse.set(e.to, preds);
      }
      const canReachTerminal = new Set<string>(terminals.map((t) => t.id));
      const tq = [...canReachTerminal];
      while (tq.length) {
        const id = tq.shift()!;
        for (const pred of reverse.get(id) ?? []) {
          if (!canReachTerminal.has(pred)) {
            canReachTerminal.add(pred);
            tq.push(pred);
          }
        }
      }
      for (const node of graph.nodes) {
        if (reachable.has(node.id) && !canReachTerminal.has(node.id)) {
          errors.push(`branch from '${node.id}' never reaches a terminal step`);
        }
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- validate-graph`
Expected: PASS (all cases, including the unchanged structural ones).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts
git commit -m "feat(workflows): require ≥1 terminal and terminal-reachability in graph validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Validate the effective graph on every template create/update

**Files:**
- Modify: `apps/daemon/src/workflows/templates/routes.ts:29` (import), `:101-111` (POST), `:127-137` (PATCH)
- Test: `apps/daemon/src/workflows/templates/routes.test.ts`

- [ ] **Step 1: Write failing tests for graph-null enforcement**

Add these two tests inside `describe("workflow template routes", ...)` in `routes.test.ts` (they reuse the existing `server`, `AUTH_HEADERS`, and payload style from the file):

```ts
  it("graph-null create materializes a terminal and succeeds", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/workflow-templates",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "Linear NoGraph",
        description: "desc",
        steps: [
          { id: "a", name: "A", instructions: "do a",
            outputSchema: [{ key: "s", type: "string", required: true }],
            agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
          { id: "b", name: "B", instructions: "do b",
            outputSchema: [{ key: "t", type: "string", required: true }],
            agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
        ],
        guardrails: [],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a graph whose only branch never reaches a terminal", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/workflow-templates",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "Dangling",
        description: "desc",
        steps: [
          { id: "a", name: "A", instructions: "do a",
            outputSchema: [{ key: "s", type: "string", required: true }],
            agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
          { id: "b", name: "B", instructions: "do b",
            outputSchema: [{ key: "t", type: "string", required: true }],
            agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
        ],
        guardrails: [],
        graph: {
          nodes: [
            { id: "a", type: "step", name: "A", stepId: "a" },
            { id: "b", type: "step", name: "B", stepId: "b" },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
          positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 92 } },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_graph");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- routes`
Expected: FAIL — `graph-null create…` currently passes validation but the second test fails because today no validation runs when `graph` is absent, and the cyclic graph with two terminals=0 must be rejected. (The first test should already pass; it guards against a regression where materialized graph-null is wrongly rejected.)

- [ ] **Step 3: Import `effectiveGraph`**

In `routes.ts`, add to the existing import from the graph module. After line 29 add:

```ts
import { effectiveGraph } from "../graph/graph-routing.js";
```

- [ ] **Step 4: Validate the effective graph in POST**

In `routes.ts`, replace the POST validation block (currently lines 101-111):

```ts
    {
      const steps = normalizeStepsForValidation(parsed.data.steps);
      const graph = effectiveGraph(parsed.data.graph ?? null, steps);
      const issues = [
        ...validateGraph(graph, steps),
        ...validateSchemaReferences(graph, steps),
      ];
      if (issues.length > 0) {
        reply.status(400);
        return { error: "invalid_graph", issues };
      }
    }
```

- [ ] **Step 5: Validate the effective graph in PATCH**

In `routes.ts`, replace the PATCH validation block (currently lines 127-137) with the identical block:

```ts
    {
      const steps = normalizeStepsForValidation(parsed.data.steps);
      const graph = effectiveGraph(parsed.data.graph ?? null, steps);
      const issues = [
        ...validateGraph(graph, steps),
        ...validateSchemaReferences(graph, steps),
      ];
      if (issues.length > 0) {
        reply.status(400);
        return { error: "invalid_graph", issues };
      }
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- routes`
Expected: PASS — including the pre-existing `create -> list -> get -> update -> duplicate flow works` test (single-step graph-null still materializes a valid terminal).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/templates/routes.ts apps/daemon/src/workflows/templates/routes.test.ts
git commit -m "feat(workflows): enforce terminal rules on the effective graph for all templates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Default a terminal in desktop graph materialization

**Files:**
- Modify: `apps/desktop/src/workflows/graph-sync.ts:8-23` (`buildInitialGraph`), `:51-64` and `:100-104` (`reconcileGraph`)
- Test: `apps/desktop/src/workflows/graph-sync.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `graph-sync.test.ts`. Inside `describe("buildInitialGraph", ...)`:

```ts
  it("marks the last step terminal", () => {
    const graph = buildInitialGraph([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
    expect(graph.nodes.map((n) => n.terminal ?? false)).toEqual([false, false, true]);
  });

  it("single step is terminal", () => {
    const graph = buildInitialGraph([makeStep("s1")]);
    expect(graph.nodes[0]!.terminal).toBe(true);
  });
```

Inside `describe("reconcileGraph", ...)`:

```ts
  it("defaults the last step terminal when no node is terminal", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: [
        { id: "s1", type: "step" as const, name: "s1", stepId: "s1" },
        { id: "s2", type: "step" as const, name: "s2", stepId: "s2" },
      ],
      edges: [{ from: "s1", to: "s2" }],
      positions: { s1: { x: 110, y: 20 }, s2: { x: 110, y: 112 } },
    };
    const next = reconcileGraph(steps, graph);
    const s2 = next.nodes.find((n) => n.id === "s2");
    expect(s2!.terminal).toBe(true);
  });

  it("preserves an existing terminal flag instead of overriding it", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: [
        { id: "s1", type: "step" as const, name: "s1", stepId: "s1", terminal: true },
        { id: "s2", type: "step" as const, name: "s2", stepId: "s2" },
      ],
      edges: [],
      positions: { s1: { x: 110, y: 20 }, s2: { x: 110, y: 112 } },
    };
    const next = reconcileGraph(steps, graph);
    expect(next.nodes.find((n) => n.id === "s1")!.terminal).toBe(true);
    expect(next.nodes.find((n) => n.id === "s2")!.terminal ?? false).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/desktop test -- graph-sync`
Expected: FAIL — `buildInitialGraph` produces no terminal; `reconcileGraph` does not default one.

- [ ] **Step 3: Mark the last node terminal in `buildInitialGraph`**

In `graph-sync.ts`, replace the node-building loop in `buildInitialGraph` (lines 13-17):

```ts
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    nodes.push({
      id: step.id,
      type: "step",
      name: step.name,
      stepId: step.id,
      ...(i === steps.length - 1 ? { terminal: true } : {}),
    });
    positions[step.id] = { x: 110, y: 20 + i * 92 };
  }
```

- [ ] **Step 4: Default a terminal in `reconcileGraph`**

In `graph-sync.ts`, in `reconcileGraph`, immediately before the `return { nodes: [...nextStepNodes, ...existingGates], … }` statement (currently line 100), insert:

```ts
  // Guarantee a terminal exists: if no surviving step node is terminal, mark the
  // last one (mirrors the daemon's materializeLinearGraph default).
  if (nextStepNodes.length > 0 && !nextStepNodes.some((n) => n.terminal)) {
    const lastIdx = nextStepNodes.length - 1;
    nextStepNodes[lastIdx] = { ...nextStepNodes[lastIdx], terminal: true };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orca/desktop test -- graph-sync`
Expected: PASS (including the pre-existing `buildInitialGraph` / `reconcileGraph` tests — `toMatchObject` assertions ignore the added `terminal` field).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/workflows/graph-sync.ts apps/desktop/src/workflows/graph-sync.test.ts
git commit -m "fix(desktop): default a terminal node when materializing workflow graphs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Built-in catalog — Done steps, explicit graphs, version bumps

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (BUGFIX/CODE_REVIEW/QUALITY_COVERAGE steps; new graph constants for all 5 linear built-ins; catalog entries)
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

- [ ] **Step 1: Add the Done step to `BUGFIX_STEPS`**

In `catalog.ts`, append this step to the `BUGFIX_STEPS` array (after the `verify` step, before the closing `];`):

```ts
  {
    id: "done", ordinal: 4, name: "Done",
    instructions:
      "Finalize the fix after verification. Summarize the defect, its root cause, and the change that resolved it, and record the regression evidence. Make no further code changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "resolution", type: "string", required: true },
      { key: "regression_evidence", type: "array", itemType: "string", required: true },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
```

- [ ] **Step 2: Add the Done step to `CODE_REVIEW_STEPS`**

Append to the `CODE_REVIEW_STEPS` array (after the `report` step):

```ts
  {
    id: "done", ordinal: 3, name: "Done",
    instructions:
      "Finalize the review. Record the verdict, the change requests, and any follow-up the author must address before merge. Make no code changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "verdict", type: "string", required: true, enum: ["approved", "changes_requested"] },
      { key: "follow_up", type: "array", itemType: "string", required: false },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
```

- [ ] **Step 3: Add the Done step to `QUALITY_COVERAGE_STEPS`**

Append to the `QUALITY_COVERAGE_STEPS` array (after the `confirm_green` step):

```ts
  {
    id: "done", ordinal: 3, name: "Done",
    instructions:
      "Finalize the coverage work. Summarize the gaps closed, the checks added, and the resulting quality delta. Make no further changes.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "gaps_closed", type: "array", itemType: "string", required: true },
      { key: "handoff", type: "string", required: true },
    ],
    agentPreference: LIGHT,
  },
```

- [ ] **Step 4: Add explicit linear graphs for the 5 linear built-ins**

In `catalog.ts`, add these five constants (place each near its steps array, mirroring the existing `FEATURE_GRAPH` style). Every non-terminal step chains to the next; the final `done` node is `terminal: true`.

```ts
const BRAINSTORM_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "frame", type: "step", name: "Frame", stepId: "frame" },
    { id: "research", type: "step", name: "Research", stepId: "research" },
    { id: "proposal", type: "step", name: "Proposal", stepId: "proposal" },
    { id: "critique", type: "step", name: "Critique", stepId: "critique" },
    { id: "verify", type: "step", name: "Verify", stepId: "verify" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "frame", to: "research" },
    { from: "research", to: "proposal" },
    { from: "proposal", to: "critique" },
    { from: "critique", to: "verify" },
    { from: "verify", to: "done" },
  ],
  positions: {
    frame: { x: 110, y: 20 }, research: { x: 110, y: 112 }, proposal: { x: 110, y: 204 },
    critique: { x: 110, y: 296 }, verify: { x: 110, y: 388 }, done: { x: 110, y: 480 },
  },
};

const BUGFIX_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "reproduce", type: "step", name: "Reproduce", stepId: "reproduce" },
    { id: "root_cause", type: "step", name: "Root Cause", stepId: "root_cause" },
    { id: "patch", type: "step", name: "Patch", stepId: "patch" },
    { id: "verify", type: "step", name: "Verify", stepId: "verify" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "reproduce", to: "root_cause" },
    { from: "root_cause", to: "patch" },
    { from: "patch", to: "verify" },
    { from: "verify", to: "done" },
  ],
  positions: {
    reproduce: { x: 110, y: 20 }, root_cause: { x: 110, y: 112 }, patch: { x: 110, y: 204 },
    verify: { x: 110, y: 296 }, done: { x: 110, y: 388 },
  },
};

const CODE_REVIEW_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "analyze_diff", type: "step", name: "Analyze Diff", stepId: "analyze_diff" },
    { id: "risk_pass", type: "step", name: "Risk Pass", stepId: "risk_pass" },
    { id: "report", type: "step", name: "Report", stepId: "report" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "analyze_diff", to: "risk_pass" },
    { from: "risk_pass", to: "report" },
    { from: "report", to: "done" },
  ],
  positions: {
    analyze_diff: { x: 110, y: 20 }, risk_pass: { x: 110, y: 112 },
    report: { x: 110, y: 204 }, done: { x: 110, y: 296 },
  },
};

const REFACTOR_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "map_blast_radius", type: "step", name: "Map Blast Radius", stepId: "map_blast_radius" },
    { id: "restructure", type: "step", name: "Restructure", stepId: "restructure" },
    { id: "behavior_parity", type: "step", name: "Behavior Parity", stepId: "behavior_parity" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "map_blast_radius", to: "restructure" },
    { from: "restructure", to: "behavior_parity" },
    { from: "behavior_parity", to: "done" },
  ],
  positions: {
    map_blast_radius: { x: 110, y: 20 }, restructure: { x: 110, y: 112 },
    behavior_parity: { x: 110, y: 204 }, done: { x: 110, y: 296 },
  },
};

const QUALITY_COVERAGE_GRAPH: WorkflowGraph = {
  nodes: [
    { id: "find_gaps", type: "step", name: "Find Gaps", stepId: "find_gaps" },
    { id: "generate_checks", type: "step", name: "Generate Checks", stepId: "generate_checks" },
    { id: "confirm_green", type: "step", name: "Confirm Green", stepId: "confirm_green" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "find_gaps", to: "generate_checks" },
    { from: "generate_checks", to: "confirm_green" },
    { from: "confirm_green", to: "done" },
  ],
  positions: {
    find_gaps: { x: 110, y: 20 }, generate_checks: { x: 110, y: 112 },
    confirm_green: { x: 110, y: 204 }, done: { x: 110, y: 296 },
  },
};
```

- [ ] **Step 5: Wire graphs + version bumps into the catalog entries**

In `catalog.ts`, in `BUILTIN_TEMPLATE_CATALOG`, update the five linear entries — set `version: 2` and replace `graph: null` with the new constant:

- `orca/brainstorm`: `version: 2`, `graph: BRAINSTORM_GRAPH`
- `orca/bug-triage-fix`: `version: 2`, `graph: BUGFIX_GRAPH`
- `orca/code-review`: `version: 2`, `graph: CODE_REVIEW_GRAPH`
- `orca/refactor`: `version: 2`, `graph: REFACTOR_GRAPH`
- `orca/quality-coverage`: `version: 2`, `graph: QUALITY_COVERAGE_GRAPH`

Leave `orca/feature-development` and `orca/initiative-implementation` unchanged.

- [ ] **Step 6: Update the catalog test**

In `catalog.test.ts`, change the `code-review` stepCount assertion (line 66) from `3` to `4`:

```ts
    expect(byId["orca/code-review"].stepCount).toBe(4);
```

Add this test inside `describe("built-in template catalog", ...)`:

```ts
  it("every built-in graph has a terminal reachable from every node", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.graph).not.toBeNull();
      const errors = validateGraph(d.graph!, d.steps as WorkflowStepTemplate[]);
      expect(errors).toEqual([]);
      expect(d.graph!.nodes.some((n) => n.type === "step" && n.terminal)).toBe(true);
    }
  });
```

- [ ] **Step 7: Run the catalog tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- catalog`
Expected: PASS — including the existing "every step output schema is valid and every graph passes the blocking validators" test (now exercising all 7 graphs) and the brainstorm/feature/initiative stepCount assertions (unchanged: brainstorm graph has 6 nodes, code-review 4).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(workflows): explicit graphs + terminal Done steps for all built-ins

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the daemon workflow test suite**

Run: `pnpm --filter @orca/daemon test -- workflows`
Expected: PASS. Watch specifically for `usecases.builtins.test.ts` and `projection`/`reconcile` suites that seed built-ins — the version bump to 2 re-seeds the five linear built-ins.

- [ ] **Step 2: Run the desktop workflow test suite**

Run: `pnpm --filter @orca/desktop test -- workflows`
Expected: PASS — including `NodeDetailModal`, `TemplateDetail`-adjacent, and `graph-sync` tests.

- [ ] **Step 3: Typecheck both packages**

Run: `pnpm -r typecheck` (or the repo's configured typecheck script)
Expected: no errors.

- [ ] **Step 4: Commit any incidental fixes**

If steps 1-3 surfaced a test or type that needs updating because of the new terminal rule (e.g. a fixture graph elsewhere that lacked a terminal), fix it minimally and commit:

```bash
git add -A
git commit -m "test(workflows): update fixtures for terminal-step rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 validation rule → Task 1. §2 effective-graph enforcement → Task 2. §3 built-in catalog (Done steps, explicit graphs, version bumps) → Task 4. §4 desktop materialization → Task 3. §5 tests → distributed across Tasks 1-4 plus Task 5 sweep.
- **Type consistency:** `effectiveGraph(graph: WorkflowGraph | null, steps)` matches the `parsed.data.graph ?? null` call site. New graph constants are typed `WorkflowGraph` and assigned to the catalog's `graph: WorkflowGraph | null` field. Step `id`s in each graph's `stepId` match the step template `id`s exactly.
- **Watch point:** any other test fixture in the daemon that builds a graph without a terminal will now fail validation if it flows through `validateGraph`. Task 5 Step 1 is where that surfaces; fix minimally.
