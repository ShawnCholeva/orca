import type Database from "better-sqlite3";
import {
  LIVE_ACTIVITY_COLUMNS,
  isParkedOnHuman,
  openQuestionColumn,
  liveActivityJoin,
} from "../../activities/awaiting-user.js";
import {
  WorkflowStepResult,
  WorkflowStepRun,
  type WorkflowStepRun as WorkflowStepRunT,
} from "@orca/contracts";

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
  selected_operator_id: string | null;
  selected_provider_id: string | null;
  selected_model_id: string | null;
  operator_selected_at: string | null;
  open_question: number;
  orchestrator_phase: string | null;
  pending_judge_json: string | null;
  awaiting_user: number;
  activity_status: string | null;
  activity_source_kind: string | null;
  step_result_json: string | null;
}

// Aliased because the live-activity join needs one. `awaiting_user`, the live
// activity and the open-question column are all selected: they cover the three
// different channels of "parked on the human" (chat replies, parks, unanswered
// questions) and none is complete alone — see activities/awaiting-user.ts.
const STEP_RUN_COLUMNS =
  "wsr.id, wsr.goal_id, wsr.workflow_run_id, wsr.step_template_id, wsr.ordinal, wsr.attempt, wsr.status, wsr.started_at, wsr.finished_at, wsr.blocked_reason, wsr.selected_operator_id, wsr.selected_provider_id, wsr.selected_model_id, wsr.operator_selected_at, wsr.orchestrator_phase, wsr.pending_judge_json, wsr.awaiting_user, wsr.step_result_json, " +
  LIVE_ACTIVITY_COLUMNS + ", " + openQuestionColumn("wsr");

const STEP_RUN_FROM = `FROM workflow_step_runs wsr ${liveActivityJoin("wsr")}`;

let _db: Database.Database | null = null;
let _stmt: Database.Statement | null = null;

function ensureStmt(db: Database.Database): Database.Statement {
  if (_db !== db || !_stmt) {
    _db = db;
    _stmt = db.prepare(
      `SELECT ${STEP_RUN_COLUMNS} ${STEP_RUN_FROM} WHERE wsr.id = ?`
    );
  }
  return _stmt;
}

export function resetWorkflowStepProjectionPreparedStatements(): void {
  _db = null;
  _stmt = null;
}

function rowToStepRun(row: WorkflowStepRunRow): WorkflowStepRunT {
  const stepResult = row.step_result_json
    ? WorkflowStepResult.parse(JSON.parse(row.step_result_json))
    : null;

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
    selectedOperatorId: row.selected_operator_id,
    selectedProviderId: row.selected_provider_id as never,
    selectedModelId: row.selected_model_id,
    operatorSelectedAt: row.operator_selected_at,
    orchestratorPhase: row.orchestrator_phase as never,
    judgePending: row.pending_judge_json != null,
    awaitingUser: isParkedOnHuman({
      activityStatus: row.activity_status,
      activitySourceKind: row.activity_source_kind,
      chatReplyPending: row.awaiting_user === 1,
      openQuestion: row.open_question === 1,
    }),
    stepResult,
  });
}

export function getWorkflowStepRunById(
  db: Database.Database,
  id: string
): WorkflowStepRunT | null {
  const row = ensureStmt(db).get(id) as WorkflowStepRunRow | undefined;
  return row ? rowToStepRun(row) : null;
}

// All step runs for a run (executed steps), ordered by ordinal then attempt. A
// step that was routed past (e.g. an approach_only skip) has NO row here — that
// absence is how the UI tells a skipped node from one that actually ran.
export function listStepRunsForRun(
  db: Database.Database,
  workflowRunId: string
): WorkflowStepRunT[] {
  const rows = db
    .prepare(
      // ordinal >= 0 excludes internal surrogate step-runs (gate/delegate nodes
      // materialize a surrogate at the sentinel ordinal -1; a worker gate keeps
      // its surrogate `active` for the whole eval). They are not real steps —
      // and their negative ordinal violates WorkflowStepRun's nonnegative-ordinal
      // contract, so serving them would 500 this projection.
      `SELECT ${STEP_RUN_COLUMNS} ${STEP_RUN_FROM} WHERE wsr.workflow_run_id = ? AND wsr.ordinal >= 0 ORDER BY wsr.ordinal ASC, wsr.attempt ASC`
    )
    .all(workflowRunId) as WorkflowStepRunRow[];
  return rows.map(rowToStepRun);
}

export function recordOperatorSelection(
  db: Database.Database,
  id: string,
  sel: {
    operatorId: string;
    providerId: string | null;
    /** The full dispatch string ("claude-opus-5[1m]"), not the bare catalog id. */
    modelId: string | null;
    effort: string | null;
    at: string;
  }
): void {
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id=?, selected_provider_id=?, selected_model_id=?, selected_effort=?, operator_selected_at=? WHERE id=?"
  ).run(sel.operatorId, sel.providerId, sel.modelId, sel.effort, sel.at, id);
  resetWorkflowStepProjectionPreparedStatements();
}
