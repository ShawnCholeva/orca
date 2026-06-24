import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { attributeFailures } from "./attribution.js";
import { buildProvenance } from "./provenance.js";
import { replayControlPlane } from "./replay.js";
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

  server.get("/v1/goals/:goalId/harness-attribution", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
    }
    return { clusters: attributeFailures(db, goalId) };
  });

  server.get("/v1/goals/:goalId/harness-replay", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const goalRow = stmtGetGoal.get(goalId);
    if (!goalRow) {
      reply.status(404);
      return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
    }
    return replayControlPlane(db, goalId);
  });

  server.get(
    "/v1/goals/:goalId/harness-transitions/:transitionId/provenance",
    async (request, reply) => {
      const { goalId, transitionId } = request.params as {
        goalId: string;
        transitionId: string;
      };
      const goalRow = stmtGetGoal.get(goalId);
      if (!goalRow) {
        reply.status(404);
        return { error: { code: "goal_not_found", message: `Goal not found: ${goalId}` } };
      }
      const provenance = buildProvenance(db, transitionId);
      if (!provenance) {
        reply.status(404);
        return {
          error: {
            code: "transition_not_found",
            message: `Transition not found: ${transitionId}`,
          },
        };
      }
      return { provenance };
    }
  );
}
