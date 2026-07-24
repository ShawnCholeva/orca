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
