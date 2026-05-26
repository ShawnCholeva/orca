import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  NextOrchestratorDecisionResponse,
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

export function registerOrchestrationTransportRoutes(
  server: FastifyInstance,
  deps: OrchestrationTransportRouteDeps
): void {
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
