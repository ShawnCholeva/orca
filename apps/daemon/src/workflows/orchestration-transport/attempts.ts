import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type DomainEvent,
  type OrchestrationTransportAttemptStatus,
  type OrchestrationTransportFailureReason,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { ProviderError, type ProviderFailureCode } from "../../llm/types.js";
import { redactSecrets } from "../../memory/normalize.js";
import { publishStagedWorkflowEvents } from "../events.js";
import {
  appendTransportAttemptFinishedEvent,
  appendTransportAttemptStartedEvent,
  appendTransportFallbackEvent,
} from "./events.js";
import type {
  CreateTransportAttemptInput,
  FinishTransportAttemptInput,
  TransportAttemptIdentity,
  TransportAttemptRow,
} from "./types.js";

export interface TransportAttemptUsecaseCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

type InsertAttemptParams = [
  string,
  string,
  string,
  string | null,
  string | null,
  string,
  string,
  string,
  string | null,
  string,
  null,
  null,
  null,
  null,
  string,
  string,
  null,
];

const PROVIDER_FAILURE_REASON: Record<
  ProviderFailureCode,
  OrchestrationTransportFailureReason
> = {
  invalid_output: "one_shot_parse_failed",
  rate_limited: "one_shot_rate_limited",
  missing_api_key: "one_shot_unavailable",
  provider_error: "one_shot_unavailable",
  timeout: "one_shot_unavailable",
  internal_error: "one_shot_unavailable",
};

function nowIso(ctx: TransportAttemptUsecaseCtx): string {
  return ctx.now?.() ?? new Date().toISOString();
}

function idFactory(ctx: TransportAttemptUsecaseCtx): () => string {
  return ctx.idFactory ?? randomUUID;
}

function sanitizeFailureMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const sanitized = redactSecrets(message.trim()).slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );
  return sanitized.length > 0 ? sanitized : null;
}

function requireAttempt(db: Database.Database, attemptId: string): TransportAttemptRow {
  const row = db
    .prepare("SELECT * FROM orchestration_transport_attempts WHERE id = ?")
    .get(attemptId) as TransportAttemptRow | undefined;
  if (!row) throw new Error(`Orchestration transport attempt not found: ${attemptId}`);
  return row;
}

function toIdentity(row: TransportAttemptRow): TransportAttemptIdentity {
  return {
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    attemptId: row.id,
    providerId: row.provider_id,
    transport: row.transport,
  };
}

function updateAttemptStatus(
  ctx: TransportAttemptUsecaseCtx,
  status: OrchestrationTransportAttemptStatus,
  input: FinishTransportAttemptInput
): TransportAttemptRow {
  const now = nowIso(ctx);
  const makeId = idFactory(ctx);
  const staged = ctx.db.transaction(() => {
    const row = requireAttempt(ctx.db, input.attemptId);
    const failureReason = input.failureReason ?? null;
    ctx.db
      .prepare(
        "UPDATE orchestration_transport_attempts SET status = ?, failure_reason = ?, failure_message = ?, raw_text_length = COALESCE(?, raw_text_length), latency_ms = COALESCE(?, latency_ms), finished_at = ? WHERE id = ?"
      )
      .run(
        status,
        failureReason,
        sanitizeFailureMessage(input.failureMessage),
        input.rawTextLength ?? null,
        input.latencyMs ?? null,
        now,
        input.attemptId
      );

    const identity = toIdentity(row);
    const event =
      status === "fallback"
        ? appendTransportFallbackEvent(
            ctx.db,
            identity,
            failureReason ?? "proposal_rejected",
            now,
            makeId
          )
        : appendTransportAttemptFinishedEvent(
            ctx.db,
            identity,
            status,
            now,
            failureReason ?? undefined,
            makeId
          );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireAttempt(ctx.db, input.attemptId);
}

export function mapProviderErrorToTransportFailureReason(
  error: ProviderError | ProviderFailureCode
): OrchestrationTransportFailureReason {
  const code = error instanceof ProviderError ? error.code : error;
  return PROVIDER_FAILURE_REASON[code];
}

export function createPendingTransportAttempt(
  ctx: TransportAttemptUsecaseCtx,
  input: CreateTransportAttemptInput
): TransportAttemptRow {
  const now = nowIso(ctx);
  const makeId = idFactory(ctx);
  const attemptId = makeId();
  const staged = ctx.db.transaction(() => {
    const params: InsertAttemptParams = [
      attemptId,
      input.goalId,
      input.workflowRunId,
      input.stepRunId,
      input.decisionId ?? null,
      input.providerId,
      input.modelId,
      input.transport,
      input.workerId ?? null,
      "pending",
      null,
      null,
      null,
      null,
      input.inputFingerprint,
      now,
      null,
    ];
    ctx.db
      .prepare(
        "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(...params);

    const identity: TransportAttemptIdentity = {
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      attemptId,
      providerId: input.providerId,
      transport: input.transport,
    };
    const event = appendTransportAttemptStartedEvent(
      ctx.db,
      identity,
      "pending",
      now,
      makeId
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireAttempt(ctx.db, attemptId);
}

export function markTransportAttemptRunning(
  ctx: TransportAttemptUsecaseCtx,
  attemptId: string
): TransportAttemptRow {
  const now = nowIso(ctx);
  const makeId = idFactory(ctx);
  const staged = ctx.db.transaction((): DomainEvent[] => {
    const row = requireAttempt(ctx.db, attemptId);
    ctx.db
      .prepare("UPDATE orchestration_transport_attempts SET status = ? WHERE id = ?")
      .run("running", attemptId);
    const event = appendTransportAttemptStartedEvent(
      ctx.db,
      toIdentity(row),
      "running",
      now,
      makeId
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireAttempt(ctx.db, attemptId);
}

export function markTransportAttemptSucceeded(
  ctx: TransportAttemptUsecaseCtx,
  input: Omit<FinishTransportAttemptInput, "failureReason" | "failureMessage">
): TransportAttemptRow {
  return updateAttemptStatus(ctx, "succeeded", input);
}

export function markTransportAttemptRejected(
  ctx: TransportAttemptUsecaseCtx,
  input: FinishTransportAttemptInput
): TransportAttemptRow {
  return updateAttemptStatus(ctx, "rejected", {
    ...input,
    failureReason: input.failureReason ?? "proposal_rejected",
  });
}

export function markTransportAttemptFailed(
  ctx: TransportAttemptUsecaseCtx,
  input: FinishTransportAttemptInput & {
    failureReason: OrchestrationTransportFailureReason;
  }
): TransportAttemptRow {
  return updateAttemptStatus(ctx, "failed", input);
}

export function markTransportAttemptFallback(
  ctx: TransportAttemptUsecaseCtx,
  input: FinishTransportAttemptInput & {
    failureReason: OrchestrationTransportFailureReason;
  }
): TransportAttemptRow {
  return updateAttemptStatus(ctx, "fallback", input);
}
