import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  ListOrchestratorMessagesResponse,
} from "@orca/contracts";

import type { EventBus } from "../events.js";
import type { ModelProviderRegistry } from "../llm/registry.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";
import {
  createOrchestratorMessage,
  GoalOrchestratorModelMissingError,
  OrchestratorChatGoalNotFoundError,
  OrchestratorChatProviderUnavailableError,
} from "./usecases.js";

export interface OrchestratorChatRouteDeps {
  db: Database.Database;
  bus: EventBus;
  modelProviderRegistry: ModelProviderRegistry;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function goalExists(db: Database.Database, goalId: string): boolean {
  const row = db
    .prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL")
    .get(goalId) as { id: string } | undefined;
  return row !== undefined;
}

export function registerOrchestratorChatRoutes(
  server: FastifyInstance,
  deps: OrchestratorChatRouteDeps
): void {
  server.get("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    if (!goalExists(deps.db, goalId)) {
      reply.status(404);
      return apiError("goal_not_found", `Goal not found: ${goalId}`);
    }

    return ListOrchestratorMessagesResponse.parse({
      messages: listOrchestratorMessagesByGoal(deps.db, goalId),
    });
  });

  server.post("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = CreateOrchestratorMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    try {
      const response = await createOrchestratorMessage(
        {
          db: deps.db,
          bus: deps.bus,
          modelProviderRegistry: deps.modelProviderRegistry,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        goalId,
        parsed.data
      );
      reply.status(201);
      return CreateOrchestratorMessageResponse.parse(response);
    } catch (error) {
      if (error instanceof OrchestratorChatGoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalOrchestratorModelMissingError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof OrchestratorChatProviderUnavailableError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
