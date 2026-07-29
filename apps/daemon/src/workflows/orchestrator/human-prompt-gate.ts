import type Database from "better-sqlite3";
import { PendingQuestion, type PendingQuestionItem } from "@orca/contracts";

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

/**
 * The step agent's own open question, if one is parked on the user. Free text
 * arriving while this is open is ambiguous — the user's answer, or a question
 * about the choices — so the mediator is shown the question to tell them apart.
 *
 * Worker-source only: an orchestrator-source question is one the mediator itself
 * raised, and its answer routes back as ordinary guidance rather than releasing
 * a held hook.
 */
export function readOpenWorkerQuestion(
  db: Database.Database,
  goalId: string,
  stepRunId: string
): { questionId: string; questions: PendingQuestionItem[] } | null {
  const row = db
    .prepare(
      `SELECT pending_question FROM orchestrator_messages
        WHERE goal_id = ?
          AND json_extract(pending_question, '$.stepRunId') = ?
          AND json_extract(pending_question, '$.source') = 'worker'
          AND json_extract(pending_question, '$.answer') IS NULL
          AND json_extract(pending_question, '$.withdrawn') IS NULL
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .get(goalId, stepRunId) as { pending_question: string } | undefined;
  if (!row) return null;
  const parsed = PendingQuestion.safeParse(JSON.parse(row.pending_question));
  if (!parsed.success) return null;
  return { questionId: parsed.data.questionId, questions: parsed.data.questions };
}
