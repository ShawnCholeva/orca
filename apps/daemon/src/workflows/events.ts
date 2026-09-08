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
  // The operator asked for the run to stop — recorded BEFORE anything acts on it,
  // and separately from `workflow.run.paused` (the state change that honours it).
  // Two facts, not one: the request is the operator's, the pause is the harness's,
  // and "did the harness do what it was told" is only answerable if both are on
  // the record. There was previously no event for the request at all, so a stop
  // that was ignored looked exactly like a stop that was never asked for.
  "workflow.run.stop_requested",
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
  // The revise budget ran out and the step went to a human. It produces no
  // completion and no relaunch, so without this event the strongest signal that a
  // step's instructions or verification are miscalibrated left no durable trace.
  "workflow.step.revise_capped",
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
  "workflow.human_review.requested",
  // Turn brackets, so the run's wall clock can be placed rather than inferred.
  // An orchestrator turn is one mediator invocation (judge, next decision, a user
  // message); a worker turn runs from a prompt landing in its composer to its Stop
  // hook. Both were the largest part of "unaccounted" on healthy runs.
  "workflow.orchestrator.turn_started",
  "workflow.orchestrator.turn_finished",
  "workflow.worker.prompted",
  "workflow.worker.responded"
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
