import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { ListActivitiesResponse } from "@orca/contracts";
import { z } from "zod";

import { listActivitiesByGoal } from "./projection.js";

export interface ActivityRouteDeps {
  db: Database.Database;
}

const GoalActivitiesParams = z.object({ goalId: z.string() }).strict();

export function registerActivityRoutes(
  server: FastifyInstance,
  deps: ActivityRouteDeps
): void {
  server.get("/v1/goals/:goalId/activities", async (request, reply) => {
    const parsed = GoalActivitiesParams.safeParse(request.params);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "validation_failed", issues: parsed.error.issues } };
    }

    const items = listActivitiesByGoal(deps.db, parsed.data.goalId);
    return ListActivitiesResponse.parse({ items });
  });
}
