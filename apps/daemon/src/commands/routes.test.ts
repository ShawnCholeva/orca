import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerGoalCommandRoutes } from "./routes.js";

const tempDirs: string[] = [];
const NOW = "2026-05-26T12:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

describe("goal command routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goal-command-routes-"));
    tempDirs.push(dir);
    db = openDatabase(createConfig(dir));
    runMigrations(db, defaultMigrationsDir());
  });

  afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST /v1/goals/:goalId/commands returns 404 for a goal that does not exist", async () => {
    const app = Fastify();
    registerGoalCommandRoutes(app, { db, bus: new EventBus(), now: () => NOW });

    const response = await app.inject({
      method: "POST",
      url: "/v1/goals/no-such-goal/commands",
      headers: { "content-type": "application/json" },
      payload: { command: "stuck" },
    });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("goal_not_found");
  });
});
