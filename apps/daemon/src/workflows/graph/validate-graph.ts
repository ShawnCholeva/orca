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
      const templateId = node.stepId ?? node.id;
      if (!stepIds.has(templateId)) {
        errors.push(
          `step node '${node.id}' references unknown step template '${templateId}'`
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
