import type Database from "better-sqlite3";
import type { ModelProviderId, StepAgentChoice } from "@orca/contracts";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";

export interface GoalRow {
  id: string;
  title: string;
  description: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
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
  selected_operator_id: string | null;
  selected_model_id: string | null;
  revise_attempts: number;
  crash_retries: number;
  step_result_json: string | null;
  pending_provider_recovery_json: string | null;
  pending_judge_json: string | null;
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
      "SELECT id, title, description, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?",
    )
    .get(goalId) as GoalRow | undefined;
  if (!row) throw new OrchestratorGoalNotFoundError(goalId);
  return row;
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
