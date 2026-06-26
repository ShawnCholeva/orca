import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DomainEvent, PendingQuestion as PendingQuestionT } from "@orca/contracts";
import type { RequestNextDecisionOptions } from "./service.js";

/**
 * Inserts a single orchestrator_messages row (role "orchestrator", kind
 * "message") and emits the orchestrator.message.created event, mirroring the
 * orchestrator-chat use case shape. Used for escalations and forwarded /
 * paraphrased agent messages.
 */
export function postOrchestratorMessage(
  db: Database.Database,
  now: () => string,
  goalId: string,
  body: string,
  options: RequestNextDecisionOptions,
  role: "orchestrator" | "user" = "orchestrator",
  pendingQuestion?: PendingQuestionT,
  pendingRevision?: { workflowRunId: string }
): void {
  const idFactory = options.idFactory ?? randomUUID;
  const messageId = idFactory();
  const correlationId = idFactory();
  const createdAt = now();
  const event = db.transaction(() => {
    db.prepare(
      `INSERT INTO orchestrator_messages
        (id, goal_id, role, kind, body, correlation_id, created_at, pending_question, pending_revision)
       VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?)`
    ).run(
      messageId,
      goalId,
      role,
      body,
      correlationId,
      createdAt,
      pendingQuestion ? JSON.stringify(pendingQuestion) : null,
      pendingRevision ? JSON.stringify(pendingRevision) : null
    );
    const payload = { messageId, role };
    const eventId = idFactory();
    const result = db
      .prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        eventId,
        "orchestrator.message.created",
        goalId,
        JSON.stringify(payload),
        createdAt
      );
    return {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "orchestrator.message.created",
      goalId,
      payload,
      createdAt,
    } satisfies DomainEvent;
  })();
  options.bus?.publish(event);
}
