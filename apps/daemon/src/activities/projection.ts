import type Database from "better-sqlite3";
import {
  Activity,
  ActivityStep,
  PendingQuestion,
  ProviderRecoveryCheckpoint,
  StepResultScoringProposal,
  WorkflowStepOutputSchema,
  WorkflowStepResult,
  type Activity as ActivityT,
  type ActivityStep as ActivityStepT,
  type ConfirmationSummary as ConfirmationSummaryT,
  type PendingQuestion as PendingQuestionT,
  type WorkflowStepResult as WorkflowStepResultT
} from "@orca/contracts";
import { buildConfirmationSummary } from "../workflows/orchestrator/confirmation-summary.js";

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
  recommendation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function loadSteps(db: Database.Database, activityId: string): ActivityStepT[] {
  const rows = db
    .prepare(
      `SELECT id, text, category, status, diff, created_at
       FROM activity_steps WHERE activity_id = ? ORDER BY ordinal ASC`
    )
    .all(activityId) as Array<{
      id: string; text: string; category: string | null;
      status: string; diff: string | null; created_at: string;
    }>;
  return rows.map((r) =>
    ActivityStep.parse({
      id: r.id,
      text: r.text,
      category: r.category,
      status: r.status,
      ...(r.diff ? { diff: JSON.parse(r.diff) } : {}),
      createdAt: r.created_at,
    })
  );
}

function rowToActivity(db: Database.Database, row: ActivityRow): ActivityT {
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
    ...(row.recommendation_id !== null ? { recommendationId: row.recommendation_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    steps: loadSteps(db, row.id),
  });
}

/** Rebuilds the confirmation-card frame for a confirmed step_result activity so
 *  the chat keeps a static copy of the card the user approved. Returns undefined
 *  unless a confirmation was actually shown and resolved (an `expired`
 *  step_confirmation_pending sibling) and the step's output + schema are present. */
function rebuildConfirmedFrame(
  db: Database.Database,
  stepRunId: string,
  stepTemplateId: string,
  stepsJson: string | null,
  stepResult: WorkflowStepResultT
): ConfirmationSummaryT | undefined {
  const confirmed = db
    .prepare(
      `SELECT 1 FROM activities
       WHERE step_run_id = ? AND source_kind = 'step_confirmation_pending' AND status = 'expired'
       LIMIT 1`
    )
    .get(stepRunId);
  if (!confirmed || !stepsJson) return undefined;

  const steps = JSON.parse(stepsJson) as Array<{ id: string; outputSchema?: unknown }>;
  const step = steps.find((s) => s.id === stepTemplateId);
  const schemaParse = WorkflowStepOutputSchema.safeParse(step?.outputSchema);
  if (!schemaParse.success) return undefined;

  const artifact = db
    .prepare(
      `SELECT body FROM workflow_artifacts
       WHERE step_run_id = ? AND type = 'step_output'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(stepRunId) as { body: string } | undefined;
  if (!artifact) return undefined;

  let block: unknown;
  try { block = JSON.parse(artifact.body); } catch { return undefined; }

  const leadText = stepResult.resultSummary ?? stepResult.outcome.reason;
  return buildConfirmationSummary(schemaParse.data, block, null, leadText);
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
  const stepResult = WorkflowStepResult.parse(JSON.parse(row.result_json));
  const confirmationSummary = rebuildConfirmedFrame(
    db,
    activity.stepRunId,
    row.step_template_id,
    row.steps_json,
    stepResult
  );
  return Activity.parse({
    ...activity,
    ...(stepName !== undefined ? { stepName } : {}),
    stepResult,
    ...(confirmationSummary !== undefined ? { confirmationSummary } : {}),
  });
}

function enrichConfirmationSummary(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "step_confirmation_pending") return activity;
  const row = db
    .prepare(
      `SELECT sr.pending_completion_json AS stash,
              sr.step_template_id,
              wt.steps_json
       FROM workflow_step_runs sr
       LEFT JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
       LEFT JOIN workflow_templates wt ON wt.id = wr.template_id
       WHERE sr.id = ?`
    )
    .get(activity.stepRunId) as {
      stash: string | null;
      step_template_id: string;
      steps_json: string | null;
    } | undefined;
  if (!row?.stash || !row.steps_json) return activity;

  let stash: { block?: unknown; scoring?: unknown; proposal?: unknown };
  try { stash = JSON.parse(row.stash); } catch { return activity; }

  const steps = JSON.parse(row.steps_json) as Array<{ id: string; outputSchema?: unknown }>;
  const step = steps.find((s) => s.id === row.step_template_id);
  const schemaParse = WorkflowStepOutputSchema.safeParse(step?.outputSchema);
  if (!schemaParse.success) return activity;

  const scoringParse = StepResultScoringProposal.safeParse(stash.scoring);
  const confirmationSummary = buildConfirmationSummary(
    schemaParse.data,
    stash.block,
    scoringParse.success ? scoringParse.data : null,
    typeof stash.proposal === "string" ? stash.proposal : null,
  );
  return Activity.parse({ ...activity, confirmationSummary });
}

function enrichProviderRecovery(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "provider_recovery_pending") return activity;
  const row = db
    .prepare(
      "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?"
    )
    .get(activity.stepRunId) as { recovery: string | null } | undefined;
  if (!row?.recovery) return activity;
  return Activity.parse({
    ...activity,
    providerRecovery: ProviderRecoveryCheckpoint.parse(JSON.parse(row.recovery)),
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
              pending_question, recommendation_id, created_at, updated_at, completed_at
       FROM activities
       WHERE goal_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(goalId) as ActivityRow[];
  return rows
    .map((r) => rowToActivity(db, r))
    .map((a) => enrichStepResult(db, a))
    .map((a) => enrichConfirmationSummary(db, a))
    .map((a) => enrichProviderRecovery(db, a));
}
