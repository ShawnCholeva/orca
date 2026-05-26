import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DomainEvent, ModelProviderId } from "@orca/contracts";

import type { EventBus } from "../../../events.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../../events.js";

const STALE_WORKER_STATES = [
  "starting",
  "ready",
  "awaiting_input",
  "producing_decision",
] as const;

const STALE_ATTEMPT_STATUSES = ["pending", "running"] as const;

const DEFAULT_HEALTH_MAX_AGE_MS = 60_000;

interface StaleWorkerRow {
  id: string;
  provider_id: ModelProviderId;
  model: string;
  current_goal_id: string | null;
  current_workflow_run_id: string | null;
  current_step_run_id: string | null;
}

interface StaleAttemptRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  provider_id: ModelProviderId;
  transport: "one_shot" | "hidden_interactive" | "human_review";
}

interface ReconcileWorkerAttemptLinkRow {
  worker_id: string;
  attempt_id: string;
}

export interface ReconcileHiddenWorkersOnBootInput {
  db: Database.Database;
  bus: EventBus;
  now?: string;
  idFactory?: () => string;
}

export interface WorkerReuseCandidate {
  id: string;
  provider_id: ModelProviderId;
  model: string;
  state: "ready" | "awaiting_input";
  last_health_at: string | null;
}

export interface FindReusableWorkerInput {
  db: Database.Database;
  providerId: ModelProviderId;
  modelId: string;
  nowMs?: number;
  healthMaxAgeMs?: number;
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isWorkerHealthCurrent(
  lastHealthAt: string | null,
  nowMs: number,
  healthMaxAgeMs: number = DEFAULT_HEALTH_MAX_AGE_MS
): boolean {
  const healthMs = parseIsoMs(lastHealthAt);
  if (healthMs === null) return false;
  return nowMs - healthMs <= healthMaxAgeMs;
}

export function findReusableWorker(
  input: FindReusableWorkerInput
): WorkerReuseCandidate | null {
  const nowMs = input.nowMs ?? Date.now();
  const healthMaxAgeMs = input.healthMaxAgeMs ?? DEFAULT_HEALTH_MAX_AGE_MS;
  const rows = input.db
    .prepare(
      "SELECT id, provider_id, model, state, last_health_at FROM orchestration_workers WHERE provider_id = ? AND model = ? AND state IN ('ready', 'awaiting_input') ORDER BY last_health_at DESC, created_at DESC"
    )
    .all(input.providerId, input.modelId) as WorkerReuseCandidate[];

  for (const row of rows) {
    if (isWorkerHealthCurrent(row.last_health_at, nowMs, healthMaxAgeMs)) {
      return row;
    }
  }
  return null;
}

export function reconcileHiddenWorkersOnBoot(
  input: ReconcileHiddenWorkersOnBootInput
): void {
  const now = input.now ?? new Date().toISOString();
  const makeId = input.idFactory ?? randomUUID;

  const staged = input.db.transaction((): DomainEvent[] => {
    const staleWorkers = input.db
      .prepare(
        `SELECT id, provider_id, model, current_goal_id, current_workflow_run_id, current_step_run_id
           FROM orchestration_workers
          WHERE state IN (${STALE_WORKER_STATES.map(() => "?").join(",")})`
      )
      .all(...STALE_WORKER_STATES) as StaleWorkerRow[];

    const staleAttempts = input.db
      .prepare(
        `SELECT id, goal_id, workflow_run_id, step_run_id, provider_id, transport
           FROM orchestration_transport_attempts
          WHERE status IN (${STALE_ATTEMPT_STATUSES.map(() => "?").join(",")})`
      )
      .all(...STALE_ATTEMPT_STATUSES) as StaleAttemptRow[];

    const workerAttemptLinks = input.db
      .prepare(
        `SELECT worker_id, id AS attempt_id
           FROM orchestration_transport_attempts
          WHERE worker_id IS NOT NULL AND status IN ('pending', 'running')`
      )
      .all() as ReconcileWorkerAttemptLinkRow[];

    const attemptByWorker = new Map<string, string>();
    for (const row of workerAttemptLinks) {
      if (!attemptByWorker.has(row.worker_id)) {
        attemptByWorker.set(row.worker_id, row.attempt_id);
      }
    }

    if (staleWorkers.length > 0) {
      input.db
        .prepare(
          `UPDATE orchestration_workers
              SET state = 'failed',
                  failure_reason = 'daemon_restart',
                  failure_detail = 'reconciled at boot',
                  stopped_at = ?,
                  current_goal_id = NULL,
                  current_workflow_run_id = NULL,
                  current_step_run_id = NULL
            WHERE state IN (${STALE_WORKER_STATES.map(() => "?").join(",")})`
        )
        .run(now, ...STALE_WORKER_STATES);
    }

    if (staleAttempts.length > 0) {
      input.db
        .prepare(
          `UPDATE orchestration_transport_attempts
              SET status = 'failed',
                  failure_reason = 'daemon_restart',
                  failure_message = 'reconciled at boot',
                  finished_at = ?
            WHERE status IN (${STALE_ATTEMPT_STATUSES.map(() => "?").join(",")})`
        )
        .run(now, ...STALE_ATTEMPT_STATUSES);
    }

    const events: DomainEvent[] = [];
    for (const worker of staleWorkers) {
      if (!worker.current_goal_id || !worker.current_workflow_run_id) continue;
      events.push(
        appendWorkflowEvent(
          input.db,
          "workflow.worker.state_changed",
          {
            goalId: worker.current_goal_id,
            workflowRunId: worker.current_workflow_run_id,
            stepRunId: worker.current_step_run_id,
            attemptId: attemptByWorker.get(worker.id) ?? `reconcile-${worker.id}`,
            workerId: worker.id,
            providerId: worker.provider_id,
            transport: "hidden_interactive",
            status: "failed",
            failureReason: "daemon_restart",
          },
          now,
          makeId
        )
      );
    }

    for (const attempt of staleAttempts) {
      events.push(
        appendWorkflowEvent(
          input.db,
          "workflow.transport.attempt_finished",
          {
            goalId: attempt.goal_id,
            workflowRunId: attempt.workflow_run_id,
            stepRunId: attempt.step_run_id,
            attemptId: attempt.id,
            providerId: attempt.provider_id,
            transport: attempt.transport,
            status: "failed",
            failureReason: "daemon_restart",
          },
          now,
          makeId
        )
      );
    }

    return events;
  })();

  publishStagedWorkflowEvents(input.bus, staged);
}
