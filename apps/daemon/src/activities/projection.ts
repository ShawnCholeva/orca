import type Database from "better-sqlite3";
import {
  Activity,
  PendingQuestion,
  WorkflowStepResult,
  type Activity as ActivityT,
  type PendingQuestion as PendingQuestionT
} from "@orca/contracts";

interface ActivityRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string;
  agent_session_id: string | null;
  turn_ordinal: number;
  status: string;
  current_text: string;
  final_summary: string | null;
  source_kind: string;
  work_category: string | null;
  confidence: string | null;
  pending_question: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToActivity(row: ActivityRow): ActivityT {
  let pendingQuestion: PendingQuestionT | undefined;
  if (row.pending_question !== null) {
    pendingQuestion = PendingQuestion.parse(JSON.parse(row.pending_question));
  }

  return Activity.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    agentSessionId: row.agent_session_id,
    turnOrdinal: row.turn_ordinal,
    status: row.status,
    currentText: row.current_text,
    finalSummary: row.final_summary,
    sourceKind: row.source_kind,
    workCategory: row.work_category,
    confidence: row.confidence,
    ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  });
}

function enrichStepResult(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "step_result" || activity.stepRunId === null) return activity;
  const row = db
    .prepare(
      `SELECT sr.step_result_json AS result_json,
              sr.step_template_id,
              wt.steps_json
       FROM workflow_step_runs sr
       LEFT JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
       LEFT JOIN workflow_templates wt ON wt.id = wr.template_id
       WHERE sr.id = ?`
    )
    .get(activity.stepRunId) as {
      result_json: string | null;
      step_template_id: string;
      steps_json: string | null;
    } | undefined;
  if (!row?.result_json) return activity;
  let stepName: string | undefined;
  if (row.steps_json) {
    const steps = JSON.parse(row.steps_json) as Array<{ id: string; name?: string }>;
    stepName = steps.find((s) => s.id === row.step_template_id)?.name;
  }
  return Activity.parse({
    ...activity,
    ...(stepName !== undefined ? { stepName } : {}),
    stepResult: WorkflowStepResult.parse(JSON.parse(row.result_json)),
  });
}

export function listActivitiesByGoal(
  db: Database.Database,
  goalId: string
): ActivityT[] {
  const rows = db
    .prepare(
      `SELECT id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
              status, current_text, final_summary, source_kind, work_category, confidence,
              pending_question, created_at, updated_at, completed_at
       FROM activities
       WHERE goal_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(goalId) as ActivityRow[];
  return rows.map(rowToActivity).map((a) => enrichStepResult(db, a));
}
