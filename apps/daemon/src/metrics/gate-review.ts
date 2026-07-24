import type { WorkflowGraph } from "@orca/contracts";

export function gateApprovalsByStep(
  graph: WorkflowGraph,
  gateDecisions: { nodeId: string; outcome: "approved" | "rejected"; workflowRunId: string }[],
): Map<string, Set<string>> {
  // gate node id -> reviewed step's stepId (the identity a transition's stepTemplateId
  // actually carries — matches validateStepVerifiers' node.stepId ?? node.id)
  const reviewedStepOf = new Map<string, string>();
  const stepNodesById = new Map(graph.nodes.filter((n) => n.type === "step").map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (n.type !== "gate") continue;
    // A gate reviews exactly one step — the step node whose edge feeds it. If a gate
    // has zero or (in a future graph) multiple step predecessors, the reviewed step is
    // ambiguous, so we attribute nothing rather than guess: the step degrades to its
    // other evidence / unknown, never a mis-credit.
    const stepPreds = [...new Set(
      graph.edges.filter((e) => e.to === n.id && stepNodesById.has(e.from)).map((e) => e.from)
    )];
    if (stepPreds.length === 1) {
      const predNode = stepNodesById.get(stepPreds[0])!;
      reviewedStepOf.set(n.id, predNode.stepId ?? predNode.id);
    }
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
