import type Database from "better-sqlite3";
import {
  OrchestratorChatMessage,
  type OrchestratorChatMessage as OrchestratorChatMessageT,
} from "@orca/contracts";

export function listOrchestratorMessagesByGoal(
  db: Database.Database,
  goalId: string
): OrchestratorChatMessageT[] {
  const rows = db
    .prepare(
      `SELECT id, goal_id, role, kind, body, correlation_id, created_at
         FROM orchestrator_messages
        WHERE goal_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(goalId) as Array<Record<string, unknown>>;

  return rows.map((row) =>
    OrchestratorChatMessage.parse({
      id: row.id,
      goalId: row.goal_id,
      role: row.role,
      kind: row.kind,
      body: row.body,
      correlationId: row.correlation_id ?? null,
      createdAt: row.created_at,
    })
  );
}
