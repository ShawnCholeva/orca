import Database from "better-sqlite3";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerActivityRoutes } from "./routes.js";

function appWithGoalAndActivity() {
  const db = new Database(":memory:");
  runMigrations(db, defaultMigrationsDir());
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES ('g1', 't', '', 'active', 1, '2026-06-05', '2026-06-05', null)`
  ).run();
  db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, turn_ordinal,
       status, current_text, source_kind, created_at, updated_at)
     VALUES ('a1', 'g1', 'r1', 's1', 0, 'active', 'Watching...', 'step_started', '2026-06-05', '2026-06-05')`
  ).run();

  const app = Fastify();
  registerActivityRoutes(app, { db });
  return app;
}

describe("GET /v1/goals/:goalId/activities", () => {
  it("returns the goal's activities", async () => {
    const app = appWithGoalAndActivity();
    const res = await app.inject({ method: "GET", url: "/v1/goals/g1/activities" });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].currentText).toBe("Watching...");
  });

  it("returns an empty list for an unknown goal", async () => {
    const app = appWithGoalAndActivity();
    const res = await app.inject({ method: "GET", url: "/v1/goals/none/activities" });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
