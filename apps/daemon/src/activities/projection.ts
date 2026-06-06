import type Database from "better-sqlite3";
import {
  Activity,
  PendingQuestion,
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
  return rows.map(rowToActivity);
}

export function getActivityById(
  db: Database.Database,
  activityId: string
): ActivityT | undefined {
  const row = db
    .prepare(
      `SELECT id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
              status, current_text, final_summary, source_kind, work_category, confidence,
              pending_question, created_at, updated_at, completed_at
       FROM activities
       WHERE id = ?`
    )
    .get(activityId) as ActivityRow | undefined;
  return row === undefined ? undefined : rowToActivity(row);
}
