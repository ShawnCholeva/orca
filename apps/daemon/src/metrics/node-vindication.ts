import type { WorkflowGraph } from "@orca/contracts";
import type { TemplateTransition, GateDecisionRow, SplitDecisionRow } from "./fetch.js";
import { resolveGateNext, resolveSplitterNext } from "../workflows/graph/graph-routing.js";

export type NodeVindicationOutcome = "vindicated" | "false_accept" | "pending";
export type NodeVindicationResult = { outcome: NodeVindicationOutcome; byNodeId: string | null };

function push<K, V>(m: Map<K, V[]>, k: K, v: V) { (m.get(k) ?? m.set(k, []).get(k)!).push(v); }

// The false-accept terminal signal: a hard-fail step_complete (telemetry.outcome.status
// === "failed"), OR a goal_archived/session_archived failure_code on ANY boundary —
// abandonment matters because a bad approval that causes an endless Verify-reject loop
// often just *stops* without ever emitting a "failed" status, and would otherwise be
// invisible to a mark_done-anchored signal.
function isTerminalFailureOrAbandonment(t: TemplateTransition): boolean {
  const outcome = t.transition.telemetry?.outcome;
  if (!outcome) return false;
  if (t.transition.boundary === "step_complete" && outcome.status === "failed") return true;
  return outcome.failure_code === "goal_archived" || outcome.failure_code === "session_archived";
}

function indexByRun(transitions: TemplateTransition[]) {
  const markDoneByRun = new Map<string, TemplateTransition[]>();
  const failOrAbandonByRun = new Map<string, TemplateTransition[]>();
  for (const t of transitions) {
    const runId = t.transition.workflowRunId;
    if (runId == null) continue;
    if (t.transition.boundary === "mark_done") push(markDoneByRun, runId, t);
    if (isTerminalFailureOrAbandonment(t)) push(failOrAbandonByRun, runId, t);
  }
  return { markDoneByRun, failOrAbandonByRun };
}

export function deriveGateVindication(input: {
  transitions: TemplateTransition[];
  gateDecisions: GateDecisionRow[];
  graph: WorkflowGraph;
}): Map<string, NodeVindicationResult> {
  const { transitions, gateDecisions, graph } = input;
  const { markDoneByRun, failOrAbandonByRun } = indexByRun(transitions);

  const out = new Map<string, NodeVindicationResult>();
  for (const d of gateDecisions) {
    // Rejections are not labeled here (false-reject deferred) — covered by
    // overturnRate/rejectRate context instead.
    if (d.outcome !== "approved") continue;
    const key = `${d.workflowRunId}::${d.nodeId}::${d.traversalSeq}`;

    const vindicated = (markDoneByRun.get(d.workflowRunId) ?? [])
      .some((m) => m.transition.createdAt.localeCompare(d.createdAt) > 0);
    let outcome: NodeVindicationOutcome;
    if (vindicated) {
      outcome = "vindicated";
    } else {
      const terminal = (failOrAbandonByRun.get(d.workflowRunId) ?? [])
        .some((t) => t.transition.createdAt.localeCompare(d.createdAt) > 0);
      outcome = terminal ? "false_accept" : "pending";
    }

    let byNodeId: string | null = null;
    try {
      const dest = resolveGateNext(graph, d.nodeId, "approved");
      byNodeId = dest.kind === "terminal" ? null : dest.nodeId;
    } catch {
      // Malformed graph (missing/duplicate 'approved' port edge) — don't crash the
      // derivation over it; the decision still gets an outcome, just no propagation edge.
    }
    out.set(key, { outcome, byNodeId });
  }
  return out;
}

export function deriveSplitterVindication(input: {
  transitions: TemplateTransition[];
  splitDecisions: SplitDecisionRow[];
  graph: WorkflowGraph;
}): Map<string, NodeVindicationResult> {
  const { transitions, splitDecisions, graph } = input;
  const { markDoneByRun, failOrAbandonByRun } = indexByRun(transitions);

  const splitsByRunNode = new Map<string, SplitDecisionRow[]>();
  for (const d of splitDecisions) push(splitsByRunNode, `${d.workflowRunId}::${d.nodeId}`, d);

  const out = new Map<string, NodeVindicationResult>();
  for (const d of splitDecisions) {
    const key = `${d.workflowRunId}::${d.nodeId}::${d.traversalSeq}`;

    // Coarse backtrack: a later decision for the same (run, nodeId) that chose a
    // DIFFERENT branch means this decision's route was walked back — a misroute.
    const redecided = (splitsByRunNode.get(`${d.workflowRunId}::${d.nodeId}`) ?? [])
      .some((o) => o.createdAt.localeCompare(d.createdAt) > 0 && o.selectedBranch !== d.selectedBranch);
    const terminal = (failOrAbandonByRun.get(d.workflowRunId) ?? [])
      .some((t) => t.transition.createdAt.localeCompare(d.createdAt) > 0);

    let outcome: NodeVindicationOutcome;
    if (redecided || terminal) {
      outcome = "false_accept";
    } else {
      const vindicated = (markDoneByRun.get(d.workflowRunId) ?? [])
        .some((m) => m.transition.createdAt.localeCompare(d.createdAt) > 0);
      outcome = vindicated ? "vindicated" : "pending";
    }

    let byNodeId: string | null = null;
    try {
      const dest = resolveSplitterNext(graph, d.nodeId, d.selectedBranch);
      byNodeId = dest.kind === "terminal" ? null : dest.nodeId;
    } catch {
      // Malformed graph (missing/duplicate branch port edge) — guard, don't crash.
    }
    out.set(key, { outcome, byNodeId });
  }
  return out;
}
