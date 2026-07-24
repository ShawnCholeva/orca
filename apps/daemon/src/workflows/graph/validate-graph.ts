import type {
  WorkflowGraph,
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
  WorkflowTemplate as WorkflowTemplateT,
} from "@orca/contracts";
import { findInitialStepNode } from "./graph-routing.js";
import { delegationTargets } from "../composition/depth.js";
import { stepRequiresExecution } from "../orchestrator/requires-execution.js";

/**
 * Returns a list of human-readable rule violations for a graph against its step
 * templates. An empty list means the graph is valid. Backward edges and cycles
 * are valid; there is no visit cap.
 *
 * Pass `opts.resolveChild` to validate delegate node reads/writes against the
 * child template's declared inputs and terminal step outputSchema.
 */
export function validateGraph(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[],
  opts?: { resolveChild?: (templateId: string) => WorkflowTemplateT | null }
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
    } else if (node.type === "delegate") {
      if (!node.childTemplateId || node.childTemplateVersion === undefined) {
        errors.push(`delegate node '${node.id}' is missing childTemplateId or childTemplateVersion`);
      }
      if (out.length !== 1) {
        errors.push(`delegate '${node.id}' must have exactly one outgoing edge (found ${out.length})`);
      }
      for (const e of out) {
        if (e.port) errors.push(`delegate edge must not carry a port: ${e.from} -> ${e.to}`);
      }
      if (node.childTemplateId && opts?.resolveChild) {
        const child = opts.resolveChild(node.childTemplateId);
        if (!child) {
          errors.push(`delegate '${node.id}' references unresolvable child template '${node.childTemplateId}'`);
        } else {
          // reads: { childInputKey: parentKeyName } — childInputKey must be in child.inputs
          const childInputKeys = new Set((child.inputs ?? []).map((f) => f.key));
          for (const childInputKey of Object.keys(node.reads ?? {})) {
            if (!childInputKeys.has(childInputKey)) {
              errors.push(
                `delegate '${node.id}' reads key '${childInputKey}' not declared in child template '${node.childTemplateId}' inputs`
              );
            }
          }
          // writes: { parentOutputKey: childOutputKey } — childOutputKey must be in child terminal step outputSchema
          const childTerminalNode = child.graph?.nodes.find((n) => n.type === "step" && n.terminal);
          const childTerminalStepId = childTerminalNode?.stepId ?? childTerminalNode?.id;
          const childTerminalStep = child.steps.find((s) => s.id === childTerminalStepId);
          const childOutputKeys = new Set(childTerminalStep?.outputSchema.map((f) => f.key) ?? []);
          for (const childOutputKey of Object.values(node.writes ?? {})) {
            if (!childOutputKeys.has(childOutputKey)) {
              errors.push(
                `delegate '${node.id}' writes child key '${childOutputKey}' not in child terminal step outputSchema`
              );
            }
          }
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

/**
 * Guaranteed-verifier invariant: every step node must have at least one way to
 * be checked before it can be trusted as complete — enforce-mode grounding, a
 * validation_rule guardrail, a gate successor, a human-authoritative completion
 * policy (interview/handoff), or being terminal (human-authoritative mark_done).
 * Returns human-readable violations; an empty list means every step is verified.
 */
export function validateStepVerifiers(
  graph: WorkflowGraph,
  steps: WorkflowStepTemplate[],
  guardrails: WorkflowGuardrailConfig[]
): string[] {
  const errors: string[] = [];
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const gateNodeIds = new Set(graph.nodes.filter((n) => n.type === "gate").map((n) => n.id));
  for (const node of graph.nodes) {
    if (node.type !== "step") continue;
    const templateId = node.stepId ?? node.id;
    const tpl = stepById.get(templateId);
    const enforceGrounding = (tpl?.grounding ?? []).some((g) => (g as { mode?: string }).mode === "enforce");
    const hasValidationRule = stepRequiresExecution(guardrails, templateId) != null;
    const gateSuccessor = graph.edges.some((e) => e.from === node.id && gateNodeIds.has(e.to));
    const humanPolicy = tpl?.completionPolicy === "interview" || tpl?.completionPolicy === "handoff";
    const terminal = node.terminal === true;
    if (!(enforceGrounding || hasValidationRule || gateSuccessor || humanPolicy || terminal)) {
      errors.push(
        `step '${node.id}' has no verifier: needs enforce grounding, a validation_rule, a gate, an interview/handoff policy, or terminal`
      );
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
    } else if (node.type === "delegate") {
      // Delegate nodes produce the parentOutputKeys declared in `writes`.
      produces.set(node.id, new Set(Object.keys(node.writes ?? {})));
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
    if (node.type === "step") {
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
    } else if (node.type === "delegate") {
      const here = available.get(node.id)!;
      for (const [childKey, parentKey] of Object.entries(node.reads ?? {})) {
        if (!here.has(parentKey)) {
          errors.push(
            `delegate node ${node.id} reads "${childKey}" from parent key "${parentKey}" which is not produced on any incoming path`
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Checks the delegation graph rooted at `template` for cycles. Returns a list
 * of violation strings (empty means acyclic). `resolveChild` is called for each
 * child template ID referenced by a delegate node; return null for unknown IDs.
 */
export function validateDelegationAcyclic(
  resolveChild: (templateId: string) => Pick<WorkflowTemplateT, "id" | "graph"> | null,
  template: Pick<WorkflowTemplateT, "id" | "graph">
): string[] {
  const seen = new Set<string>();
  const stack = new Set<string>();

  const visit = (tplId: string, tpl: Pick<WorkflowTemplateT, "id" | "graph"> | null): string[] => {
    if (!tpl) return [];
    if (stack.has(tplId)) return [`delegation cycle detected at template '${tplId}'`];
    if (seen.has(tplId)) return [];
    seen.add(tplId);
    stack.add(tplId);
    const out: string[] = [];
    for (const t of delegationTargets(tpl)) {
      out.push(...visit(t.childTemplateId, resolveChild(t.childTemplateId)));
    }
    stack.delete(tplId);
    return out;
  };

  return visit(template.id, template);
}
