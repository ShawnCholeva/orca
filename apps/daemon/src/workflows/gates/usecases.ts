import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface GateDecisionInput {
  id?: string;
  goalId: string;
  workflowRunId: string;
  nodeId: string;
  traversalSeq: number;
  outcome: "approved" | "rejected";
  reason: string;
  reasoning: string | null;
  selectedEdgeTo: string;
  inputsConsidered: string[];
  issueRefs: string[];
  ledgerVersion: number;
}

/** Atomically increments and returns the per-run traversal counter. */
export function nextTraversalSeq(db: Database.Database, runId: string): number {
  return db.transaction(() => {
    db.prepare("UPDATE workflow_runs SET traversal_seq = traversal_seq + 1 WHERE id = ?").run(runId);
    const row = db.prepare("SELECT traversal_seq FROM workflow_runs WHERE id = ?").get(runId) as
      | { traversal_seq: number }
      | undefined;
    if (!row) throw new Error(`workflow run not found: ${runId}`);
    return row.traversal_seq;
  })();
}

export function recordGateDecision(
  db: Database.Database,
  now: () => string,
  input: GateDecisionInput
): string {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO workflow_gate_decisions
       (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, reasoning,
        selected_edge_to, inputs_considered_json, issue_refs_json, ledger_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.goalId,
    input.workflowRunId,
    input.nodeId,
    input.traversalSeq,
    input.outcome,
    input.reason.slice(0, 1024),
    input.reasoning,
    input.selectedEdgeTo,
    JSON.stringify(input.inputsConsidered),
    JSON.stringify(input.issueRefs),
    input.ledgerVersion,
    now()
  );
  return id;
}
