import type Database from "better-sqlite3";
import {
  OrchestratorChatMessage,
  PendingQuestion,
  type OrchestratorChatMessage as OrchestratorChatMessageT,
} from "@orca/contracts";

export function listOrchestratorMessagesByGoal(
  db: Database.Database,
  goalId: string
): OrchestratorChatMessageT[] {
  const rows = db
    .prepare(
      `SELECT id, goal_id, role, kind, body, correlation_id, created_at, raw_agent_text, why_rationale, internal_kind, pending_question
         FROM orchestrator_messages
        WHERE goal_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(goalId) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    let pendingQuestion: unknown = undefined;
    if (typeof row.pending_question === "string" && row.pending_question) {
      try {
        const parsed = JSON.parse(row.pending_question);
        if (PendingQuestion.safeParse(parsed).success) pendingQuestion = parsed;
      } catch { /* ignore malformed */ }
    }
    return OrchestratorChatMessage.parse({
      id: row.id,
      goalId: row.goal_id,
      role: row.role,
      kind: row.kind,
      body: row.body,
      correlationId: row.correlation_id ?? null,
      rawAgentText: row.raw_agent_text ?? null,
      whyRationale: row.why_rationale ?? null,
      internalKind: row.internal_kind ?? null,
      createdAt: row.created_at,
      ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
    });
  });
}
