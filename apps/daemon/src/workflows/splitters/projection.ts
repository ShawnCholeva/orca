import type Database from "better-sqlite3";

export interface SplitDecisionRecord {
  id: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  selectedBranch: string;
  reason: string;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  ledgerVersion: number;
  createdAt: string;
}

interface Row {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  node_id: string;
  traversal_seq: number;
  selected_branch: string;
  reason: string;
  selected_edge_to: string;
  inputs_considered_json: string;
  ledger_version: number;
  created_at: string;
}

export function listSplitDecisionsForRun(
  db: Database.Database,
  runId: string
): SplitDecisionRecord[] {
  const rows = db
    .prepare("SELECT * FROM workflow_split_decisions WHERE workflow_run_id = ? ORDER BY created_at ASC")
    .all(runId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    goalId: r.goal_id,
    workflowRunId: r.workflow_run_id,
    nodeId: r.node_id,
    traversalSeq: r.traversal_seq,
    selectedBranch: r.selected_branch,
    reason: r.reason,
    selectedEdgeTo: r.selected_edge_to,
    inputsConsidered: JSON.parse(r.inputs_considered_json),
    ledgerVersion: r.ledger_version,
    createdAt: r.created_at,
  }));
}
