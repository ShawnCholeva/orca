import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { DomainEvent } from "@orca/contracts";

import type { EventBus } from "../events.js";

const WORKFLOW_EVENT_MAX_PAYLOAD_BYTES = 4096;

const WORKFLOW_EVENT_TYPE_VALUES = [
  "workflow.template.created",
  "workflow.template.updated",
  "workflow.template.duplicated",
  "workflow.run.started",
  "workflow.run.paused",
  "workflow.run.blocked",
  "workflow.run.completed",
  "workflow.run.failed",
  "workflow.run.cancelled",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.blocked",
  "workflow.step.skipped",
  "workflow.step.failed",
  "workflow.step.phase_changed",
  "workflow.artifact.created",
  "workflow.guardrail.evaluated",
  "workflow.operator.selected",
  "workflow.decision.requested",
  "workflow.decision.recorded",
  "workflow.user.input.requested",
  "workflow.user.input.submitted",
  "workflow.recommendation.created",
  "workflow.recommendation.accepted",
  "workflow.recommendation.rejected",
  "workflow.task.dag.created",
  "workflow.task.dag.updated",
  "workflow.validation.run",
  "workflow.validation.passed",
  "workflow.validation.failed",
  "workflow.validation.skipped",
  "workflow.transport.attempt_started",
  "workflow.transport.attempt_finished",
  "workflow.transport.fallback",
  "workflow.worker.state_changed",
  "workflow.human_review.requested"
] as const;

const WORKFLOW_EVENT_TYPES = new Set<string>(WORKFLOW_EVENT_TYPE_VALUES);

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPE_VALUES)[number];

type EventInsertStmts = {
  insertEvent: Database.Statement;
};

let _db: Database.Database | null = null;
let _stmts: EventInsertStmts | null = null;

function ensureStmts(db: Database.Database): EventInsertStmts {
  if (_db !== db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      )
    };
  }
  return _stmts!;
}

export function resetWorkflowEventPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function inferGoalId(payload: Record<string, unknown>): string | null {
  const goalId = payload.goalId;
  return typeof goalId === "string" && goalId.length > 0 ? goalId : null;
}

export function appendWorkflowEvent(
  db: Database.Database,
  type: WorkflowEventType,
  payload: Record<string, unknown>,
  now: string,
  idFactory: () => string = randomUUID
): DomainEvent {
  if (!WORKFLOW_EVENT_TYPES.has(type)) {
    throw new Error(`unsupported workflow event type: ${type}`);
  }

  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > WORKFLOW_EVENT_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `workflow event payload exceeds ${WORKFLOW_EVENT_MAX_PAYLOAD_BYTES} bytes`
    );
  }

  const eventId = idFactory();
  const goalId = inferGoalId(payload);
  const result = ensureStmts(db).insertEvent.run(
    eventId,
    type,
    goalId,
    payloadJson,
    now
  );
  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type: type as DomainEvent["type"],
    goalId,
    payload,
    createdAt: now
  };
}

export function publishStagedWorkflowEvents(
  bus: EventBus,
  stagedEvents: DomainEvent[]
): void {
  for (const event of stagedEvents) {
    bus.publish(event);
  }
}
