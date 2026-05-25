import type Database from "better-sqlite3";
import { WorkflowStepRun, type WorkflowStepRun as WorkflowStepRunT } from "@orca/contracts";

interface WorkflowStepRunRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  attempt: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  blocked_reason: string | null;
  satisfied_exit_criteria_json: string;
  outstanding_exit_criteria_json: string;
}

let _db: Database.Database | null = null;
let _stmt: Database.Statement | null = null;

function ensureStmt(db: Database.Database): Database.Statement {
  if (_db !== db || !_stmt) {
    _db = db;
    _stmt = db.prepare(
      "SELECT id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, started_at, finished_at, blocked_reason, satisfied_exit_criteria_json, outstanding_exit_criteria_json FROM workflow_step_runs WHERE id = ?"
    );
  }
  return _stmt;
}

export function resetWorkflowStepProjectionPreparedStatements(): void {
  _db = null;
  _stmt = null;
}

function rowToStepRun(row: WorkflowStepRunRow): WorkflowStepRunT {
  return WorkflowStepRun.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepTemplateId: row.step_template_id,
    ordinal: row.ordinal,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
    satisfiedExitCriteria: JSON.parse(row.satisfied_exit_criteria_json) as string[],
    outstandingExitCriteria: JSON.parse(row.outstanding_exit_criteria_json) as string[],
  });
}

export function getWorkflowStepRunById(
  db: Database.Database,
  id: string
): WorkflowStepRunT | null {
  const row = ensureStmt(db).get(id) as WorkflowStepRunRow | undefined;
  return row ? rowToStepRun(row) : null;
}
