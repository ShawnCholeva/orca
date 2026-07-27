import type { WorkflowGraph } from "@orca/contracts";

/**
 * Designed-prior strength of a vindicator (the downstream node that accepted/bounced a step),
 * used to weight its vindication as a soft calibration label. Prior-only (no computed score) —
 * computed-confidence weighting is deferred to gate/splitter scoring (Phase 3).
 *
 * Weights: terminal/human (byNodeId === null) → 1.0 (anchor); worker gate → 0.55;
 * shadow gate → 0.4; step → 0.5; splitter → 0.3; delegate → 0.55; unknown node → 0.3 (conservative).
 */
export function vindicatorWeight(byNodeId: string | null, graph: WorkflowGraph): number {
  if (byNodeId === null) return 1.0; // terminal — human mark_done, the anchor
  const n = graph.nodes.find((x) => x.id === byNodeId);
  if (!n) return 0.3;
  switch (n.type) {
    case "gate": return n.evalSubstrate === "worker" ? 0.55 : 0.4;
    case "step": return 0.5;
    case "splitter": return 0.3;
    case "delegate": return 0.55;
    default: return 0.3;
  }
}
