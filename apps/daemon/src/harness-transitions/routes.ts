import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { listTransitionsByGoal } from "./usecases.js";

export interface HarnessTransitionRouteDeps {
  db: Database.Database;
}

interface GoalRow {
  id: string;
}

export function registerHarnessTransitionRoutes(
  server: FastifyInstance,
  deps: HarnessTransitionRouteDeps
): void {
  const { db } = deps;
  const stmtGetGoal = db.prepare<[string], GoalRow>("SELECT id FROM goals WHERE id = ?");

  server.get("/v1/goals/:goalId/harness-transitions", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
    }
    const items = listTransitionsByGoal(db, goalId);
    return { items };
  });
}
