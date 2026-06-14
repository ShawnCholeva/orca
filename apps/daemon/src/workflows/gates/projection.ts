import type Database from "better-sqlite3";

export interface GateDecisionRecord {
  id: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  issueRefs: string[];
  ledgerVersion: number;
  createdAt: string;
}

interface Row {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  node_id: string;
  traversal_seq: number;
  outcome: "approved" | "rejected";
  reason: string;
  selected_edge_to: string;
  inputs_considered_json: string;
  issue_refs_json: string;
  ledger_version: number;
  created_at: string;
}

export function listGateDecisionsForRun(
  db: Database.Database,
  runId: string
): GateDecisionRecord[] {
  const rows = db
    .prepare("SELECT * FROM workflow_gate_decisions WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(runId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    goalId: r.goal_id,
    workflowRunId: r.workflow_run_id,
    nodeId: r.node_id,
    traversalSeq: r.traversal_seq,
    outcome: r.outcome,
    reason: r.reason,
    selectedEdgeTo: r.selected_edge_to,
    inputsConsidered: JSON.parse(r.inputs_considered_json),
    issueRefs: JSON.parse(r.issue_refs_json),
    ledgerVersion: r.ledger_version,
    createdAt: r.created_at,
  }));
}
