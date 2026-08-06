import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  NextOrchestratorDecisionResponse,
  RequestNextOrchestratorDecisionRequest,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { getWorkflowRunById } from "../runs/projection.js";
import {
  OrchestratorRunNotActiveError,
  OrchestratorRunNotFoundError,
  OrchestratorTemplateNotFoundError,
  type StepDispatchCapabilities,
} from "./dispatch-types.js";
import {
  OrchestratorGoalNotFoundError,
  OrchestratorStepNotFoundError,
} from "./db-rows.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { DispatchEngine } from "./dispatch-engine.js";

export interface OrchestratorRouteDeps {
  db: Database.Database;
  bus: EventBus;
  orchestrationTransportBroker: Pick<OrchestrationTransportBroker, "propose">;
  operatorRegistry: Pick<OperatorRegistry, "list">;
  workflowSessionLauncher?: WorkflowSessionLauncher;
  stepDispatch?: StepDispatchCapabilities;
  /** Runs the launched step's session as a headless tmux worker. Without this,
   *  next-decision's launch follow-through would only create a session row. */
  workerSpawn?: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>;
  /** Submits the composed initial objective to the freshly-spawned worker. */
  workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
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
  const dispatchEngine = new DispatchEngine(
    deps.orchestrationTransportBroker,
    deps.operatorRegistry,
    deps.workflowSessionLauncher ?? { launch: async () => { throw new Error("direct_launch_unsupported"); } },
    deps.stepDispatch,
    deps.workerSpawn,
    deps.workerDeliver,
    undefined
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

    const now = deps.now ?? (() => new Date().toISOString());
    try {
      const result = await dispatchEngine.requestNextDecision(deps.db, now, id, {
        bus: deps.bus,
        idFactory: deps.idFactory,
      });
      const response = NextOrchestratorDecisionResponse.parse(result);

      // Follow-through: requestNextDecision only *selects* the current step's
      // operator (see DispatchEngine.requestNextDecision's doc comment) — this
      // is the only client-facing route that drives dispatch for a run started
      // through the HTTP API, so launch the worker here or it parks forever.
      // Best-effort: a launch failure must not turn a successful decision into
      // a 500 (spawnStepAgent already posts a chat message on its own launch
      // failure; this just guards against the few paths it doesn't wrap).
      try {
        await dispatchEngine.launchCurrentStepIfIdle(deps.db, now, id, {
          bus: deps.bus,
          idFactory: deps.idFactory,
        });
      } catch (launchError) {
        console.error("[orchestrator] next-decision launch follow-through failed", id, launchError);
      }

      return response;
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
