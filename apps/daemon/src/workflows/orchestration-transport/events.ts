import type Database from "better-sqlite3";
import type {
  DomainEvent,
  OrchestrationWorkerState,
  OrchestrationTransportAttemptStatus,
  OrchestrationTransportFailureReason,
} from "@orca/contracts";

import { appendWorkflowEvent } from "../events.js";
import type { TransportAttemptIdentity } from "./types.js";

type EventIdFactory = () => string;

export function appendTransportAttemptStartedEvent(
  db: Database.Database,
  attempt: TransportAttemptIdentity,
  status: OrchestrationTransportAttemptStatus,
  now: string,
  idFactory?: EventIdFactory
): DomainEvent {
  return appendWorkflowEvent(
    db,
    "workflow.transport.attempt_started",
    {
      goalId: attempt.goalId,
      workflowRunId: attempt.workflowRunId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.attemptId,
      providerId: attempt.providerId,
      transport: attempt.transport,
      status,
    },
    now,
    idFactory
  );
}

export function appendTransportAttemptFinishedEvent(
  db: Database.Database,
  attempt: TransportAttemptIdentity,
  status: OrchestrationTransportAttemptStatus,
  now: string,
  failureReason?: OrchestrationTransportFailureReason,
  idFactory?: EventIdFactory
): DomainEvent {
  const payload: Record<string, unknown> = {
    goalId: attempt.goalId,
    workflowRunId: attempt.workflowRunId,
    stepRunId: attempt.stepRunId,
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    transport: attempt.transport,
    status,
  };
  if (failureReason) payload.failureReason = failureReason;

  return appendWorkflowEvent(
    db,
    "workflow.transport.attempt_finished",
    payload,
    now,
    idFactory
  );
}

export function appendTransportFallbackEvent(
  db: Database.Database,
  attempt: TransportAttemptIdentity,
  failureReason: OrchestrationTransportFailureReason,
  now: string,
  idFactory?: EventIdFactory
): DomainEvent {
  return appendWorkflowEvent(
    db,
    "workflow.transport.fallback",
    {
      goalId: attempt.goalId,
      workflowRunId: attempt.workflowRunId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.attemptId,
      providerId: attempt.providerId,
      transport: attempt.transport,
      status: "fallback",
      failureReason,
    },
    now,
    idFactory
  );
}

export function appendWorkerStateChangedEvent(
  db: Database.Database,
  attempt: TransportAttemptIdentity,
  workerId: string,
  status: OrchestrationWorkerState,
  now: string,
  failureReason?: OrchestrationTransportFailureReason,
  idFactory?: EventIdFactory
): DomainEvent {
  const payload: Record<string, unknown> = {
    goalId: attempt.goalId,
    workflowRunId: attempt.workflowRunId,
    stepRunId: attempt.stepRunId,
    attemptId: attempt.attemptId,
    workerId,
    providerId: attempt.providerId,
    transport: "hidden_interactive",
    status,
  };
  if (failureReason) payload.failureReason = failureReason;

  return appendWorkflowEvent(
    db,
    "workflow.worker.state_changed",
    payload,
    now,
    idFactory
  );
}

export function appendHumanReviewRequestedEvent(
  db: Database.Database,
  attempt: TransportAttemptIdentity,
  status: OrchestrationTransportAttemptStatus,
  now: string,
  idFactory?: EventIdFactory
): DomainEvent {
  return appendWorkflowEvent(
    db,
    "workflow.human_review.requested",
    {
      goalId: attempt.goalId,
      workflowRunId: attempt.workflowRunId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.attemptId,
      providerId: attempt.providerId,
      transport: "human_review",
      status,
    },
    now,
    idFactory
  );
}
