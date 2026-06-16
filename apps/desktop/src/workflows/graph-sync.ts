import type { WorkflowGraph, WorkflowGraphNode } from "@orca/contracts";
import type { WorkflowStepDraft } from "./StepEditor";

/**
 * Build a linear graph from a list of steps.
 * Each step gets one node (id === step.id, stepId === step.id).
 * Positions are stacked vertically. Consecutive step-nodes are chained.
 */
export function buildInitialGraph(steps: WorkflowStepDraft[]): WorkflowGraph {
  const nodes: WorkflowGraphNode[] = [];
  const positions: Record<string, { x: number; y: number }> = {};

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

  const edges = nodes
    .slice(0, -1)
    .map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));

  return { nodes, edges, positions };
}

/**
 * Reconcile a working graph against the current step list:
 * - Ensure exactly one step-node per current step (add missing, drop orphaned).
 * - Sync each step-node's name from its step.
 * - Keep all gate nodes.
 * - Drop edges referencing removed nodes.
 * - Default-position any node missing a position.
 */
export function reconcileGraph(
  steps: WorkflowStepDraft[],
  graph: WorkflowGraph,
): WorkflowGraph {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const existingGates = graph.nodes.filter((n) => n.type === "gate");
  const existingStepNodes = graph.nodes.filter((n) => n.type === "step");
  const existingStepNodeById = new Map(existingStepNodes.map((n) => [n.stepId ?? n.id, n]));

  const maxY = Object.values(graph.positions).reduce(
    (max, p) => Math.max(max, p.y),
    0,
  );

  const nextPositions = { ...graph.positions };

  // Build step nodes — preserve existing nodes, add new ones
  const nextStepNodes: WorkflowGraphNode[] = steps.map((step, i) => {
    const existing = existingStepNodeById.get(step.id);
    if (existing) {
      // sync name; preserve all other fields
      return { ...existing, name: step.name };
    }
    // new step — assign a default position below the current nodes
    const y = maxY + 92 + i * 92;
    nextPositions[step.id] = { x: 110, y };
    return { id: step.id, type: "step" as const, name: step.name, stepId: step.id };
  });

  // Drop positions for removed step nodes
  const removedStepIds = new Set(
    existingStepNodes
      .filter((n) => !stepById.has(n.stepId ?? n.id))
      .map((n) => n.id),
  );
  for (const id of removedStepIds) {
    delete nextPositions[id];
  }

  // All surviving nodes = current step nodes + all gate nodes
  const validNodeIds = new Set([
    ...nextStepNodes.map((n) => n.id),
    ...existingGates.map((n) => n.id),
  ]);

  // Drop edges where either endpoint no longer exists, self-loops, and
  // duplicate directed pairs (guards against programmatically-seeded or
  // directly DB-edited graphs producing duplicate React keys downstream).
  const seenEdges = new Set<string>();
  const nextEdges = graph.edges.filter((e) => {
    if (!validNodeIds.has(e.from) || !validNodeIds.has(e.to) || e.from === e.to) return false;
    const key = `${e.from}->${e.to}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  // Ensure all gates have positions (gate nodes are never auto-created here,
  // but we guard in case something slipped through)
  for (const gate of existingGates) {
    if (!nextPositions[gate.id]) {
      const y = maxY + 92;
      nextPositions[gate.id] = { x: 110, y };
    }
  }

  // Guarantee a terminal exists: if no surviving step node is terminal, mark the
  // last one (mirrors the daemon's materializeLinearGraph default).
  if (nextStepNodes.length > 0 && !nextStepNodes.some((n) => n.terminal)) {
    const lastIdx = nextStepNodes.length - 1;
    nextStepNodes[lastIdx] = { ...nextStepNodes[lastIdx], terminal: true };
  }

  return {
    nodes: [...nextStepNodes, ...existingGates],
    edges: nextEdges,
    positions: nextPositions,
  };
}
