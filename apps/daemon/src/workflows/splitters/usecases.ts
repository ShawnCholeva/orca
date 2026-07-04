import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface SplitDecisionInput {
  id?: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  selectedBranch: string;
  reason: string;
  reasoning: string | null;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  ledgerVersion: number;
}

export function recordSplitDecision(
  db: Database.Database,
  now: () => string,
  input: SplitDecisionInput
): string {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO workflow_split_decisions
       (id, goal_id, workflow_run_id, node_id, traversal_seq, selected_branch, reason, reasoning,
        selected_edge_to, inputs_considered_json, ledger_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.goalId,
    input.workflowRunId,
    input.nodeId,
    input.traversalSeq,
    input.selectedBranch,
    input.reason.slice(0, 1024),
    input.reasoning,
    input.selectedEdgeTo,
    JSON.stringify(input.inputsConsidered),
    input.ledgerVersion,
    now()
  );
  return id;
}
