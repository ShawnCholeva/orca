import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { computeHarnessMetrics } from "./usecases.js";

export interface HarnessMetricsRouteDeps {
  db: Database.Database;
}

interface GoalRow {
  id: string;
}

export function registerHarnessMetricsRoutes(
  server: FastifyInstance,
  deps: HarnessMetricsRouteDeps
): void {
  const { db } = deps;
  const stmtGetGoal = db.prepare<[string], GoalRow>("SELECT id FROM goals WHERE id = ?");

  server.get("/v1/goals/:goalId/harness-metrics", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
    }
    return { metrics: computeHarnessMetrics(db, goalId) };
  });
}
