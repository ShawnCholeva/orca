import type Database from "better-sqlite3";
import { WorkflowRun, type WorkflowRun as WorkflowRunT } from "@orca/contracts";

interface WorkflowRunRow {
  id: string;
  goal_id: string;
  template_id: string;
  template_version: number;
  status: string;
  current_step_run_id: string | null;
  started_at: string;
  finished_at: string | null;
  blocked_reason: string | null;
  current_node_id: string | null;
  current_node_kind: string | null;
  traversal_seq: number;
}

let _db: Database.Database | null = null;
let _stmts: {
  getById: Database.Statement;
  listByGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (_db !== db) {
    _db = db;
    _stmts = {
      getById: db.prepare(
        "SELECT id, goal_id, template_id, template_version, status, current_step_run_id, started_at, finished_at, blocked_reason, current_node_id, current_node_kind, traversal_seq FROM workflow_runs WHERE id = ?"
      ),
      listByGoal: db.prepare(
        "SELECT id, goal_id, template_id, template_version, status, current_step_run_id, started_at, finished_at, blocked_reason, current_node_id, current_node_kind, traversal_seq FROM workflow_runs WHERE goal_id = ? ORDER BY started_at DESC"
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function rowToRun(row: WorkflowRunRow): WorkflowRunT {
  return WorkflowRun.parse({
    id: row.id,
    goalId: row.goal_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    status: row.status,
    currentStepRunId: row.current_step_run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
    currentNodeId: row.current_node_id,
    currentNodeKind: row.current_node_kind,
    traversalSeq: row.traversal_seq,
  });
}

export function getWorkflowRunById(
  db: Database.Database,
  id: string
): WorkflowRunT | null {
  const row = ensureStmts(db).getById.get(id) as WorkflowRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listWorkflowRunsForGoal(
  db: Database.Database,
  goalId: string
): WorkflowRunT[] {
  const rows = ensureStmts(db).listByGoal.all(goalId) as WorkflowRunRow[];
  return rows.map(rowToRun);
}
