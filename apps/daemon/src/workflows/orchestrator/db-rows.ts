import type Database from "better-sqlite3";
import type { ModelProviderId, StepAgentChoice } from "@orca/contracts";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";

export interface GoalRow {
  id: string;
  title: string;
  intent: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
  success_criteria: string | null;
}

export interface StepRunRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  attempt: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  selected_operator_id: string | null;
  selected_model_id: string | null;
  revise_attempts: number;
  crash_retries: number;
  step_result_json: string | null;
  pending_provider_recovery_json: string | null;
  pending_completion_json: string | null;
  pending_judge_json: string | null;
  pending_revision_json: string | null;
  pending_worker_question_id: string | null;
  pending_worker_answer_json: string | null;
}

/**
 * The step's work is done and the run is parked on a human decision with the
 * step as its cursor: `finished_at` set (mark-done, a judge retry, a recovery
 * choice) or its completion stashed for the reader's OK (the confirmation
 * card). Nothing there is a worker's to do, so a worker found gone is
 * bookkeeping, not a crash, and nothing respawns one: a respawn redid the whole
 * step under the card the reader was looking at, once per daemon restart.
 * Boot resume, the liveness watchdog and the respawn guard share this one
 * predicate; a revise on a card whose worker is gone relaunches deliberately,
 * with the revision in the fresh worker's prompt.
 */
export function stepWorkDoneSql(alias: string): string {
  return `(${alias}.finished_at IS NOT NULL OR ${alias}.pending_completion_json IS NOT NULL)`;
}

export function stepWorkDone(row: Pick<StepRunRow, "finished_at" | "pending_completion_json">): boolean {
  return row.finished_at !== null || row.pending_completion_json !== null;
}

export class OrchestratorStepNotFoundError extends Error {
  readonly code = "workflow_step_run_not_found" as const;

  constructor(stepRunId: string | null) {
    super(`Workflow step run not found: ${stepRunId ?? "null"}`);
    this.name = "OrchestratorStepNotFoundError";
  }
}

export class OrchestratorGoalNotFoundError extends Error {
  readonly code = "goal_not_found" as const;

  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "OrchestratorGoalNotFoundError";
  }
}

export function readStepRun(db: Database.Database, stepRunId: string | null): StepRunRow {
  if (!stepRunId) throw new OrchestratorStepNotFoundError(stepRunId);
  const row = db
    .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as StepRunRow | undefined;
  if (!row) throw new OrchestratorStepNotFoundError(stepRunId);
  return row;
}

export function readGoal(db: Database.Database, goalId: string): GoalRow {
  const row = db
    .prepare(
      "SELECT id, title, intent, orchestrator_provider, orchestrator_model, success_criteria FROM goals WHERE id = ?",
    )
    .get(goalId) as GoalRow | undefined;
  if (!row) throw new OrchestratorGoalNotFoundError(goalId);
  return row;
}

export function goalSuccessCriteria(row: Pick<GoalRow, "success_criteria">): string[] {
  if (!row.success_criteria) return [];
  try {
    const v = JSON.parse(row.success_criteria);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function preferencesForGoal(
  preferences: StepAgentChoice[],
  orchestratorProvider: GoalRow["orchestrator_provider"]
): StepAgentChoice[] {
  if (!orchestratorProvider) return preferences;
  const preferredAdapterId = adapterIdForProvider(orchestratorProvider);
  if (!preferences.some((pref) => pref.adapterId === preferredAdapterId)) return preferences;
  return [
    ...preferences.filter((pref) => pref.adapterId === preferredAdapterId),
    ...preferences.filter((pref) => pref.adapterId !== preferredAdapterId),
  ];
}
