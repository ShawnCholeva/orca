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

  // Terminal: at least one terminal step node.
  const terminals = graph.nodes.filter((n) => n.type === "step" && n.terminal);
  if (terminals.length < 1) {
    errors.push(`at least one terminal step is required (found ${terminals.length})`);
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
    } else if (node.type === "gate") {
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
    } else {
      // splitter
      const branches = node.branches ?? [];
      if (branches.length < 2 || branches.length > 8) {
        errors.push(`splitter '${node.id}' must declare 2-8 branches (found ${branches.length})`);
      }
      const uniqueBranches = new Set(branches);
      if (uniqueBranches.size !== branches.length) {
        errors.push(`splitter '${node.id}' has duplicate branch labels`);
      }
      for (const label of uniqueBranches) {
        const matching = out.filter((e) => e.port === label);
        if (matching.length !== 1) {
          errors.push(
            `splitter '${node.id}' must have exactly one '${label}' edge (found ${matching.length})`
          );
        }
      }
      for (const e of out) {
        if (!e.port || !uniqueBranches.has(e.port)) {
          errors.push(`splitter edge must carry a declared branch port: ${e.from} -> ${e.to}`);
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
  }

  return errors;
}

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
        const incoming = new Set<string>([...(available.get(p) ?? []), ...(produces.get(p) ?? [])]);
        next = next === null ? incoming : new Set<string>([...(next as Set<string>)].filter((k) => incoming.has(k)));
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
