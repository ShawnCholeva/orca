import type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowStepTemplate,
} from "@orca/contracts";

export type Destination =
  | { kind: "step"; nodeId: string }
  | { kind: "gate"; nodeId: string }
  | { kind: "splitter"; nodeId: string }
  | { kind: "delegate"; nodeId: string }
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

function materializeLinearGraph(steps: WorkflowStepTemplate[]): WorkflowGraph {
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
  if (node.type === "gate") return { kind: "gate", nodeId: toId };
  if (node.type === "splitter") return { kind: "splitter", nodeId: toId };
  if (node.type === "delegate") return { kind: "delegate", nodeId: toId };
  return { kind: "step", nodeId: toId };
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

export type StepSplitterRouting = {
  branchKey: string;
  branchToName: Record<string, string>;
};

/**
 * When `stepTemplateId`'s node routes directly into a splitter, returns that
 * splitter's branch key plus a map from each branch value to the destination
 * node's display name. Returns null when the step does not feed a splitter. Lets
 * a step's routing output field (e.g. `recommended_tier`) be rendered as the
 * name of the step the chosen branch leads to.
 */
export function splitterRoutingForStep(
  graph: WorkflowGraph,
  stepTemplateId: string
): StepSplitterRouting | null {
  const stepNode = graph.nodes.find(
    (n) => n.type === "step" && (n.stepId ?? n.id) === stepTemplateId
  );
  if (!stepNode) return null;
  let dest: Destination;
  try {
    dest = resolveStepNext(graph, stepNode.id);
  } catch {
    return null;
  }
  if (dest.kind !== "splitter") return null;
  const splitter = nodeById(graph, dest.nodeId);
  if (!splitter || splitter.type !== "splitter" || !splitter.branchKey) return null;
  const branchToName: Record<string, string> = {};
  for (const edge of graph.edges) {
    if (edge.from !== splitter.id || edge.port == null) continue;
    const target = nodeById(graph, edge.to);
    if (target?.name) branchToName[edge.port] = target.name;
  }
  return { branchKey: splitter.branchKey, branchToName };
}

/** Resolves the destination for a splitter branch via the branch-labeled edge. */
export function resolveSplitterNext(
  graph: WorkflowGraph,
  splitterNodeId: string,
  branch: string
): Destination {
  const out = graph.edges.filter((e) => e.from === splitterNodeId && e.port === branch);
  if (out.length !== 1) {
    throw new GraphRoutingError(
      `splitter ${splitterNodeId} must have exactly one '${branch}' edge, found ${out.length}`
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
