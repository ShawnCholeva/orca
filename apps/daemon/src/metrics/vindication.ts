import type { WorkflowGraph } from "@orca/contracts";
import type { TemplateTransition, GateDecisionRow, SplitDecisionRow } from "./fetch.js";

export type VindicationOutcome = "vindicated" | "bounced" | "pending";
export type VindicationResult = { outcome: VindicationOutcome; byNodeId: string | null };

function push<K, V>(m: Map<K, V[]>, k: K, v: V) { (m.get(k) ?? m.set(k, []).get(k)!).push(v); }

export function deriveVindication(input: {
  transitions: TemplateTransition[];
  gateDecisions: GateDecisionRow[];
  splitDecisions: SplitDecisionRow[];
  graph: WorkflowGraph;
}): Map<string, VindicationResult> {
  const { graph } = input;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // step identity (stepId ?? id) -> single downstream node id, or null (terminal / not exactly one edge)
  const downstreamOf = new Map<string, string | null>();
  for (const n of graph.nodes) {
    if (n.type !== "step") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    downstreamOf.set(n.stepId ?? n.id, out.length === 1 ? out[0].to : null);
  }
  // downstream-step identity resolver (a downstream node id -> the stepTemplateId transitions carry)
  const stepIdentityOf = (nodeId: string) => nodeById.get(nodeId)?.stepId ?? nodeId;

  const stepCompletesByRun = new Map<string, TemplateTransition[]>();
  const markDoneByRun = new Map<string, TemplateTransition[]>();
  const delegateJoinByRun = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    const runId = t.transition.workflowRunId;
    if (runId == null) continue;
    const b = t.transition.boundary;
    if (b === "step_complete" && t.stepTemplateId && !t.stepTemplateId.startsWith("__gate__:")) push(stepCompletesByRun, runId, t);
    else if (b === "mark_done") push(markDoneByRun, runId, t);
    else if (b === "delegate_join") push(delegateJoinByRun, runId, t);
  }
  const gatesByRunNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.gateDecisions) push(gatesByRunNode, `${d.workflowRunId}::${d.nodeId}`, d);
  const splitsByRunNode = new Map<string, SplitDecisionRow[]>();
  for (const d of input.splitDecisions) push(splitsByRunNode, `${d.workflowRunId}::${d.nodeId}`, d);

  // final completion per (run, step)
  const finalByRunStep = new Map<string, TemplateTransition>();
  for (const [, arr] of stepCompletesByRun) for (const t of arr) {
    const k = `${t.transition.workflowRunId}::${t.stepTemplateId}`;
    const prev = finalByRunStep.get(k);
    if (!prev || t.transition.createdAt.localeCompare(prev.transition.createdAt) > 0) finalByRunStep.set(k, t);
  }

  const out = new Map<string, VindicationResult>();
  for (const [k, t] of finalByRunStep) {
    const runId = t.transition.workflowRunId!;
    const stepId = t.stepTemplateId!;
    const at = t.transition.createdAt;
    const dn = downstreamOf.get(stepId) ?? null;
    if (dn == null) {
      const done = (markDoneByRun.get(runId) ?? []).some((m) => m.transition.createdAt.localeCompare(at) > 0);
      out.set(k, { outcome: done ? "vindicated" : "pending", byNodeId: null });
      continue;
    }
    const dtype = nodeById.get(dn)?.type;
    if (dtype === "gate") {
      const dec = (gatesByRunNode.get(`${runId}::${dn}`) ?? [])
        .filter((d) => d.createdAt.localeCompare(at) > 0).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      out.set(k, dec == null ? { outcome: "pending", byNodeId: dn }
        : { outcome: dec.outcome === "approved" ? "vindicated" : "bounced", byNodeId: dn });
    } else if (dtype === "splitter") {
      const routed = (splitsByRunNode.get(`${runId}::${dn}`) ?? []).some((d) => d.createdAt.localeCompare(at) > 0);
      out.set(k, { outcome: routed ? "vindicated" : "pending", byNodeId: dn });
    } else if (dtype === "delegate") {
      const joined = (delegateJoinByRun.get(runId) ?? []).some((j) => j.transition.createdAt.localeCompare(at) > 0);
      out.set(k, { outcome: joined ? "vindicated" : "pending", byNodeId: dn });
    } else {
      const proceeded = (stepCompletesByRun.get(runId) ?? [])
        .some((c) => c.stepTemplateId === stepIdentityOf(dn) && c.transition.createdAt.localeCompare(at) > 0);
      out.set(k, { outcome: proceeded ? "vindicated" : "pending", byNodeId: dn });
    }
  }
  return out;
}
