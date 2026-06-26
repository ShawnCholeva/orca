import type Database from "better-sqlite3";
import { InterviewTurn } from "@orca/contracts";
import type { StepRunRow } from "./db-rows.js";
import { listArtifactsForRun } from "../artifacts/projection.js";

export function stepRunIdsByTemplateId(
  db: Database.Database,
  workflowRunId: string
): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT step_template_id, id FROM workflow_step_runs WHERE workflow_run_id = ?"
    )
    .all(workflowRunId) as Array<{ step_template_id: string; id: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.step_template_id] = row.id;
  return out;
}

export function artifactCountForStep(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE step_run_id = ?")
      .get(stepRunId) as { count: number }
  ).count;
}

export function retryCount(stepRun: StepRunRow): number {
  return (
    Math.max(stepRun.attempt - 1, 0) +
    (stepRun.revise_attempts ?? 0) +
    (stepRun.crash_retries ?? 0)
  );
}

export function hasActiveUnansweredQuestion(
  db: Database.Database,
  stepArtifacts: ReturnType<typeof listArtifactsForRun>,
  stepRunId: string
): boolean {
  const questionDecisions = db
    .prepare(
      "SELECT id FROM workflow_decisions WHERE step_run_id = ? AND decision_type = 'request_user_input'"
    )
    .all(stepRunId) as Array<{ id: string }>;
  if (questionDecisions.length === 0) return false;
  const answeredDecisionIds = new Set<string>();
  for (const artifact of stepArtifacts) {
    if (artifact.type !== "interview_turn") continue;
    const parsed = InterviewTurn.safeParse(JSON.parse(artifact.body));
    if (parsed.success) answeredDecisionIds.add(parsed.data.questionDecisionId);
  }
  return questionDecisions.some((d) => !answeredDecisionIds.has(d.id));
}

/**
 * Reads the step_output artifact body for a step run and parses it as an
 * object, stripping the reserved `_completion` envelope. Returns null when no
 * step_output exists or it is not a JSON object — that's the contract the gate
 * evaluation request expects for `sourceStepOutput`.
 */
export function readStepOutputAsRecord(
  db: Database.Database,
  runId: string,
  stepRunId: string
): Record<string, unknown> | null {
  const row = db
    .prepare(
      "SELECT body FROM workflow_artifacts WHERE workflow_run_id = ? AND step_run_id = ? AND type = 'step_output' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(runId, stepRunId) as { body: string } | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { _completion: _omit, ...rest } = parsed as Record<string, unknown>;
  return rest;
}
