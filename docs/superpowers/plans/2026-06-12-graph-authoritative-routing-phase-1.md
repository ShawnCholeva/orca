# Graph-Authoritative Routing (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authored workflow graph authoritative for runtime routing — direct step edges, orchestrator-judged gates with `approved`/`rejected` ports, backward transitions, an explicit terminal step, immutable revisit attempts, gate persistence with restart recovery, and blocking template validation — without building the platform ledger (Phase 2) or the Feature Development template content (Phase 3).

**Architecture:** A new pure routing engine (`graph-routing.ts`) resolves the next node from the current node + the authored graph (or a materialized linear graph for legacy templates). The daemon persists a run-level node cursor and an immutable `workflow_gate_decisions` table. The orchestrator service routes step→step/gate transitions through the engine instead of `ordinal + 1`, evaluates gates through the existing transport broker (same pattern as step scoring), and preserves the human mark-done yield at the explicit terminal step. Template save gains blocking graph validation. The desktop editor emits labeled edges and edits gate instructions + the step terminal flag.

**Tech Stack:** TypeScript, zod (`@orca/contracts`), better-sqlite3 (WAL), Fastify, vitest, React (Tauri desktop). Conventional Commits; every commit message ends with the `Co-Authored-By` trailer below.

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## File Structure

**Contracts (`packages/contracts/src/workflows/`)**
- Modify `index.ts` — `WorkflowGraphEdge` (tuple → labeled object with back-compat), `WorkflowGraphNode` (`instructions`, `terminal`), new `WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS`, new enum members.

**Daemon routing engine (`apps/daemon/src/workflows/graph/`) — new directory**
- Create `graph-routing.ts` — pure traversal: `effectiveGraph`, `materializeLinearGraph`, `findInitialStepNode`, `resolveStepNext`, `resolveGateNext`.
- Create `graph-routing.test.ts`.
- Create `validate-graph.ts` — pure structural validation (the rule list) + `{{key}}` all-paths reference resolution.
- Create `validate-graph.test.ts`.

**Daemon persistence**
- Create `apps/daemon/migrations/0029_workflow_graph_cursor.sql` — `workflow_runs.current_node_id`, `current_node_kind`, `traversal_seq`; `workflow_gate_decisions` table.
- Modify `apps/daemon/src/migrations.ts` — register the migration.
- Modify `apps/daemon/src/workflows/runs/projection.ts` — surface the cursor columns.
- Create `apps/daemon/src/workflows/gates/projection.ts` — read gate decisions for a run.
- Create `apps/daemon/src/workflows/gates/usecases.ts` — `recordGateDecision`, `nextTraversalSeq`.

**Daemon orchestration integration**
- Modify `apps/daemon/src/workflows/steps/usecases.ts` — graph traversal in `advanceToNextStep`; revisit attempt = max+1.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — graph routing in `commitAdvanceOrComplete`; gate evaluation; terminal detection by flag; supervised gate pause; graph-aware repair context.
- Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts` — broker-driven gate judgment (modeled on `step-result-scoring.ts`).
- Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`.
- Modify `apps/daemon/src/workflows/templates/routes.ts` — blocking graph validation on create/update.
- Modify `apps/daemon/src/workflows/reconcile.ts` — gate cursor is resumable, not drift.

**Desktop (`apps/desktop/src/workflows/`)**
- Modify `graph-sync.ts` — labeled edges, gate-port awareness.
- Modify `WorkflowFlow.tsx` — emit/consume labeled edges; two gate ports.
- Modify `NodeDetailModal.tsx` — gate `instructions` (replace `condition`); step `terminal` toggle.

---

## Conventions you must follow

- Migrations are **append-only**. Never edit an applied `.sql`. Add a new numbered file and register it in `apps/daemon/src/migrations.ts`.
- Run daemon tests with `pnpm --filter @orca/daemon test`, contracts with `pnpm --filter @orca/contracts test`, desktop with `pnpm --filter @orca/desktop test`. Type-check everything with `pnpm typecheck`.
- A single test file: `pnpm --filter @orca/daemon test -- <path> -t "<name>"`.
- Projection modules cache prepared statements keyed by `db` identity and expose `resetPreparedStatements()`. When you add columns to a `SELECT`, the cached statement must be rebuilt — tests already call `resetPreparedStatements()` in setup; follow the existing pattern.
- Keep changes surgical (CLAUDE.md §3): do not refactor adjacent code.

---

## Task 1: Labeled edge contract with legacy back-compat

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:297-307` (the `WorkflowGraphEdge` / `WorkflowGraph` block)
- Test: `packages/contracts/src/workflows/graph-contract.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/workflows/graph-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkflowGraph, WorkflowGraphEdge } from "./index.js";

describe("WorkflowGraphEdge", () => {
  it("parses a labeled object edge", () => {
    const edge = WorkflowGraphEdge.parse({ from: "a", to: "b" });
    expect(edge).toEqual({ from: "a", to: "b" });
  });

  it("parses a gate edge with a port", () => {
    const edge = WorkflowGraphEdge.parse({ from: "g", to: "x", port: "approved" });
    expect(edge.port).toBe("approved");
  });

  it("normalizes a legacy two-element array edge to { from, to }", () => {
    const edge = WorkflowGraphEdge.parse(["a", "b"]);
    expect(edge).toEqual({ from: "a", to: "b" });
  });

  it("rejects an unknown port", () => {
    expect(() => WorkflowGraphEdge.parse({ from: "g", to: "x", port: "maybe" })).toThrow();
  });

  it("parses a whole graph whose edges mix legacy and labeled forms", () => {
    const graph = WorkflowGraph.parse({
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b" },
      ],
      edges: [["a", "b"]],
      positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
    });
    expect(graph.edges[0]).toEqual({ from: "a", to: "b" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- graph-contract.test.ts`
Expected: FAIL — `WorkflowGraphEdge.parse(["a","b"])` returns a tuple `["a","b"]`, not `{ from, to }`.

- [ ] **Step 3: Replace the edge schema**

In `packages/contracts/src/workflows/index.ts`, replace lines 297-307:

```ts
export const WorkflowGraphEdge = z.preprocess(
  (value) =>
    Array.isArray(value) && value.length === 2
      ? { from: value[0], to: value[1] }
      : value,
  z
    .object({
      from: Id100,
      to: Id100,
      port: z.enum(["approved", "rejected"]).optional(),
    })
    .strict()
);
export type WorkflowGraphEdge = z.infer<typeof WorkflowGraphEdge>;

export const WorkflowGraph = z
  .object({
    nodes: z.array(WorkflowGraphNode).max(WORKFLOW_GRAPH_MAX_NODES),
    edges: z.array(WorkflowGraphEdge).max(WORKFLOW_GRAPH_MAX_EDGES),
    positions: z.record(Id100, z.object({ x: z.number(), y: z.number() }).strict()),
  })
  .strict();
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- graph-contract.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(contracts): labeled workflow graph edges with legacy back-compat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Graph node `instructions` and `terminal` fields

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:286-295` (`WorkflowGraphNode`) and the constants block near line 44
- Test: `packages/contracts/src/workflows/graph-contract.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/workflows/graph-contract.test.ts`:

```ts
import { WorkflowGraphNode } from "./index.js";

describe("WorkflowGraphNode", () => {
  it("accepts a terminal step node", () => {
    const node = WorkflowGraphNode.parse({
      id: "done",
      type: "step",
      name: "Done",
      stepId: "done",
      terminal: true,
    });
    expect(node.terminal).toBe(true);
  });

  it("accepts a gate node with instructions", () => {
    const node = WorkflowGraphNode.parse({
      id: "gate",
      type: "gate",
      name: "Release Readiness",
      instructions: "Approve only when validation passed.",
    });
    expect(node.instructions).toBe("Approve only when validation passed.");
  });

  it("still accepts a legacy gate node with a condition field", () => {
    const node = WorkflowGraphNode.parse({
      id: "gate",
      type: "gate",
      name: "Gate",
      condition: "x === true",
    });
    expect(node.condition).toBe("x === true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- graph-contract.test.ts`
Expected: FAIL — `terminal` and `instructions` are unknown keys under `.strict()`.

- [ ] **Step 3: Add the constant and node fields**

In `packages/contracts/src/workflows/index.ts`, add to the constants block (after line 44, `WORKFLOW_GATE_MAX_CONDITION_CHARS`):

```ts
export const WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS = 8192;
```

Replace the `WorkflowGraphNode` definition (lines 286-295):

```ts
export const WorkflowGraphNode = z
  .object({
    id: Id100,
    type: z.enum(["step", "gate"]),
    name: z.string().max(100).default(""),
    stepId: Id100.optional(),
    // Legacy gate field, retained read-only so pre-migration graphs still parse.
    condition: z.string().max(WORKFLOW_GATE_MAX_CONDITION_CHARS).optional(),
    // Gate nodes: the orchestrator routing instructions (replaces `condition`).
    instructions: z.string().max(WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS).optional(),
    // Step nodes: explicit terminal designation. Exactly one per valid template.
    terminal: z.boolean().optional(),
  })
  .strict();
export type WorkflowGraphNode = z.infer<typeof WorkflowGraphNode>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- graph-contract.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(contracts): gate instructions and terminal flag on graph nodes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure graph traversal engine

**Files:**
- Create: `apps/daemon/src/workflows/graph/graph-routing.ts`
- Test: `apps/daemon/src/workflows/graph/graph-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/graph/graph-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowStepTemplate } from "@orca/contracts";
import {
  effectiveGraph,
  findInitialStepNode,
  resolveGateNext,
  resolveStepNext,
} from "./graph-routing.js";

const steps: WorkflowStepTemplate[] = [
  { id: "analysis", ordinal: 0, name: "Analysis", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "execution", ordinal: 1, name: "Execution", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "validation", ordinal: 2, name: "Validation", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "done", ordinal: 3, name: "Done", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
];

const featureGraph: WorkflowGraph = {
  nodes: [
    { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation" },
    { id: "gate", type: "gate", name: "Release Readiness", instructions: "approve when passed" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "analysis", to: "execution" },
    { from: "execution", to: "validation" },
    { from: "validation", to: "gate" },
    { from: "gate", to: "done", port: "approved" },
    { from: "gate", to: "execution", port: "rejected" },
  ],
  positions: {},
};

describe("findInitialStepNode", () => {
  it("returns the node for the lowest-ordinal step", () => {
    expect(findInitialStepNode(featureGraph, steps)?.id).toBe("analysis");
  });
});

describe("resolveStepNext", () => {
  it("returns the next step node", () => {
    expect(resolveStepNext(featureGraph, "analysis")).toEqual({ kind: "step", nodeId: "execution" });
  });

  it("returns the gate node", () => {
    expect(resolveStepNext(featureGraph, "validation")).toEqual({ kind: "gate", nodeId: "gate" });
  });

  it("returns terminal for a terminal step node", () => {
    expect(resolveStepNext(featureGraph, "done")).toEqual({ kind: "terminal" });
  });
});

describe("resolveGateNext", () => {
  it("routes approved forward", () => {
    expect(resolveGateNext(featureGraph, "gate", "approved")).toEqual({ kind: "step", nodeId: "done" });
  });

  it("routes rejected backward", () => {
    expect(resolveGateNext(featureGraph, "gate", "rejected")).toEqual({ kind: "step", nodeId: "execution" });
  });
});

describe("effectiveGraph (legacy materialization)", () => {
  it("materializes a linear graph when graph is null, marking the last step terminal", () => {
    const g = effectiveGraph(null, steps);
    expect(g.edges).toEqual([
      { from: "analysis", to: "execution" },
      { from: "execution", to: "validation" },
      { from: "validation", to: "done" },
    ]);
    const done = g.nodes.find((n) => n.id === "done");
    expect(done?.terminal).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- graph-routing.test.ts`
Expected: FAIL — `Cannot find module './graph-routing.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/workflows/graph/graph-routing.ts`:

```ts
import type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowStepTemplate,
} from "@orca/contracts";

export type Destination =
  | { kind: "step"; nodeId: string }
  | { kind: "gate"; nodeId: string }
  | { kind: "terminal" };

export type GateOutcome = "approved" | "rejected";

/**
 * Returns the template's authored graph, or a synthesized linear graph built
 * from step ordinals when no graph is stored. The synthesized graph chains
 * consecutive step nodes and marks the highest-ordinal step terminal.
 */
export function effectiveGraph(
  graph: WorkflowGraph | null,
  steps: WorkflowStepTemplate[]
): WorkflowGraph {
  if (graph) return graph;
  return materializeLinearGraph(steps);
}

export function materializeLinearGraph(steps: WorkflowStepTemplate[]): WorkflowGraph {
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const nodes: WorkflowGraphNode[] = sorted.map((step, i) => ({
    id: step.id,
    type: "step" as const,
    name: step.name,
    stepId: step.id,
    ...(i === sorted.length - 1 ? { terminal: true } : {}),
  }));
  const edges = sorted
    .slice(0, -1)
    .map((step, i) => ({ from: step.id, to: sorted[i + 1].id }));
  const positions: WorkflowGraph["positions"] = {};
  sorted.forEach((step, i) => {
    positions[step.id] = { x: 110, y: 20 + i * 92 };
  });
  return { nodes, edges, positions };
}

function nodeById(graph: WorkflowGraph, id: string): WorkflowGraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** The graph node for the lowest-ordinal step template. */
export function findInitialStepNode(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[]
): WorkflowGraphNode | undefined {
  const first = [...steps].sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!first) return undefined;
  return graph.nodes.find((n) => n.type === "step" && (n.stepId ?? n.id) === first.id);
}

function classify(graph: WorkflowGraph, toId: string): Destination {
  const node = nodeById(graph, toId);
  if (!node) throw new GraphRoutingError(`edge points to unknown node: ${toId}`);
  return node.type === "gate" ? { kind: "gate", nodeId: toId } : { kind: "step", nodeId: toId };
}

/**
 * Resolves the destination of a step node. A terminal step has no outgoing edge
 * and resolves to { kind: "terminal" }.
 */
export function resolveStepNext(graph: WorkflowGraph, stepNodeId: string): Destination {
  const node = nodeById(graph, stepNodeId);
  if (!node || node.type !== "step") {
    throw new GraphRoutingError(`not a step node: ${stepNodeId}`);
  }
  if (node.terminal) return { kind: "terminal" };
  const out = graph.edges.filter((e) => e.from === stepNodeId);
  if (out.length !== 1) {
    throw new GraphRoutingError(
      `step node ${stepNodeId} must have exactly one outgoing edge, found ${out.length}`
    );
  }
  return classify(graph, out[0].to);
}

/** Resolves the destination for a gate outcome via the port-labeled edge. */
export function resolveGateNext(
  graph: WorkflowGraph,
  gateNodeId: string,
  outcome: GateOutcome
): Destination {
  const out = graph.edges.filter((e) => e.from === gateNodeId && e.port === outcome);
  if (out.length !== 1) {
    throw new GraphRoutingError(
      `gate ${gateNodeId} must have exactly one '${outcome}' edge, found ${out.length}`
    );
  }
  return classify(graph, out[0].to);
}

export class GraphRoutingError extends Error {
  readonly code = "graph_routing_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "GraphRoutingError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- graph-routing.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/graph-routing.ts apps/daemon/src/workflows/graph/graph-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): pure graph traversal engine for workflow routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pure graph structural validation

**Files:**
- Create: `apps/daemon/src/workflows/graph/validate-graph.ts`
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/graph/validate-graph.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph } from "./validate-graph.js";

function step(id: string, ordinal: number): WorkflowStepTemplate {
  return {
    id,
    ordinal,
    name: id,
    instructions: "do",
    outputSchema: [{ key: "s", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "m" }],
  };
}

const steps = [step("analysis", 0), step("execution", 1), step("validation", 2), step("done", 3)];

const valid: WorkflowGraph = {
  nodes: [
    { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation" },
    { id: "gate", type: "gate", name: "Gate", instructions: "approve when passed" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "analysis", to: "execution" },
    { from: "execution", to: "validation" },
    { from: "validation", to: "gate" },
    { from: "gate", to: "done", port: "approved" },
    { from: "gate", to: "execution", port: "rejected" },
  ],
  positions: {},
};

describe("validateGraph", () => {
  it("accepts the valid feature graph", () => {
    expect(validateGraph(valid, steps)).toEqual([]);
  });

  it("rejects when there is no terminal step", () => {
    const g = { ...valid, nodes: valid.nodes.map((n) => (n.id === "done" ? { ...n, terminal: false } : n)) };
    expect(validateGraph(g, steps)).toContain("exactly one terminal step is required (found 0)");
  });

  it("rejects when a terminal step has an outgoing edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "done", to: "analysis" }] };
    expect(validateGraph(g, steps)).toContain("terminal step 'done' must have no outgoing edges");
  });

  it("rejects a nonterminal step with no outgoing edge", () => {
    const g = { ...valid, edges: valid.edges.filter((e) => e.from !== "analysis") };
    expect(validateGraph(g, steps)).toContain("step 'analysis' must have exactly one outgoing edge (found 0)");
  });

  it("rejects a gate missing the rejected port", () => {
    const g = { ...valid, edges: valid.edges.filter((e) => !(e.from === "gate" && e.port === "rejected")) };
    expect(validateGraph(g, steps)).toContain("gate 'gate' must have exactly one 'rejected' edge (found 0)");
  });

  it("rejects a self-edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "execution", to: "execution" }] };
    expect(validateGraph(g, steps)).toContain("self-edge is not allowed: execution -> execution");
  });

  it("rejects a duplicate directed edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "analysis", to: "execution" }] };
    expect(validateGraph(g, steps)).toContain("duplicate edge: analysis -> execution");
  });

  it("rejects an edge to an unknown node", () => {
    const g = { ...valid, edges: valid.edges.map((e) => (e.from === "analysis" ? { ...e, to: "ghost" } : e)) };
    expect(validateGraph(g, steps)).toContain("edge references unknown node: analysis -> ghost");
  });

  it("rejects a step node referencing a missing step template", () => {
    const g = { ...valid, nodes: valid.nodes.map((n) => (n.id === "analysis" ? { ...n, stepId: "missing" } : n)) };
    expect(validateGraph(g, steps)).toContain("step node 'analysis' references unknown step template 'missing'");
  });

  it("rejects an unreachable node", () => {
    const g: WorkflowGraph = {
      ...valid,
      nodes: [...valid.nodes, { id: "orphan", type: "step", name: "Orphan", stepId: "execution" }],
    };
    expect(validateGraph(g, steps)).toContain("node 'orphan' is unreachable from the initial step");
  });

  it("rejects a direct step edge carrying a port", () => {
    const g = { ...valid, edges: valid.edges.map((e) => (e.from === "analysis" ? { ...e, port: "approved" as const } : e)) };
    expect(validateGraph(g, steps)).toContain("step edge must not carry a port: analysis -> execution");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- validate-graph.test.ts`
Expected: FAIL — `Cannot find module './validate-graph.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/workflows/graph/validate-graph.ts`:

```ts
import type { WorkflowGraph, WorkflowStepTemplate } from "@orca/contracts";
import { findInitialStepNode } from "./graph-routing.js";

/**
 * Returns a list of human-readable rule violations for a graph against its step
 * templates. An empty list means the graph is valid. Backward edges and cycles
 * are valid; there is no visit cap.
 */
export function validateGraph(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[]
): string[] {
  const errors: string[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const stepIds = new Set(steps.map((s) => s.id));

  // Edge integrity: existing endpoints, no self-edges, no duplicates.
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) {
      errors.push(`edge references unknown node: ${e.from} -> ${e.to}`);
      continue;
    }
    if (e.from === e.to) errors.push(`self-edge is not allowed: ${e.from} -> ${e.to}`);
    const key = `${e.from} -> ${e.to}`;
    if (seen.has(key)) errors.push(`duplicate edge: ${key}`);
    seen.add(key);
  }

  // Terminal: exactly one terminal step node.
  const terminals = graph.nodes.filter((n) => n.type === "step" && n.terminal);
  if (terminals.length !== 1) {
    errors.push(`exactly one terminal step is required (found ${terminals.length})`);
  }

  for (const node of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === node.id);
    if (node.type === "step") {
      if ((node.stepId ?? node.id) && !stepIds.has(node.stepId ?? node.id)) {
        errors.push(
          `step node '${node.id}' references unknown step template '${node.stepId ?? node.id}'`
        );
      }
      if (node.terminal) {
        if (out.length !== 0) errors.push(`terminal step '${node.id}' must have no outgoing edges`);
      } else if (out.length !== 1) {
        errors.push(`step '${node.id}' must have exactly one outgoing edge (found ${out.length})`);
      }
      for (const e of out) {
        if (e.port) errors.push(`step edge must not carry a port: ${e.from} -> ${e.to}`);
      }
    } else {
      // gate
      for (const outcome of ["approved", "rejected"] as const) {
        const matching = out.filter((e) => e.port === outcome);
        if (matching.length !== 1) {
          errors.push(
            `gate '${node.id}' must have exactly one '${outcome}' edge (found ${matching.length})`
          );
        }
      }
      for (const e of out) {
        if (e.port !== "approved" && e.port !== "rejected") {
          errors.push(`gate edge must carry a valid port: ${e.from} -> ${e.to}`);
        }
      }
    }
  }

  // Reachability from the initial step node.
  const initial = findInitialStepNode(graph, steps);
  if (!initial) {
    errors.push("no initial step node (lowest-ordinal step has no graph node)");
  } else {
    const reachable = new Set<string>([initial.id]);
    const queue = [initial.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of graph.edges) {
        if (e.from === id && !reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        errors.push(`node '${node.id}' is unreachable from the initial step`);
      }
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- validate-graph.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): blocking structural validation for workflow graphs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `{{key}}` schema-reference resolution across all incoming paths

**Files:**
- Modify: `apps/daemon/src/workflows/graph/validate-graph.ts`
- Test: `apps/daemon/src/workflows/graph/validate-graph.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/workflows/graph/validate-graph.test.ts`:

```ts
import { validateSchemaReferences } from "./validate-graph.js";

describe("validateSchemaReferences", () => {
  function refStep(id: string, ordinal: number, instructions: string, produces: string[]): WorkflowStepTemplate {
    return {
      id,
      ordinal,
      name: id,
      instructions,
      outputSchema: produces.map((k) => ({ key: k, type: "string" as const, required: true })),
      agentPreference: [{ adapterId: "claude-code", modelId: "m" }],
    };
  }

  it("accepts a reference produced on every incoming path", () => {
    const s = [refStep("a", 0, "", ["plan"]), refStep("b", 1, "use {{plan}}", [])];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
      ],
      edges: [{ from: "a", to: "b" }],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toEqual([]);
  });

  it("rejects a reference to a key produced by no upstream node", () => {
    const s = [refStep("a", 0, "", ["plan"]), refStep("b", 1, "use {{missing}}", [])];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
      ],
      edges: [{ from: "a", to: "b" }],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toContain(
      "step 'b' references '{{missing}}' which is not produced on every incoming path"
    );
  });

  it("allows platform context keys (goal, workspace)", () => {
    const s = [refStep("a", 0, "use {{goal}} and {{workspace}}", ["plan"])];
    const g: WorkflowGraph = {
      nodes: [{ id: "a", type: "step", name: "A", stepId: "a", terminal: true }],
      edges: [],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- validate-graph.test.ts -t "validateSchemaReferences"`
Expected: FAIL — `validateSchemaReferences` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `apps/daemon/src/workflows/graph/validate-graph.ts`:

```ts
const REF_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const PLATFORM_KEYS = new Set(["goal", "workspace", "constraints", "role"]);

function refsIn(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * A `{{key}}` token in a step's instructions is valid only if every path from
 * the initial node to that step passes through a node producing `key`, or `key`
 * is platform context. Computed as a forward "must-reach" fixpoint: the keys
 * available at a node are the intersection, over all predecessors, of each
 * predecessor's available keys plus the keys it produces. Cycles do not remove a
 * key once it is produced on all incoming paths.
 */
export function validateSchemaReferences(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[]
): string[] {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const produces = new Map<string, Set<string>>(); // nodeId -> keys it produces
  for (const node of graph.nodes) {
    if (node.type === "step") {
      const tpl = stepById.get(node.stepId ?? node.id);
      produces.set(node.id, new Set(tpl ? tpl.outputSchema.map((f) => f.key) : []));
    } else {
      produces.set(node.id, new Set());
    }
  }

  const initial = findInitialStepNode(graph, steps);
  if (!initial) return []; // structural validation already reported this

  const allKeys = new Set<string>();
  for (const set of produces.values()) for (const k of set) allKeys.add(k);

  // available[node]: keys guaranteed present on entry. Initialize to the
  // universe (so intersection narrows it), except the initial node which has
  // only platform keys on entry.
  const available = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    available.set(node.id, node.id === initial.id ? new Set() : new Set(allKeys));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (node.id === initial.id) continue;
      const preds = graph.edges.filter((e) => e.to === node.id).map((e) => e.from);
      if (preds.length === 0) continue;
      let next: Set<string> | null = null;
      for (const p of preds) {
        const incoming = new Set([...(available.get(p) ?? []), ...(produces.get(p) ?? [])]);
        next = next === null ? incoming : new Set([...next].filter((k) => incoming.has(k)));
      }
      const cur = available.get(node.id)!;
      if (next && (next.size !== cur.size || [...next].some((k) => !cur.has(k)))) {
        available.set(node.id, next);
        changed = true;
      }
    }
  }

  const errors: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "step") continue;
    const tpl = stepById.get(node.stepId ?? node.id);
    if (!tpl) continue;
    const here = available.get(node.id)!;
    for (const ref of refsIn(tpl.instructions)) {
      if (!here.has(ref) && !PLATFORM_KEYS.has(ref)) {
        errors.push(
          `step '${node.id}' references '{{${ref}}}' which is not produced on every incoming path`
        );
      }
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- validate-graph.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/graph/validate-graph.ts apps/daemon/src/workflows/graph/validate-graph.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): all-paths {{key}} reference validation for graphs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Block template save on invalid graphs

**Files:**
- Modify: `apps/daemon/src/workflows/templates/routes.ts:63-99`
- Test: `apps/daemon/src/workflows/templates/routes.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Find the existing create-template test in `apps/daemon/src/workflows/templates/routes.test.ts` for the HTTP shape, then append a test (match the file's existing harness — it builds a Fastify app with a seeded db; reuse its helpers):

```ts
it("rejects a template whose graph has no terminal step", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/workflow-templates",
    headers: authHeaders,
    payload: {
      name: "Bad Graph",
      description: "",
      steps: [
        { id: "a", name: "A", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
        { id: "b", name: "B", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
      ],
      guardrails: [],
      graph: {
        nodes: [
          { id: "a", type: "step", name: "A", stepId: "a" },
          { id: "b", type: "step", name: "B", stepId: "b" },
        ],
        edges: [{ from: "a", to: "b" }],
        positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
      },
    },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_graph");
  expect(res.json().issues.join(" ")).toContain("exactly one terminal step is required");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- templates/routes.test.ts -t "no terminal step"`
Expected: FAIL — the route returns 201 (no graph validation today).

- [ ] **Step 3: Add blocking validation to both routes**

In `apps/daemon/src/workflows/templates/routes.ts`, add the import near the top:

```ts
import { validateGraph, validateSchemaReferences } from "../graph/validate-graph.js";
```

In the POST handler (after `const parsed = CreateWorkflowTemplateRequest.safeParse(...)` succeeds and before `createCustomTemplate`), insert:

```ts
if (parsed.data.graph) {
  const issues = [
    ...validateGraph(parsed.data.graph, normalizeStepsForValidation(parsed.data.steps)),
    ...validateSchemaReferences(parsed.data.graph, normalizeStepsForValidation(parsed.data.steps)),
  ];
  if (issues.length > 0) {
    reply.status(400);
    return { error: "invalid_graph", issues };
  }
}
```

Add the same block to the PATCH handler before `updateCustomTemplate`. Add this helper at the bottom of the file (the request steps carry an optional `ordinal`; validation needs a concrete one):

```ts
function normalizeStepsForValidation(
  steps: CreateWorkflowTemplateRequest["steps"]
): WorkflowStepTemplate[] {
  return steps.map((s, i) => ({ ...s, ordinal: s.ordinal ?? i })) as WorkflowStepTemplate[];
}
```

Add the type imports if not present:

```ts
import type { CreateWorkflowTemplateRequest, WorkflowStepTemplate } from "@orca/contracts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- templates/routes.test.ts`
Expected: PASS, including pre-existing tests (a graph-less create still 201s).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/routes.ts apps/daemon/src/workflows/templates/routes.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): reject invalid workflow graphs on template save

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Migration — node cursor, traversal counter, gate-decision table

**Files:**
- Create: `apps/daemon/migrations/0029_workflow_graph_cursor.sql`
- Modify: `apps/daemon/src/migrations.ts:41` (append registration)
- Test: `apps/daemon/src/migrations.test.ts` (extend the registered-list assertion if present) — verify by running the migration suite

- [ ] **Step 1: Write the migration file**

Create `apps/daemon/migrations/0029_workflow_graph_cursor.sql`:

```sql
-- 0029_workflow_graph_cursor.sql
-- Run-level graph cursor: when current_node_kind = 'gate', current_step_run_id is NULL.
ALTER TABLE workflow_runs ADD COLUMN current_node_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN current_node_kind TEXT;
ALTER TABLE workflow_runs ADD COLUMN traversal_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workflow_gate_decisions (
  id                      TEXT PRIMARY KEY,
  goal_id                 TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,
  traversal_seq           INTEGER NOT NULL,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('approved','rejected')),
  reason                  TEXT NOT NULL,
  selected_edge_to        TEXT NOT NULL,
  inputs_considered_json  TEXT NOT NULL DEFAULT '[]',
  issue_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_workflow_gate_decisions_run
  ON workflow_gate_decisions(workflow_run_id, created_at DESC);
CREATE UNIQUE INDEX idx_workflow_gate_decisions_seq
  ON workflow_gate_decisions(workflow_run_id, node_id, traversal_seq);
```

- [ ] **Step 2: Register the migration**

In `apps/daemon/src/migrations.ts`, append after `"0028_step_revision_signals.sql",`:

```ts
  "0029_workflow_graph_cursor.sql",
```

If `apps/daemon/src/migrations.test.ts` asserts the exact registered list/count, update it to include `0029_workflow_graph_cursor.sql`.

- [ ] **Step 3: Run the migration test to verify it fails or passes**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts`
Expected: PASS (fresh DB applies 0029 cleanly). If the test asserts a count, it FAILS first — bump it, then PASS.

- [ ] **Step 4: Verify the schema with a smoke check**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts -t "applies"`
Expected: PASS — no SQL syntax errors; `workflow_gate_decisions` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0029_workflow_graph_cursor.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): graph cursor columns and gate-decision table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Gate-decision usecases + run cursor projection

**Files:**
- Create: `apps/daemon/src/workflows/gates/usecases.ts`
- Create: `apps/daemon/src/workflows/gates/projection.ts`
- Test: `apps/daemon/src/workflows/gates/usecases.test.ts`
- Modify: `apps/daemon/src/workflows/runs/projection.ts` (surface cursor columns on the row read)

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/gates/usecases.test.ts` (mirror the in-memory DB setup used by `runs/usecases.test.ts` — open a `better-sqlite3` `:memory:` db, run all migrations, insert a goal + run):

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../migrations.js";
import { nextTraversalSeq, recordGateDecision } from "./usecases.js";
import { listGateDecisionsForRun } from "./projection.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  db.prepare("INSERT INTO goals (id, title, description, created_at, updated_at) VALUES ('g','G','',  '2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','2026-06-12T00:00:00.000Z')"
  ).run();
});

describe("nextTraversalSeq", () => {
  it("increments and persists the per-run counter", () => {
    expect(nextTraversalSeq(db, "r")).toBe(1);
    expect(nextTraversalSeq(db, "r")).toBe(2);
  });
});

describe("recordGateDecision", () => {
  it("inserts an immutable gate decision row", () => {
    const seq = nextTraversalSeq(db, "r");
    recordGateDecision(db, () => "2026-06-12T00:00:01.000Z", {
      id: "gd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "gate",
      traversalSeq: seq,
      outcome: "rejected",
      reason: "validation failed",
      selectedEdgeTo: "execution",
      inputsConsidered: ["validation"],
      issueRefs: ["issue-1"],
    });
    const decisions = listGateDecisionsForRun(db, "r");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ nodeId: "gate", outcome: "rejected", selectedEdgeTo: "execution" });
  });

  it("rejects a duplicate (run, node, traversalSeq)", () => {
    const args = {
      id: "gd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "gate",
      traversalSeq: 1,
      outcome: "approved" as const,
      reason: "ok",
      selectedEdgeTo: "done",
      inputsConsidered: [],
      issueRefs: [],
    };
    recordGateDecision(db, () => "2026-06-12T00:00:01.000Z", args);
    expect(() => recordGateDecision(db, () => "2026-06-12T00:00:02.000Z", { ...args, id: "gd2" })).toThrow();
  });
});
```

> Confirm the exact `applyMigrations` export name in `apps/daemon/src/migrations.ts` and the `goals` insert column list against `0001_init.sql` before running; adjust the two `INSERT`s to match real NOT NULL columns.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gates/usecases.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Write the usecases and projection**

Create `apps/daemon/src/workflows/gates/usecases.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface GateDecisionInput {
  id?: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  issueRefs: string[];
}

/** Atomically increments and returns the per-run traversal counter. */
export function nextTraversalSeq(db: Database.Database, runId: string): number {
  return db.transaction(() => {
    db.prepare("UPDATE workflow_runs SET traversal_seq = traversal_seq + 1 WHERE id = ?").run(runId);
    const row = db.prepare("SELECT traversal_seq FROM workflow_runs WHERE id = ?").get(runId) as
      | { traversal_seq: number }
      | undefined;
    if (!row) throw new Error(`workflow run not found: ${runId}`);
    return row.traversal_seq;
  })();
}

export function recordGateDecision(
  db: Database.Database,
  now: () => string,
  input: GateDecisionInput
): string {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO workflow_gate_decisions
       (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason,
        selected_edge_to, inputs_considered_json, issue_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.goalId,
    input.workflowRunId,
    input.nodeId,
    input.traversalSeq,
    input.outcome,
    input.reason.slice(0, 1024),
    input.selectedEdgeTo,
    JSON.stringify(input.inputsConsidered),
    JSON.stringify(input.issueRefs),
    now()
  );
  return id;
}
```

Create `apps/daemon/src/workflows/gates/projection.ts`:

```ts
import type Database from "better-sqlite3";

export interface GateDecisionRecord {
  id: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  issueRefs: string[];
  createdAt: string;
}

interface Row {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  node_id: string;
  traversal_seq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selected_edge_to: string;
  inputs_considered_json: string;
  issue_refs_json: string;
  created_at: string;
}

export function listGateDecisionsForRun(
  db: Database.Database,
  runId: string
): GateDecisionRecord[] {
  const rows = db
    .prepare("SELECT * FROM workflow_gate_decisions WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(runId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    goalId: r.goal_id,
    workflowRunId: r.workflow_run_id,
    nodeId: r.node_id,
    traversalSeq: r.traversal_seq,
    outcome: r.outcome,
    reason: r.reason,
    selectedEdgeTo: r.selected_edge_to,
    inputsConsidered: JSON.parse(r.inputs_considered_json),
    issueRefs: JSON.parse(r.issue_refs_json),
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- gates/usecases.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/gates/
git commit -m "$(cat <<'EOF'
feat(daemon): gate decision persistence and traversal counter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Set the node cursor on initial step entry and on every step insert

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts:180-221` (`insertStep`) and `:223-245` (`createInitialStep`)
- Test: `apps/daemon/src/workflows/steps/usecases.test.ts` (extend)

**Why:** the cursor (`current_node_id`/`current_node_kind`) must always track the active node so gate routing and restart recovery have a single source of truth. For a step, the cursor node id is the step's graph node id, which equals the step template id under the current 1:1 node↔step convention.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/workflows/steps/usecases.test.ts` (reuse the file's existing run/template fixture helpers):

```ts
it("sets the node cursor when the initial step is created", () => {
  // Arrange: a run whose template's first step id is 'intake' (use the file's existing seed helper)
  const run = seedRunWithTemplate(db); // existing helper in this test file
  createInitialStep(db, () => "2026-06-12T00:00:00.000Z", run.id);
  const row = db.prepare("SELECT current_node_id, current_node_kind FROM workflow_runs WHERE id = ?").get(run.id) as {
    current_node_id: string | null;
    current_node_kind: string | null;
  };
  expect(row.current_node_kind).toBe("step");
  expect(row.current_node_id).toBeTruthy();
});
```

> If `seedRunWithTemplate` does not exist, replicate the existing arrange block from a nearby test in the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts -t "node cursor when the initial step"`
Expected: FAIL — `current_node_kind` is null (only `current_step_run_id` is set today).

- [ ] **Step 3: Update `insertStep` to set the cursor**

In `apps/daemon/src/workflows/steps/usecases.ts`, `insertStep` currently runs:

```ts
db.prepare("UPDATE workflow_runs SET current_step_run_id = ? WHERE id = ?").run(id, runId);
```

Add a `nodeId` parameter to `insertStep` (default to `templateStepId` for the 1:1 convention) and replace that line:

```ts
db.prepare(
  "UPDATE workflow_runs SET current_step_run_id = ?, current_node_id = ?, current_node_kind = 'step' WHERE id = ?"
).run(id, nodeId ?? templateStepId, runId);
```

Thread the `nodeId` through `createInitialStep`, `advanceToNextStep`, and `retryStep` call sites (pass the step's graph node id when known; otherwise `templateStepId`). For now all three pass `templateStepId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts`
Expected: PASS (existing step tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/steps/usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): track run node cursor on step entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Revisit attempt numbering (max + 1)

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts` (add `nextAttemptForStep`; use it where a step node is (re)entered by routing)
- Test: `apps/daemon/src/workflows/steps/usecases.test.ts` (extend)

**Why:** the unique index `(workflow_run_id, step_template_id, attempt)` makes a naive second `attempt = 1` insert throw. A revisit must use `max(attempt) + 1`.

- [ ] **Step 1: Write the failing test**

```ts
it("computes the next attempt as max(existing) + 1 for a revisited step", () => {
  const run = seedRunWithTemplate(db);
  // first attempt
  insertStepForTest(db, run.id, "execution", 1); // helper that inserts a step run row
  // second attempt via the routing helper under test
  const attempt = nextAttemptForStep(db, run.id, "execution");
  expect(attempt).toBe(2);
});
```

> `insertStepForTest` can be a 3-line helper in the test that inserts a `workflow_step_runs` row with a unique fingerprint; or reuse the existing insert path.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts -t "next attempt as max"`
Expected: FAIL — `nextAttemptForStep` is not exported.

- [ ] **Step 3: Write the helper**

Add to `apps/daemon/src/workflows/steps/usecases.ts`:

```ts
export function nextAttemptForStep(
  db: Database.Database,
  runId: string,
  stepTemplateId: string
): number {
  const row = db
    .prepare(
      "SELECT MAX(attempt) AS max FROM workflow_step_runs WHERE workflow_run_id = ? AND step_template_id = ?"
    )
    .get(runId, stepTemplateId) as { max: number | null };
  return (row.max ?? 0) + 1;
}
```

This is consumed by the graph-routing advance path in Task 11 (forward routing to an already-visited node) and by gate backward routing in Task 13.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/steps/usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): compute revisit attempt as max+1

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Route step→step/gate through the graph engine (free function)

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts:274-349` (`advanceToNextStep`)
- Test: `apps/daemon/src/workflows/steps/usecases.test.ts` (extend)

**Why:** replace `template.steps.find(s => s.ordinal === current.ordinal + 1)` with graph traversal. The free function handles the **step → step** and **terminal** cases and reports when the next node is a gate so the orchestrator (Task 13) can evaluate it. Step → gate does not advance here; it returns a sentinel.

- [ ] **Step 1: Write the failing test**

```ts
it("advances to the graphed next step rather than the next ordinal", () => {
  // Template with a graph whose 'analysis' node points to 'execution' but execution has a HIGHER ordinal gap
  const run = seedRunWithGraph(db, /* graph routing analysis -> execution */);
  const next = advanceToNextStep(db, () => NOW, run.currentStepRunId!);
  expect(next?.stepTemplateId).toBe("execution");
});

it("returns a gate sentinel when the next node is a gate", () => {
  const run = seedRunAtValidationStep(db); // validation -> gate edge
  const result = advanceToNextStepOrGate(db, () => NOW, run.currentStepRunId!);
  expect(result).toEqual({ kind: "gate", nodeId: "gate" });
});

it("completes the run when advancing from the terminal step", () => {
  const run = seedRunAtTerminalStep(db);
  const next = advanceToNextStep(db, () => NOW, run.currentStepRunId!);
  expect(next).toBeNull();
  const after = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(run.id) as { status: string };
  expect(after.status).toBe("completed");
});
```

> Build the `seedRun*` helpers in the test by inserting a template with a `graph` JSON and a run positioned at the relevant step. Reuse `effectiveGraph` semantics: a null graph still behaves linearly, so existing ordinal-based tests must keep passing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts -t "graphed next step"`
Expected: FAIL — advancement is still ordinal-based; `advanceToNextStepOrGate` does not exist.

- [ ] **Step 3: Rework the advance path**

In `apps/daemon/src/workflows/steps/usecases.ts`, import the engine:

```ts
import { effectiveGraph, resolveStepNext } from "../graph/graph-routing.js";
```

Introduce `advanceToNextStepOrGate` that the orchestrator calls, and keep `advanceToNextStep` as a thin wrapper for the existing call sites/tests that never hit a gate. Replace the body that computes `next` (currently lines ~295-347) so that, after marking the current step `passed` and emitting `workflow.step.completed`:

```ts
const graph = effectiveGraph(template.graph, template.steps);
const currentNodeId = current.stepTemplateId; // 1:1 node↔step convention
const dest = resolveStepNext(graph, currentNodeId);

if (dest.kind === "terminal") {
  // unchanged run-completion block: set run completed, clear cursor, emit workflow.run.completed
  db.prepare(
    "UPDATE workflow_runs SET status = 'completed', finished_at = ?, current_step_run_id = NULL, current_node_id = NULL, current_node_kind = NULL, blocked_reason = NULL WHERE id = ?"
  ).run(timestamp, current.workflowRunId);
  // ...existing goals update + emit "workflow.run.completed"...
  return null;
}

if (dest.kind === "gate") {
  // Park the cursor on the gate; the orchestrator evaluates it (Task 13).
  db.prepare(
    "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'gate' WHERE id = ?"
  ).run(dest.nodeId, current.workflowRunId);
  return null;
}

// dest.kind === "step": insert the next step node (revisit-safe attempt number).
const nextStepTemplateId = graphStepTemplateId(graph, dest.nodeId);
const attempt = nextAttemptForStep(db, current.workflowRunId, nextStepTemplateId);
return insertStep(
  db, now, current.goalId, current.workflowRunId, nextStepTemplateId,
  ordinalForStep(template, nextStepTemplateId), attempt, eventOptions, dest.nodeId
);
```

Add two small helpers in the same file:

```ts
import type { WorkflowGraph } from "@orca/contracts";

function graphStepTemplateId(graph: WorkflowGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "step") throw new Error(`not a step node: ${nodeId}`);
  return node.stepId ?? node.id;
}

function ordinalForStep(template: { steps: { id: string; ordinal: number }[] }, stepId: string): number {
  return template.steps.find((s) => s.id === stepId)?.ordinal ?? 0;
}
```

To distinguish "advanced to a gate" from "completed," return a richer result from the orchestrator-facing entry point. Add:

```ts
export type AdvanceResult =
  | { kind: "step"; stepRun: WorkflowStepRunT }
  | { kind: "gate"; nodeId: string }
  | { kind: "completed" };

export function advanceToNextStepOrGate(
  db: Database.Database,
  now: () => string,
  currentStepRunId: string,
  eventOptions?: StepEventOptions,
  suppliedStepResult?: WorkflowStepResult
): AdvanceResult {
  // same transaction body as above, but return the tagged result instead of null/stepRun
}
```

Keep `advanceToNextStep` delegating to `advanceToNextStepOrGate` and mapping `{kind:"step"} -> stepRun`, `{kind:"gate"|"completed"} -> null`, so existing callers/tests are unaffected when no gate is present.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- steps/usecases.test.ts`
Expected: PASS, including all pre-existing ordinal-based tests (null graph → linear).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/steps/usecases.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): graph-driven step advancement with gate sentinel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Gate evaluation through the transport broker

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`
- Test: `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`
- Modify: `packages/contracts/src/workflows/index.ts` — add `evaluate_gate` to `OrchestrationDecisionKind` and `WorkflowDecisionType`; add `GateEvaluationRequest`/`GateEvaluationProposal` schemas

**Why:** mirror `step-result-scoring.ts` (already the canonical broker pattern): build an `OrchestrationRequest`, call `broker.propose` with a `validateProposal` that constrains the outcome to `approved`/`rejected`.

- [ ] **Step 1: Add the contract pieces (write failing contract test first)**

Append to `packages/contracts/src/workflows/graph-contract.test.ts`:

```ts
import { GateEvaluationProposal, OrchestrationDecisionKind } from "./index.js";

describe("gate evaluation contract", () => {
  it("includes evaluate_gate in the decision kinds", () => {
    expect(OrchestrationDecisionKind.options).toContain("evaluate_gate");
  });

  it("parses a valid gate proposal", () => {
    const p = GateEvaluationProposal.parse({
      outcome: "rejected",
      reason: "tests failed",
      issueRefs: ["i1"],
      inputsConsidered: ["validation"],
    });
    expect(p.outcome).toBe("rejected");
  });

  it("rejects an outcome outside approved/rejected", () => {
    expect(() => GateEvaluationProposal.parse({ outcome: "maybe", reason: "x", inputsConsidered: [] })).toThrow();
  });
});
```

Run: `pnpm --filter @orca/contracts test -- graph-contract.test.ts -t "gate evaluation"` → FAIL.

In `packages/contracts/src/workflows/index.ts`:
- Add `"evaluate_gate"` to the `OrchestrationDecisionKind` enum (line ~143) and to `WorkflowDecisionType` (line ~193).
- Add schemas near `StepResultScoringProposal`:

```ts
export const GateEvaluationProposal = z
  .object({
    outcome: z.enum(["approved", "rejected"]),
    reason: z.string().min(1).max(1024),
    issueRefs: z.array(z.string().min(1).max(128)).max(50).optional(),
    inputsConsidered: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export type GateEvaluationProposal = z.infer<typeof GateEvaluationProposal>;

export const GateEvaluationRequest = z
  .object({
    gate: z.object({ nodeId: Id100, name: z.string().max(100), instructions: z.string().max(WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS) }).strict(),
    goal: z.object({ id: Id, description: z.string().max(4000) }).strict(),
    sourceStepOutput: z.record(z.unknown()).nullable(),
    priorGateDecisions: z.array(z.object({ nodeId: Id100, outcome: z.enum(["approved", "rejected"]), reason: z.string().max(1024) }).strict()).max(50),
    availableOutcomes: z.array(z.enum(["approved", "rejected"])).min(1).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GateEvaluationRequest too large" });
    }
  });
export type GateEvaluationRequest = z.infer<typeof GateEvaluationRequest>;
```

Run the contract test again → PASS. Commit contracts:

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(contracts): gate evaluation request/proposal schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Write the failing gate-evaluation test**

Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts` (model on `step-result-scoring`'s broker usage — fake a broker whose `propose` calls `validateProposal` with the model's raw output):

```ts
import { describe, expect, it } from "vitest";
import { evaluateGate } from "./gate-evaluation.js";

function fakeBroker(raw: unknown) {
  return {
    propose: async (_req: unknown, opts: { validateProposal: (r: unknown) => unknown }) => {
      const v = opts.validateProposal(raw) as { accepted: boolean; parsed?: unknown; failureMessage?: string };
      return v.accepted ? { status: "proposed" as const, parsed: v.parsed } : { status: "rejected" as const };
    },
  };
}

const baseInput = {
  goalId: "g",
  workflowRunId: "r",
  providerId: "orca/anthropic" as const,
  modelId: "claude-opus-4-8",
  goal: { id: "g", description: "build" },
  gate: { nodeId: "gate", name: "Release Readiness", instructions: "approve when passed" },
  sourceStepOutput: { verdict: "passed" },
  priorGateDecisions: [],
  availableOutcomes: ["approved", "rejected"] as const,
};

describe("evaluateGate", () => {
  it("returns the validated approved outcome", async () => {
    const broker = fakeBroker({ outcome: "approved", reason: "all green", inputsConsidered: ["validation"] });
    const res = await evaluateGate({ broker }, baseInput);
    expect(res).toEqual({ ok: true, decision: { outcome: "approved", reason: "all green", issueRefs: [], inputsConsidered: ["validation"] } });
  });

  it("fails when the model returns an unpermitted outcome", async () => {
    const broker = fakeBroker({ outcome: "maybe", reason: "x", inputsConsidered: [] });
    const res = await evaluateGate({ broker }, baseInput);
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Write the implementation**

Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`:

```ts
import {
  GateEvaluationProposal,
  GateEvaluationRequest,
  OrchestrationRequest,
  type ModelProviderId,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";

export interface GateEvaluationDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
}

export interface GateEvaluationInput {
  goalId: string;
  workflowRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  goal: { id: string; description: string };
  gate: { nodeId: string; name: string; instructions: string };
  sourceStepOutput: Record<string, unknown> | null;
  priorGateDecisions: { nodeId: string; outcome: "approved" | "rejected"; reason: string }[];
  availableOutcomes: ReadonlyArray<"approved" | "rejected">;
}

export type GateEvaluationResult =
  | { ok: true; decision: GateEvaluationProposal & { issueRefs: string[] } }
  | { ok: false; reason: string };

export async function evaluateGate(
  deps: GateEvaluationDeps,
  input: GateEvaluationInput
): Promise<GateEvaluationResult> {
  const requestPayload = GateEvaluationRequest.parse({
    gate: input.gate,
    goal: input.goal,
    sourceStepOutput: input.sourceStepOutput,
    priorGateDecisions: input.priorGateDecisions,
    availableOutcomes: [...input.availableOutcomes],
  });

  const request = OrchestrationRequest.parse({
    kind: "evaluate_gate",
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: null,
    providerId: input.providerId,
    modelId: input.modelId,
    payload: requestPayload,
  });

  const permitted = new Set(input.availableOutcomes);
  let lastFailure: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.broker.propose(request, {
      validateProposal: (raw) => {
        const parsed = GateEvaluationProposal.safeParse(raw);
        if (!parsed.success) {
          lastFailure = "invalid gate proposal structure";
          return { accepted: false, failureMessage: lastFailure };
        }
        if (!permitted.has(parsed.data.outcome)) {
          lastFailure = `outcome '${parsed.data.outcome}' is not permitted`;
          return { accepted: false, failureMessage: lastFailure };
        }
        return {
          accepted: true,
          parsed: { ...parsed.data, issueRefs: parsed.data.issueRefs ?? [] },
        };
      },
    });
    if (result.status !== "proposed") continue;
    return { ok: true, decision: result.parsed as GateEvaluationProposal & { issueRefs: string[] } };
  }

  return { ok: false, reason: lastFailure ?? "gate evaluation produced no proposal" };
}
```

- [ ] **Step 5: Run test, then commit**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation.test.ts` → PASS.

```bash
git add apps/daemon/src/workflows/orchestrator/gate-evaluation.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): broker-driven gate evaluation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire gate execution into the orchestrator advance path

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` — `commitAdvanceOrComplete` (lines 2105-2214) and `advanceToNextStep` method (lines 1239-1275)
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (extend) or a new `service.gate-routing.test.ts`

**Why:** `commitAdvanceOrComplete` currently checks `template.steps.find(s => s.ordinal === stepRun.ordinal + 1)`. Replace that branch with the tagged result from `advanceToNextStepOrGate`. When the result is a gate, evaluate it, record the decision, increment `traversal_seq`, move the cursor to the destination, and recurse; when the destination is a backward step, the engine's `nextAttemptForStep` already yields a fresh attempt.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts`. Construct an `OrchestratorService` with a fake broker that returns `{ outcome: "approved", ... }`, a template whose graph is `analysis → execution → validation → gate (approved→done terminal, rejected→execution)`, and drive a run to the validation step's completion. Assert:

```ts
it("routes through a gate and approves to the terminal step", async () => {
  // ... arrange run positioned at validation with a step_output artifact ...
  await service.requestNextDecision(db, () => NOW, run.id, { bus });
  const decisions = listGateDecisionsForRun(db, run.id);
  expect(decisions.at(-1)).toMatchObject({ outcome: "approved", selectedEdgeTo: "done" });
  const runAfter = getWorkflowRunById(db, run.id)!;
  // 'done' is terminal -> mark_run_complete recommendation, run still active until user approves
  expect(runAfter.currentNodeKind).toBe("step");
});

it("routes a rejected gate backward to a fresh Execution attempt", async () => {
  const reject = makeService({ outcome: "rejected", reason: "bug", issueRefs: ["i1"], inputsConsidered: ["validation"] });
  // ... drive validation completion ...
  await reject.service.requestNextDecision(db, () => NOW, run.id, { bus });
  const execRuns = db.prepare("SELECT attempt FROM workflow_step_runs WHERE workflow_run_id=? AND step_template_id='execution' ORDER BY attempt").all(run.id);
  expect(execRuns.map((r:any)=>r.attempt)).toEqual([1, 2]);
});
```

> Reuse the existing service test harness (`service.agent-step.test.ts` shows how the service, fake broker/operators/launcher are assembled). Add a `graph` to the seeded template.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts`
Expected: FAIL — gates are not evaluated; advancement is ordinal-based.

- [ ] **Step 3: Implement the gate branch**

In `service.ts`, add imports:

```ts
import { advanceToNextStepOrGate } from "../steps/usecases.js";
import { effectiveGraph, resolveGateNext } from "../graph/graph-routing.js";
import { evaluateGate } from "./gate-evaluation.js";
import { nextTraversalSeq, recordGateDecision } from "../gates/usecases.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
```

In `commitAdvanceOrComplete`, replace the `const nextStepTpl = template.steps.find(...)` branch logic with a loop that consumes the tagged advance result. Concretely:

1. Call `advanceToNextStepOrGate(db, advanceNow, stepRun.id, {...eventOptions}, suppliedStepResult)` inside the existing staged-events transaction (it already marks the current step passed + emits completion).
2. `switch (result.kind)`:
   - `"step"`: behaves like today — recurse via `requestNextDecision` so the new step's agent is selected/spawned.
   - `"completed"`: unchanged (run already set to completed by the engine; emit nothing further).
   - `"gate"`: call the new private method `evaluateAndRouteGate(db, now, { run, template, goal, gateNodeId: result.nodeId, sourceStepOutput }, options)`, then recurse.

Add the private method:

```ts
private async evaluateAndRouteGate(
  db: Database.Database,
  now: () => string,
  ctx: { run: WorkflowRunT; template: WorkflowTemplateT; goal: GoalRow; gateNodeId: string; sourceStepOutput: Record<string, unknown> | null },
  options: RequestNextDecisionOptions
): Promise<void> {
  const graph = effectiveGraph(ctx.template.graph, ctx.template.steps);
  const gateNode = graph.nodes.find((n) => n.id === ctx.gateNodeId && n.type === "gate");
  if (!gateNode) {
    await this.blockRunById(db, now, ctx.run.id, "gate node missing", options);
    return;
  }

  const evaluation = await evaluateGate(
    { broker: this.broker },
    {
      goalId: ctx.goal.id,
      workflowRunId: ctx.run.id,
      providerId: ctx.goal.orchestrator_provider ?? "orca/anthropic",
      modelId: ctx.goal.orchestrator_model ?? "claude-opus-4-8",
      goal: { id: ctx.goal.id, description: ctx.goal.description },
      gate: { nodeId: gateNode.id, name: gateNode.name, instructions: gateNode.instructions ?? gateNode.condition ?? "" },
      sourceStepOutput: ctx.sourceStepOutput,
      priorGateDecisions: listGateDecisionsForRun(db, ctx.run.id).map((d) => ({ nodeId: d.nodeId, outcome: d.outcome, reason: d.reason })),
      availableOutcomes: ["approved", "rejected"],
    }
  );

  if (!evaluation.ok) {
    // Invalid gate decisions retry gate evaluation on the next tick; block to surface it.
    await this.blockRunById(db, now, ctx.run.id, `gate evaluation failed: ${evaluation.reason}`, options);
    return;
  }

  const dest = resolveGateNext(graph, gateNode.id, evaluation.decision.outcome);
  const destStepTemplateId = dest.kind === "step" ? graphStepTemplateId(graph, dest.nodeId) : null;

  const seq = nextTraversalSeq(db, ctx.run.id);
  recordGateDecision(db, now, {
    goalId: ctx.goal.id,
    workflowRunId: ctx.run.id,
    nodeId: gateNode.id,
    traversalSeq: seq,
    outcome: evaluation.decision.outcome,
    reason: evaluation.decision.reason,
    selectedEdgeTo: dest.kind === "step" ? dest.nodeId : dest.nodeId,
    inputsConsidered: evaluation.decision.inputsConsidered,
    issueRefs: evaluation.decision.issueRefs,
  });
  // Record a workflow_decisions trace row of type 'evaluate_gate' (reuse recordDecisionInTx with a gate fingerprint that includes seq).

  if (dest.kind === "gate") {
    // Gate -> gate: move cursor and recurse on the next gate.
    db.prepare("UPDATE workflow_runs SET current_node_id=?, current_node_kind='gate', current_step_run_id=NULL WHERE id=?").run(dest.nodeId, ctx.run.id);
    await this.evaluateAndRouteGate(db, now, { ...ctx, gateNodeId: dest.nodeId }, options);
    return;
  }

  // dest.kind === "step": insert a fresh attempt of the destination step and spawn it.
  const attempt = nextAttemptForStep(db, ctx.run.id, destStepTemplateId!);
  const nextStepRun = insertStepViaEngine(db, now, ctx.run, destStepTemplateId!, dest.nodeId, attempt, options);
  const nextTpl = ctx.template.steps.find((s) => s.id === destStepTemplateId);
  if (nextTpl) {
    await this.spawnStepAgent(db, now, { run: getWorkflowRunById(db, ctx.run.id)!, stepRun: readStepRun(db, nextStepRun.id), stepTpl: nextTpl, template: ctx.template, goal: ctx.goal }, options);
  }
}
```

> `insertStepViaEngine` is a thin call into the exported `insertStep`/`retryStep` path from `steps/usecases.ts`; export a helper `insertStepForRouting(db, now, runId, stepTemplateId, nodeId, attempt, eventOptions)` from that module (it wraps the private `insertStep`). `blockRunById` is a small wrapper over the existing `blockRun(db, now, ctx, reason, options)` that first loads the ctx; if `blockRun` already takes a runId-friendly shape, reuse it directly. Confirm `graphStepTemplateId` is exported from `steps/usecases.ts` (Task 11) or re-derive inline from the graph node.

Also update the orchestrator's **terminal detection**: the `commitAdvanceOrComplete` "final step" branch (which produces `mark_run_complete`) must trigger when `advanceToNextStepOrGate` reports the *current* step is terminal, not when there is no higher ordinal. Have `advanceToNextStepOrGate` NOT auto-complete the run for a terminal step; instead return `{ kind: "completed-terminal", stepRun }` so the orchestrator runs the existing `mark_run_complete` recommendation block (preserving the human yield, Task 14).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts`
Expected: PASS. Then run the whole orchestrator suite to catch regressions: `pnpm --filter @orca/daemon test -- workflows/orchestrator`.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): evaluate gates and route their outcomes at runtime

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Terminal step preserves the mark-done yield

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts` (`advanceToNextStepOrGate` terminal handling) and `apps/daemon/src/workflows/orchestrator/service.ts` (`commitAdvanceOrComplete` terminal branch)
- Test: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts` (extend)

**Why:** the explicit `terminal` flag must drive the same `mark_run_complete` decision + `complete_workflow_run` recommendation that "no higher ordinal" produces today — not silent auto-completion.

- [ ] **Step 1: Write the failing test**

```ts
it("emits a mark_run_complete recommendation when the terminal step finishes, without completing the run", async () => {
  // drive a run to the terminal 'done' step completion (graph: gate approved -> done[terminal])
  const out = await service.requestNextDecision(db, () => NOW, run.id, { bus });
  expect(out.recommendationIds.length).toBe(1);
  const recType = db.prepare("SELECT type FROM recommendations WHERE id = ?").get(out.recommendationIds[0]) as { type: string };
  expect(recType.type).toBe("complete_workflow_run");
  const runAfter = getWorkflowRunById(db, run.id)!;
  expect(runAfter.status).toBe("active"); // not completed until user approves
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts -t "mark_run_complete"`
Expected: FAIL if the terminal step auto-completes the run (engine called `complete`).

- [ ] **Step 3: Make terminal route to the existing completion-recommendation branch**

Ensure `advanceToNextStepOrGate`, on a terminal step, does **not** set the run to `completed`. Instead it returns `{ kind: "completed-terminal", stepRun }` (the current step stays `passed`, run stays `active`, cursor unchanged). In `commitAdvanceOrComplete`, route `completed-terminal` into the existing block that calls `appendDecisionRequested` + `recordDecisionInTx(decisionType: "mark_run_complete")` + `createRecommendationForWorkflowInTx(type: "complete_workflow_run")` (lines 2148-2213, unchanged). The user's existing accept-recommendation path then calls `completeWorkflowRun`, which already clears the cursor — extend it to also null `current_node_id`/`current_node_kind`.

In `apps/daemon/src/workflows/runs/usecases.ts` `completeWorkflowRun`, update the UPDATE to also clear the node cursor:

```ts
"UPDATE workflow_runs SET status = 'completed', finished_at = ?, current_node_id = NULL, current_node_kind = NULL WHERE id = ?"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/runs/usecases.ts apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): terminal step preserves the mark-done approval yield

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Supervised-mode gate pause

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`evaluateAndRouteGate`)
- Test: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts` (extend)

**Why:** in `supervised` mode (the default) every step completion pauses at a Continue checkpoint; a gate decision must surface the same way before moving the cursor.

- [ ] **Step 1: Write the failing test**

```ts
it("pauses a gate decision for confirmation in supervised mode", async () => {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('supervision_mode', '\"supervised\"')").run();
  await service.requestNextDecision(db, () => NOW, run.id, { bus });
  // gate decision recorded, but the destination step is NOT yet spawned/active
  const decisions = listGateDecisionsForRun(db, run.id);
  expect(decisions).toHaveLength(1);
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE goal_id = ?").get("g") as { c: number };
  expect(sessions.c).toBe(0); // destination agent not launched until Continue
});
```

> Confirm the `app_settings` row shape against `0026_app_settings.sql` and `settings/store.ts` (`getSupervisionMode`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts -t "supervised"`
Expected: FAIL — the gate routes straight through and spawns the destination.

- [ ] **Step 3: Add the supervised branch**

In `evaluateAndRouteGate`, after recording the gate decision and computing `dest`, before inserting/spawning the destination step:

```ts
if (getSupervisionMode(db) === "supervised") {
  const activityCtx = { db, bus: options.bus ?? new EventBus() };
  const summary = `Gate "${gateNode.name}": ${evaluation.decision.outcome} — ${evaluation.decision.reason}`;
  openOrUpdateLive(activityCtx, {
    goalId: ctx.goal.id,
    workflowRunId: ctx.run.id,
    stepRunId: null,
    agentSessionId: null,
    sourceKind: "step_started",
    currentText: summary,
    workCategory: null,
  });
  pauseForConfirmation(activityCtx, { stepRunId: ctx.run.id, summary });
  return; // the existing Continue path resumes routing
}
```

The Continue handler (`confirmStep`) must, when the paused row is a gate (no step run), resume by re-entering `evaluateAndRouteGate`'s post-decision routing. Add a `pending_gate_route_json` stash on `workflow_runs` (small column) recording `{ gateNodeId, outcome, destNodeId, traversalSeq }` so Continue is deterministic and idempotent, mirroring the step `pending_completion_json` pattern. (Add the column in migration 0029 — go back and append `ALTER TABLE workflow_runs ADD COLUMN pending_gate_route_json TEXT;` before this task is implemented, since 0029 is not yet released.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.gate-routing.test.ts`
Expected: PASS (supervised pause + unsupervised pass-through both green).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/migrations/0029_workflow_graph_cursor.sql apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): pause gate decisions for confirmation in supervised mode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Graph-aware repair context for revisited steps

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:1356-1381` (`collectPriorStepArtifacts`) and `:1308-1314` (the `composeAgentInitialPrompt` call)
- Test: `apps/daemon/src/workflows/orchestrator/step-input.test.ts` or `service.gate-routing.test.ts` (extend)

**Why:** the current filter `owner.ordinal >= ordinal -> skip` excludes Validation/gate findings (higher ordinal) needed to repair a backward-routed Execution.

- [ ] **Step 1: Write the failing test**

```ts
it("includes the latest downstream step output and the rejecting gate reason on a revisit", () => {
  // Arrange: a run that has been routed gate(rejected) -> execution attempt 2.
  // Validation (higher ordinal) produced a step_output; a gate decision exists with reason "bug in parser".
  const ctx = buildRepairContext(db, run.id, executionAttempt2StepRun);
  expect(ctx.priorStepArtifacts.map((a) => a.stepId)).toContain("validation");
  expect(ctx.rejectingGateReason).toBe("bug in parser");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- -t "downstream step output and the rejecting gate reason"`
Expected: FAIL — validation artifact filtered out by ordinal; no gate reason wired in.

- [ ] **Step 3: Rework context assembly**

Replace `collectPriorStepArtifacts`'s ordinal filter with a traversal-aware selection: include the **most recent** `step_output` artifact per step template that finished before the current step run's `started_at` (use `finished_at`/`created_at` ordering, not ordinal), and additionally fetch the latest `workflow_gate_decisions` row whose `outcome = 'rejected'` for the run. Pass the gate reason + issue refs into `composeAgentInitialPrompt` as a `repairContext` field. Concretely:

```ts
private collectPriorStepArtifacts(
  db: Database.Database,
  runId: string,
  currentStepRunId: string
): Array<{ stepId: string; outputJson: unknown }> {
  const current = readStepRun(db, currentStepRunId);
  const stepRuns = db
    .prepare("SELECT id, step_template_id, started_at, finished_at FROM workflow_step_runs WHERE workflow_run_id = ? AND status = 'passed'")
    .all(runId) as Array<{ id: string; step_template_id: string; started_at: string | null; finished_at: string | null }>;
  // latest passed attempt per template that finished before this attempt started
  const latestByTemplate = new Map<string, { id: string; finished_at: string | null }>();
  for (const s of stepRuns) {
    if (s.id === currentStepRunId) continue;
    if (current.started_at && s.finished_at && s.finished_at > current.started_at) continue;
    const prev = latestByTemplate.get(s.step_template_id);
    if (!prev || (s.finished_at ?? "") > (prev.finished_at ?? "")) latestByTemplate.set(s.step_template_id, s);
  }
  const out: Array<{ stepId: string; outputJson: unknown }> = [];
  for (const [templateId, s] of latestByTemplate) {
    const art = db.prepare("SELECT body FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1").get(s.id) as { body: string } | undefined;
    if (!art) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(art.body); } catch { parsed = art.body; }
    out.push({ stepId: templateId, outputJson: parsed });
  }
  return out;
}

private latestRejectingGate(db: Database.Database, runId: string): { reason: string; issueRefs: string[] } | null {
  const rows = listGateDecisionsForRun(db, runId).filter((d) => d.outcome === "rejected");
  const last = rows.at(-1);
  return last ? { reason: last.reason, issueRefs: last.issueRefs } : null;
}
```

Update the `spawnStepAgent` prompt composition (line ~1308) to pass `repairContext: this.latestRejectingGate(db, ctx.run.id)` and have `composeAgentInitialPrompt` render it when present (add a `repairContext?` param to that composer; render a "Repair context" section with the gate reason + issue refs). Keep `collectPriorStepArtifacts` callers updated to the new `(db, runId, currentStepRunId)` signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- workflows/orchestrator`
Expected: PASS (existing prompt/step-input tests still green; new revisit test passes).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/step-input.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): graph-aware repair context for revisited steps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Restart recovery treats a gate cursor as resumable

**Files:**
- Modify: `apps/daemon/src/workflows/reconcile.ts:54-74` (drift detection)
- Test: `apps/daemon/src/workflows/reconcile.test.ts` (extend)

**Why:** the drift query blocks any active run whose `current_step_run_id` is null. A mid-gate run legitimately has a null step run; it must be resumed, not blocked.

- [ ] **Step 1: Write the failing test**

```ts
it("does not flag a run parked on a gate as drift", () => {
  // Arrange: active run with current_node_kind='gate', current_step_run_id=NULL
  db.prepare("UPDATE workflow_runs SET current_step_run_id=NULL, current_node_id='gate', current_node_kind='gate' WHERE id=?").run(runId);
  reconcileWorkflowsOnBoot(db, () => NOW);
  const after = db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id=?").get(runId) as { status: string; blocked_reason: string | null };
  expect(after.status).toBe("active");
  expect(after.blocked_reason).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- reconcile.test.ts -t "parked on a gate"`
Expected: FAIL — the run gets `blocked` with `daemon_restart_state_drift`.

- [ ] **Step 3: Exclude gate-cursor runs from the drift query**

In `reconcile.ts`, change the drift query (line 56) to ignore runs whose cursor is a gate:

```ts
"SELECT wr.id AS run_id, wr.goal_id AS goal_id FROM workflow_runs wr LEFT JOIN workflow_step_runs ws ON ws.id = wr.current_step_run_id WHERE wr.status = 'active' AND wr.current_node_kind IS NOT 'gate' AND (ws.id IS NULL OR ws.status IN ('passed','failed','skipped'))"
```

(SQLite supports `IS NOT 'gate'`; equivalently `(wr.current_node_kind IS NULL OR wr.current_node_kind <> 'gate')`.) Gate-cursor runs are resumed by re-evaluating the gate on the next `requestNextDecision` tick, which is idempotent because `traversal_seq`/`workflow_gate_decisions` dedupe a committed decision.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- reconcile.test.ts`
Expected: PASS (existing drift tests for step cursors still green).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/reconcile.ts apps/daemon/src/workflows/reconcile.test.ts
git commit -m "$(cat <<'EOF'
fix(daemon): treat a gate-parked run as resumable, not drift

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Desktop — labeled edges and gate ports

**Files:**
- Modify: `apps/desktop/src/workflows/graph-sync.ts:19-23, 82-89`
- Modify: `apps/desktop/src/workflows/WorkflowFlow.tsx:154-156, 187` and the node/port rendering
- Test: `apps/desktop/src/workflows/graph-sync.test.ts` (extend), `WorkflowFlow.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/workflows/graph-sync.test.ts`:

```ts
it("buildInitialGraph emits labeled object edges", () => {
  const g = buildInitialGraph([
    { id: "a", name: "A" } as any,
    { id: "b", name: "B" } as any,
  ]);
  expect(g.edges[0]).toEqual({ from: "a", to: "b" });
});

it("reconcileGraph drops edges whose endpoints were removed, using object edges", () => {
  const g = reconcileGraph(
    [{ id: "a", name: "A" } as any],
    { nodes: [{ id: "a", type: "step", name: "A", stepId: "a" }], edges: [{ from: "a", to: "gone" }], positions: { a: { x: 0, y: 0 } } } as any,
  );
  expect(g.edges).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- graph-sync.test.ts`
Expected: FAIL — edges are tuples.

- [ ] **Step 3: Update graph-sync and WorkflowFlow**

In `graph-sync.ts`:
- `buildInitialGraph` edges (lines 19-23):

```ts
const edges = nodes
  .slice(0, -1)
  .map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
```

- `reconcileGraph` edge filter (lines 82-89):

```ts
const seenEdges = new Set<string>();
const nextEdges = graph.edges.filter((e) => {
  if (!validNodeIds.has(e.from) || !validNodeIds.has(e.to) || e.from === e.to) return false;
  const key = `${e.from}->${e.to}`;
  if (seenEdges.has(key)) return false;
  seenEdges.add(key);
  return true;
});
```

In `WorkflowFlow.tsx`:
- edge existence check + add (lines 154-156):

```ts
const exists = graph.edges.some((e) => e.from === from && e.to === to);
if (!exists) {
  const fromNode = nodes.find((n) => n.id === from);
  const port = fromNode?.type === "gate" ? inferPortForDrag() : undefined;
  onGraphChange({ ...graph, edges: [...graph.edges, port ? { from, to, port } : { from, to }] });
}
```

- edge removal (line 187): filter by reference/index as today but over object edges.
- Gate node rendering: draw two labeled out-ports (`approved`, `rejected`) instead of one; the port the user drags from determines the new edge's `port`. `inferPortForDrag()` returns which gate port handle initiated the drag.
- Edge label rendering: render the `port` text on gate edges; leave step edges unlabeled.

> The exact port-handle wiring depends on the existing pointer-drag model in `WorkflowFlow.tsx` (the `linkDrag` state). Keep the change scoped to: (a) two gate out-handles, (b) tagging the drag with its source port, (c) writing `port` onto the created edge.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- graph-sync.test.ts WorkflowFlow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/graph-sync.ts apps/desktop/src/workflows/WorkflowFlow.tsx apps/desktop/src/workflows/graph-sync.test.ts apps/desktop/src/workflows/WorkflowFlow.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): labeled graph edges and gate approved/rejected ports

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Desktop — gate instructions and step terminal toggle

**Files:**
- Modify: `apps/desktop/src/workflows/NodeDetailModal.tsx` (gate `condition` → `instructions`; add step `terminal` checkbox)
- Test: `apps/desktop/src/workflows/NodeDetailModal.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/workflows/NodeDetailModal.test.tsx`:

```ts
it("edits gate instructions", () => {
  const onChange = vi.fn();
  render(
    <NodeDetailModal
      detail={{ kind: "gate", name: "Gate", instructions: "", onChange }}
      index={0} total={1} onPrev={null} onNext={null} onClose={() => {}} onDelete={() => {}}
    />
  );
  fireEvent.change(screen.getByPlaceholderText(/approve/i), { target: { value: "approve when validation passed" } });
  expect(onChange).toHaveBeenCalledWith({ instructions: "approve when validation passed" });
});

it("toggles a step terminal flag", () => {
  const onChange = vi.fn();
  render(
    <NodeDetailModal
      detail={{ kind: "step", name: "Done", instructions: "", outputSchema: [], terminal: false, onChange }}
      index={0} total={1} onPrev={null} onNext={null} onClose={() => {}} onDelete={() => {}}
    />
  );
  fireEvent.click(screen.getByLabelText(/terminal step/i));
  expect(onChange).toHaveBeenCalledWith({ terminal: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- NodeDetailModal.test.tsx`
Expected: FAIL — the gate body edits `condition`; there is no terminal toggle.

- [ ] **Step 3: Update the modal**

In `NodeDetailModal.tsx`:
- Change the gate `NodeDetail` variant from `{ condition; onChange({condition}) }` to `{ instructions; onChange({instructions}) }`.
- Change `GateBody`'s textarea to bind `detail.instructions` and call `detail.onChange({ instructions: e.target.value })`; update the label to "Instructions" and the placeholder to "Approve only when … ; otherwise reject." and the helper text to describe the fixed `approved`/`rejected` ports + the decision-record shape.
- Extend the step `NodeDetail` variant with `terminal: boolean` and add a checkbox in `StepBody`:

```tsx
<label style={{ display: "flex", alignItems: "center", gap: 8 }}>
  <input
    type="checkbox"
    aria-label="Terminal step"
    checked={detail.terminal ?? false}
    onChange={(e) => !readOnly && detail.onChange({ terminal: e.target.checked })}
  />
  Terminal step (completes the workflow)
</label>
```

Update the call site that builds `NodeDetail` (in `TemplateDetail.tsx`/`WorkflowsPage.tsx`) to pass `instructions` for gates and `terminal` for steps, writing them onto the graph node.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- NodeDetailModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/NodeDetailModal.tsx apps/desktop/src/workflows/NodeDetailModal.test.tsx apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/WorkflowsPage.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): edit gate instructions and step terminal designation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Full-suite green + typecheck

**Files:** none (verification gate)

- [ ] **Step 1: Type-check the monorepo**

Run: `pnpm typecheck`
Expected: no errors. Fix any type drift from the edge/node contract change (the edge type went tuple → object; any remaining `[a, b]` access patterns must be updated).

- [ ] **Step 2: Run the daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 3: Run the contracts + desktop suites**

Run: `pnpm --filter @orca/contracts test && pnpm --filter @orca/desktop test`
Expected: PASS.

- [ ] **Step 4: Unused-export check**

Run: `pnpm knip`
Expected: no new unused exports from the routing/gate modules (wire or remove anything knip flags).

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(daemon): typecheck and suite green for graph routing phase 1

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage (Phase 1 scope):**
- Edge/port contract → Task 1. ✓
- `terminal` node flag → Task 2 (contract), Tasks 11/14 (runtime). ✓
- Graph traversal replacing ordinal advancement → Tasks 3, 11, 13. ✓
- Gate execution (table + cursor + `traversal_seq` + orchestrator judgment) → Tasks 7, 8, 12, 13. ✓
- Blocking template validation (rules + `{{key}}` all-paths) → Tasks 4, 5, 6. ✓
- Graph-aware repair context + revisit attempt numbering → Tasks 10, 16. ✓
- Supervised-mode gate behavior → Task 15. ✓
- Restart recovery at step/gate/transition boundaries → Tasks 9 (cursor), 17 (reconcile). ✓
- Desktop authoring (ports, backward edges, terminal) → Tasks 18, 19. ✓
- Mark-done yield preserved → Task 14. ✓

**Deferred to later phases (intentionally not covered):** platform ledger + completion envelope (Phase 2); Feature Development template instructions/schemas (Phase 3). The built-in `orca/engineering` template keeps `graph_json = NULL` and runs via `materializeLinearGraph`, so it is unaffected.

**Type consistency check:** `Destination` (Task 3) is consumed in Tasks 11/13; `AdvanceResult`/`advanceToNextStepOrGate` (Task 11) is consumed in Task 13; `GateEvaluationProposal`/`evaluateGate` (Task 12) feed `evaluateAndRouteGate` (Task 13); `nextAttemptForStep` (Task 10) is used in Tasks 11/13; `recordGateDecision`/`nextTraversalSeq`/`listGateDecisionsForRun` (Task 8) are used in Tasks 13/16. Names are consistent across tasks.

**Known integration risks the implementer must verify against live code (not placeholders — confirm signatures before editing the 2394-line `service.ts`):**
1. `blockRun`/`blockRunById` exact signature — Task 13 assumes a runId-friendly block helper; if `blockRun` requires the full `ctx`, build it from `getWorkflowRunById` + `readStepRun` (null for gate).
2. `composeAgentInitialPrompt` parameter list — Task 16 adds `repairContext`; confirm the composer in `session-launcher.ts`/`deliver-initial-prompt.ts`.
3. `confirmStep` Continue path — Task 15 adds a gate branch; confirm where supervised Continue is dispatched (HTTP route + `confirmStep` method) and thread the `pending_gate_route_json` stash through it.
4. `applyMigrations` export name and the `goals` insert columns — Task 8 test setup; verify against `migrations.ts` and `0001_init.sql`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-12-graph-authoritative-routing-phase-1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
