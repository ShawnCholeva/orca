import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { HARNESS_FACETS } from "@orca/contracts";
import { HARNESS_BOUNDARIES } from "./emit.js";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "../harness-sensors/detect.js";
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

  server.get("/v1/harness/registry", async () => {
    return {
      facets: HARNESS_FACETS.map((f) => ({ key: f.key, column: f.column })),
      boundaries: HARNESS_BOUNDARIES.map((b) => ({ key: b.key, facets: b.facets })),
      sensors: [
        ...HARNESS_SENSORS.map((s) => ({ kind: s.kind, label: s.label, script: s.script, status: "implemented" as const })),
        ...UNIMPLEMENTED_SENSOR_KINDS.map((kind) => ({ kind, label: null, script: null, status: "unimplemented" as const })),
      ],
    };
  });
}
