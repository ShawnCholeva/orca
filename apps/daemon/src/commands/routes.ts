import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { RunGoalCommandRequest, RunGoalCommandResponse } from "@orca/contracts";

import type { EventBus } from "../events.js";
import { GoalCommandGoalNotFoundError, runGoalCommand, UnknownCommandError } from "./usecases.js";

export interface GoalCommandRouteDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerGoalCommandRoutes(server: FastifyInstance, deps: GoalCommandRouteDeps): void {
  server.post("/v1/goals/:goalId/commands", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = RunGoalCommandRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    try {
      const response = await runGoalCommand(
        { db: deps.db, bus: deps.bus, now: deps.now ?? (() => new Date().toISOString()), idFactory: deps.idFactory },
        goalId,
        parsed.data
      );
      return RunGoalCommandResponse.parse(response);
    } catch (error) {
      if (error instanceof UnknownCommandError) {
        reply.status(400);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalCommandGoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
