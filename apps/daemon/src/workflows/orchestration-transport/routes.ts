import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  HumanReviewPayload,
  GetOrchestrationWorkerResponse,
  ListOrchestrationAttemptsResponse,
  ListOrchestrationWorkersResponse,
  NextOrchestratorDecisionResponse,
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  SubmitHumanReviewDecisionRequest,
  type OperatorDescriptor,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import {
  HumanReviewNotFoundError,
  HumanReviewNotPendingError,
  HumanReviewProposalRejectedError,
  HumanReviewValidationError,
  submitHumanReviewDecision,
} from "./human-review.js";

export interface OrchestrationTransportRouteDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
  listOperators: (goalId: string) => Promise<OperatorDescriptor[]>;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

const AttemptQuery = z
  .object({
    workflowRunId: z.string().min(1),
  })
  .strict();

function latestAttemptForWorker(db: Database.Database, workerId: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM orchestration_transport_attempts WHERE worker_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    .get(workerId) as { id: string } | undefined;
  return row?.id ?? null;
}

function diagnosticsForAttempt(row: { failure_reason: string | null; failure_message: string | null }): string | null {
  if (!row.failure_reason && !row.failure_message) return null;
  if (row.failure_reason && row.failure_message) {
    return `${row.failure_reason}: ${row.failure_message}`;
  }
  return row.failure_reason ?? row.failure_message;
}

function humanReviewForAttempt(
  db: Database.Database,
  attemptId: string
): z.infer<typeof HumanReviewPayload> | undefined {
  const row = db
    .prepare(
      "SELECT payload_json, status FROM orchestration_human_reviews WHERE attempt_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    .get(attemptId) as { payload_json: string; status: string } | undefined;
  if (!row || row.status !== "pending") return undefined;

  try {
    const parsed = HumanReviewPayload.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function mapHookTraceStatus(
  input: "started" | "succeeded" | "blocked" | "failed" | "skipped"
): "skipped" | "succeeded" | "failed" {
  if (input === "succeeded") return "succeeded";
  if (input === "skipped") return "skipped";
  return "failed";
}

function capTailText(buffer: Buffer): string {
  if (buffer.length <= ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES) {
    return buffer.toString("utf8");
  }
  return buffer
    .subarray(buffer.length - ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES)
    .toString("utf8");
}

export function registerOrchestrationTransportRoutes(
  server: FastifyInstance,
  deps: OrchestrationTransportRouteDeps
): void {
  server.get("/v1/goals/:goalId/orchestration-attempts", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = AttemptQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    const run = deps.db
      .prepare("SELECT id FROM workflow_runs WHERE id = ? AND goal_id = ?")
      .get(parsed.data.workflowRunId, goalId) as { id: string } | undefined;
    if (!run) {
      reply.status(404);
      return apiError("workflow_run_not_found", "Workflow run not found for goal");
    }

    const attempts = deps.db
      .prepare(
        "SELECT id, goal_id, workflow_run_id, step_run_id, provider_id, model, transport, status, failure_reason, failure_message, worker_id, created_at, finished_at FROM orchestration_transport_attempts WHERE goal_id = ? AND workflow_run_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(goalId, parsed.data.workflowRunId) as Array<{
      id: string;
      goal_id: string;
      workflow_run_id: string;
      step_run_id: string | null;
      provider_id: string;
      model: string;
      transport: "one_shot" | "hidden_interactive" | "human_review";
      status: "pending" | "running" | "succeeded" | "rejected" | "failed" | "fallback";
      failure_reason: string | null;
      failure_message: string | null;
      worker_id: string | null;
      created_at: string;
      finished_at: string | null;
    }>;

    return ListOrchestrationAttemptsResponse.parse({
      attempts: attempts.map((row) => {
        const humanReview =
          row.transport === "human_review"
            ? humanReviewForAttempt(deps.db, row.id)
            : undefined;
        return {
          id: row.id,
          goalId: row.goal_id,
          workflowRunId: row.workflow_run_id,
          stepRunId: row.step_run_id,
          kind: "select_operator",
          providerId: row.provider_id,
          modelId: row.model,
          transport: row.transport,
          status: row.status,
          failureReason: row.failure_reason,
          failureMessage: row.failure_message,
          diagnostics: diagnosticsForAttempt(row),
          workerId: row.worker_id,
          startedAt: row.created_at,
          finishedAt: row.finished_at,
          createdAt: row.created_at,
          ...(humanReview ? { humanReview } : {}),
        };
      }),
    });
  });

  server.get("/v1/orchestration-workers", async () => {
    const workers = deps.db
      .prepare(
        "SELECT id, provider_id, model, state, current_goal_id, current_workflow_run_id, failure_reason, failure_detail, last_health_at, created_at FROM orchestration_workers ORDER BY created_at DESC, id DESC"
      )
      .all() as Array<{
      id: string;
      provider_id: string;
      model: string;
      state:
        | "starting"
        | "ready"
        | "awaiting_input"
        | "producing_decision"
        | "hung"
        | "auth_required"
        | "failed"
        | "stopped";
      current_goal_id: string | null;
      current_workflow_run_id: string | null;
      failure_reason: string | null;
      failure_detail: string | null;
      last_health_at: string | null;
      created_at: string;
    }>;

    return ListOrchestrationWorkersResponse.parse({
      workers: workers.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        modelId: row.model,
        state: row.state,
        currentGoalId: row.current_goal_id,
        currentWorkflowRunId: row.current_workflow_run_id,
        currentAttemptId: latestAttemptForWorker(deps.db, row.id),
        failureReason: row.failure_reason,
        failureMessage: row.failure_detail,
        healthCheckedAt: row.last_health_at,
        createdAt: row.created_at,
        updatedAt: row.last_health_at ?? row.created_at,
      })),
    });
  });

  server.get("/v1/orchestration-workers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const worker = deps.db
      .prepare(
        "SELECT id, provider_id, model, state, current_goal_id, current_workflow_run_id, failure_reason, failure_detail, last_health_at, created_at FROM orchestration_workers WHERE id = ?"
      )
      .get(id) as
      | {
          id: string;
          provider_id: string;
          model: string;
          state:
            | "starting"
            | "ready"
            | "awaiting_input"
            | "producing_decision"
            | "hung"
            | "auth_required"
            | "failed"
            | "stopped";
          current_goal_id: string | null;
          current_workflow_run_id: string | null;
          failure_reason: string | null;
          failure_detail: string | null;
          last_health_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!worker) {
      reply.status(404);
      return apiError("orchestration_worker_not_found", "Orchestration worker not found");
    }

    const hookTraces = deps.db
      .prepare(
        "SELECT id, worker_id, hook_event_name, hook_status, summary, created_at FROM orchestration_worker_hook_traces WHERE worker_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
      )
      .all(id) as Array<{
      id: string;
      worker_id: string;
      hook_event_name: string;
      hook_status: "started" | "succeeded" | "blocked" | "failed" | "skipped";
      summary: string;
      created_at: string;
    }>;

    const outputTailRow = deps.db
      .prepare(
        "SELECT data FROM orchestration_worker_output_chunks WHERE worker_id = ? ORDER BY seq DESC LIMIT 1"
      )
      .get(id) as { data: Buffer } | undefined;

    return GetOrchestrationWorkerResponse.parse({
      worker: {
        id: worker.id,
        providerId: worker.provider_id,
        modelId: worker.model,
        state: worker.state,
        currentGoalId: worker.current_goal_id,
        currentWorkflowRunId: worker.current_workflow_run_id,
        currentAttemptId: latestAttemptForWorker(deps.db, worker.id),
        failureReason: worker.failure_reason,
        failureMessage: worker.failure_detail,
        healthCheckedAt: worker.last_health_at,
        createdAt: worker.created_at,
        updatedAt: worker.last_health_at ?? worker.created_at,
        hookCapabilities: null,
        hookTraces: hookTraces.map((trace) => ({
          id: trace.id,
          workerId: trace.worker_id,
          hookName: trace.hook_event_name,
          status: mapHookTraceStatus(trace.hook_status),
          summary: trace.summary,
          startedAt: trace.created_at,
          finishedAt: trace.created_at,
        })),
        outputTail: outputTailRow?.data ? capTailText(outputTailRow.data) : null,
      },
    });
  });

  server.post(
    "/v1/goals/:goalId/workflow-runs/:runId/human-review/:attemptId",
    async (request, reply) => {
      const { goalId, runId, attemptId } = request.params as {
        goalId: string;
        runId: string;
        attemptId: string;
      };
      const parsed = SubmitHumanReviewDecisionRequest.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: "validation_failed", issues: parsed.error.issues };
      }

      try {
        const result = await submitHumanReviewDecision(
          {
            db: deps.db,
            bus: deps.bus,
            now: deps.now,
            idFactory: deps.idFactory,
            listOperators: deps.listOperators,
          },
          {
            goalId,
            workflowRunId: runId,
            attemptId,
            request: parsed.data,
          }
        );
        return NextOrchestratorDecisionResponse.parse(result);
      } catch (error) {
        if (error instanceof HumanReviewNotFoundError) {
          reply.status(404);
          return apiError(error.code, error.message);
        }
        if (error instanceof HumanReviewNotPendingError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        if (error instanceof HumanReviewValidationError) {
          reply.status(400);
          return apiError(error.code, error.message);
        }
        if (error instanceof HumanReviewProposalRejectedError) {
          reply.status(409);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }
  );
}
