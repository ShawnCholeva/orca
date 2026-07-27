import type { NodeVersionHistory, SplitterMetrics, WorkflowGraph } from "@orca/contracts";
import type { SplitDecisionRow } from "./fetch.js";
import { NODE_CONFIDENCE_MIN, NODE_PRIOR_STRENGTH } from "./gate-metrics.js";
import { betaMean, betaSampleSize } from "./verification.js";
import type { NodeVindicationResult } from "./node-vindication.js";

// Decision-correctness confidence (Phase 3, T4): designed prior for "did this splitter's
// route hold up downstream?" — a single flat prior (no worker/shadow split; splitters have
// no evalSubstrate axis), mirroring GATE_CONFIDENCE_PRIOR's role for gates.
export const SPLITTER_CONFIDENCE_PRIOR = 0.5;

// Resolve a splitter's predecessor step the way gate-review.ts resolves a gate's reviewed
// step: the step node with an edge INTO the splitter. Zero or >1 step predecessors is
// ambiguous, so attribution stays null rather than guessing. The returned id must be the
// identity a transition's stepTemplateId/StepMetrics.stepTemplateId carries (stepId ?? id) —
// matching gate-review.ts:22 and vindication.ts:25 — not the raw graph node id.
function predecessorStepId(graph: WorkflowGraph, nodeId: string): string | null {
  const stepNodesById = new Map(graph.nodes.filter((n) => n.type === "step").map((n) => [n.id, n]));
  const stepPreds = [...new Set(
    graph.edges.filter((e) => e.to === nodeId && stepNodesById.has(e.from)).map((e) => e.from)
  )];
  return stepPreds.length === 1 ? (stepNodesById.get(stepPreds[0])!.stepId ?? stepPreds[0]) : null;
}

export function buildSplitterMetrics(input: {
  splitDecisions: SplitDecisionRow[];
  splitterVindication: Map<string, NodeVindicationResult>;
  graph: WorkflowGraph;
  names: Map<string, { name: string }>;
  lineage?: Map<string, NodeVersionHistory>;
}): SplitterMetrics[] {
  const byNode = new Map<string, SplitDecisionRow[]>();
  for (const d of input.splitDecisions) {
    (byNode.get(d.nodeId) ?? byNode.set(d.nodeId, []).get(d.nodeId)!).push(d);
  }

  const splitterNodesById = new Map(input.graph.nodes.filter((n) => n.type === "splitter").map((n) => [n.id, n]));

  const splitters: SplitterMetrics[] = [];
  for (const [nodeId, decisions] of byNode) {
    const meta = input.names.get(nodeId) ?? { name: nodeId };

    let pos = 0;
    let neg = 0;
    for (const d of decisions) {
      const v = input.splitterVindication.get(`${d.workflowRunId}::${nodeId}::${d.traversalSeq}`);
      if (!v || v.outcome === "pending") continue;
      if (v.outcome === "vindicated") pos++; else neg++;
    }
    const sampleSize = betaSampleSize(pos, neg);

    const node = splitterNodesById.get(nodeId);
    const deterministic = node?.branchKey != null;
    const attributedToNodeId = deterministic ? predecessorStepId(input.graph, nodeId) : null;

    splitters.push({
      nodeId, name: meta.name,
      confidence: {
        value: sampleSize === 0 ? null : betaMean(SPLITTER_CONFIDENCE_PRIOR, NODE_PRIOR_STRENGTH, pos, neg),
        sampleSize,
        state: sampleSize >= NODE_CONFIDENCE_MIN ? "measured" : "insufficient",
      },
      decisions: decisions.length,
      misrouteRate: sampleSize === 0 ? null : neg / sampleSize,
      retrospectiveOnly: true,
      deterministic,
      attributedToNodeId,
      versionHistory: input.lineage?.get(nodeId),
    });
  }
  return splitters.sort((a, b) => a.name.localeCompare(b.name));
}
