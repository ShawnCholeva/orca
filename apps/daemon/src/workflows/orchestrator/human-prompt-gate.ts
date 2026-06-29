import type Database from "better-sqlite3";

/**
 * The human-prompt gate (Governed axis). True iff a human prompt is already open
 * for this step run, across all channels — an unanswered, non-withdrawn
 * pending_question (worker OR orchestrator) or a paused step-confirmation card.
 *
 * Derived purely from the existing event-sourced projections; it holds no state
 * of its own, so release is automatic when a prompt is answered or resolved.
 * Distinct from the routing gates (workflow_gate_decisions) and permission-gate.ts.
 */
export function isHumanPromptOpen(db: Database.Database, stepRunId: string): boolean {
  const question = db
    .prepare(
      `SELECT 1 FROM orchestrator_messages
        WHERE pending_question IS NOT NULL
          AND json_extract(pending_question, '$.stepRunId') = ?
          AND json_extract(pending_question, '$.answer') IS NULL
          AND json_extract(pending_question, '$.withdrawn') IS NULL
        LIMIT 1`
    )
    .get(stepRunId);
  if (question !== undefined) return true;

  const card = db
    .prepare(
      `SELECT 1 FROM activities
        WHERE step_run_id = ?
          AND source_kind = 'step_confirmation_pending'
          AND status = 'paused_for_input'
        LIMIT 1`
    )
    .get(stepRunId);
  return card !== undefined;
}
