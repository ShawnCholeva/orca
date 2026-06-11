import type Database from "better-sqlite3";
import { StepRevisionSignal, type StepResultScoringProposal } from "@orca/contracts";

export function recordRevisionSignal(
  db: Database.Database,
  input: {
    id: string;
    stepRunId: string;
    goalId: string;
    supersededScoring: StepResultScoringProposal;
    feedbackText: string | null;
    now: string;
  }
): void {
  const priorCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM step_revision_signals WHERE step_run_id = ?")
      .get(input.stepRunId) as { c: number }
  ).c;
  db.prepare(
    `INSERT INTO step_revision_signals
       (id, step_run_id, goal_id, revision_index, superseded_scoring_json, feedback_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.stepRunId,
    input.goalId,
    priorCount,
    JSON.stringify(input.supersededScoring),
    input.feedbackText,
    input.now
  );
}

export function listRevisionSignals(
  db: Database.Database,
  stepRunId: string
): StepRevisionSignal[] {
  const rows = db
    .prepare(
      "SELECT * FROM step_revision_signals WHERE step_run_id = ? ORDER BY revision_index ASC"
    )
    .all(stepRunId) as {
    id: string;
    step_run_id: string;
    goal_id: string;
    revision_index: number;
    superseded_scoring_json: string;
    feedback_text: string | null;
    created_at: string;
  }[];
  return rows.map((r) =>
    StepRevisionSignal.parse({
      id: r.id,
      stepRunId: r.step_run_id,
      goalId: r.goal_id,
      revisionIndex: r.revision_index,
      supersededScoring: JSON.parse(r.superseded_scoring_json),
      feedbackText: r.feedback_text,
      createdAt: r.created_at
    })
  );
}
