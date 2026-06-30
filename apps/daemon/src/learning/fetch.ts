import type Database from "better-sqlite3";

export type TemplateRevisionSignal = {
  id: string;
  stepTemplateId: string;
  feedbackText: string | null;
  createdAt: string;
};

// Portable JSON-free join: step_revision_signals -> workflow_step_runs (step_template_id)
// -> workflow_runs (template_id), windowed on the signal's created_at.
export function listRevisionSignalsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string,
): TemplateRevisionSignal[] {
  const rows = db.prepare(
    `SELECT srs.id AS id, wsr.step_template_id AS step_template_id,
            srs.feedback_text AS feedback_text, srs.created_at AS created_at
     FROM step_revision_signals srs
     JOIN workflow_step_runs wsr ON wsr.id = srs.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     WHERE wr.template_id = ? AND srs.created_at >= ? AND srs.created_at < ?
     ORDER BY srs.created_at ASC, srs.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    id: string; step_template_id: string; feedback_text: string | null; created_at: string;
  }[];
  return rows.map((r) => ({ id: r.id, stepTemplateId: r.step_template_id, feedbackText: r.feedback_text, createdAt: r.created_at }));
}
