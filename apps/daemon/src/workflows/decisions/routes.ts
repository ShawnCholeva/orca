import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  ListWorkflowDecisionsResponse,
  WorkflowDecisionResponse,
} from "@orca/contracts";

import { getWorkflowRunById } from "../runs/projection.js";
import { getDecisionById, listDecisionsForRun } from "./usecases.js";

export interface WorkflowDecisionRouteDeps {
  db: Database.Database;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerWorkflowDecisionRoutes(
  server: FastifyInstance,
  deps: WorkflowDecisionRouteDeps
): void {
  server.get("/v1/goals/:goalId/workflow-runs/:id/decisions", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const run = getWorkflowRunById(deps.db, id);
    if (!run || run.goalId !== goalId) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }

    return ListWorkflowDecisionsResponse.parse({
      decisions: listDecisionsForRun(deps.db, id),
    });
  });

  server.get("/v1/goals/:goalId/workflow-decisions/:id", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const decision = getDecisionById(deps.db, id);
    if (!decision || decision.goalId !== goalId) {
      reply.status(404);
      return apiError(
        "workflow_decision_not_found",
        `Workflow decision not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowDecisionResponse.parse({ decision });
  });
}
