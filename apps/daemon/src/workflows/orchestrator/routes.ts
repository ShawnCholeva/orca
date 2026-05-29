import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  NextOrchestratorDecisionResponse,
  RequestNextOrchestratorDecisionRequest,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type { OperatorSelector } from "../operators/selector.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { getWorkflowRunById } from "../runs/projection.js";
import {
  OrchestratorGoalNotFoundError,
  OrchestratorRunNotActiveError,
  OrchestratorRunNotFoundError,
  OrchestratorService,
  OrchestratorStepNotFoundError,
  OrchestratorTemplateNotFoundError,
  type StepDispatchCapabilities,
} from "./service.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";

export interface OrchestratorRouteDeps {
  db: Database.Database;
  bus: EventBus;
  operatorSelector: Pick<OperatorSelector, "select">;
  orchestrationTransportBroker: Pick<OrchestrationTransportBroker, "propose">;
  operatorRegistry: Pick<OperatorRegistry, "list">;
  workflowSessionLauncher?: WorkflowSessionLauncher;
  stepDispatch?: StepDispatchCapabilities;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerOrchestratorRoutes(
  server: FastifyInstance,
  deps: OrchestratorRouteDeps
): void {
  const service = new OrchestratorService(
    deps.operatorSelector,
    deps.orchestrationTransportBroker,
    deps.operatorRegistry,
    deps.workflowSessionLauncher,
    undefined,
    deps.stepDispatch
  );

  server.post("/v1/goals/:goalId/workflow-runs/:id/next-decision", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const parsed = RequestNextOrchestratorDecisionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    if (parsed.data.workflowRunId !== id) {
      reply.status(400);
      return apiError("validation_failed", "workflowRunId in body must match route id");
    }

    const run = getWorkflowRunById(deps.db, id);
    if (!run || run.goalId !== goalId) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }

    try {
      const result = await service.requestNextDecision(
        deps.db,
        deps.now ?? (() => new Date().toISOString()),
        id,
        {
          bus: deps.bus,
          idFactory: deps.idFactory,
        }
      );
      return NextOrchestratorDecisionResponse.parse(result);
    } catch (error) {
      if (
        error instanceof OrchestratorRunNotFoundError ||
        error instanceof OrchestratorGoalNotFoundError ||
        error instanceof OrchestratorStepNotFoundError ||
        error instanceof OrchestratorTemplateNotFoundError
      ) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof OrchestratorRunNotActiveError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
