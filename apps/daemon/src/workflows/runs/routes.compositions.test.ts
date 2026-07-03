import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { ListWorkflowRunCompositionsResponse } from "@orca/contracts";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";
import { insertComposition } from "../composition/store.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const NOW = "2026-06-14T00:00:00.000Z";

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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?, 'Goal', '', 'active', 1, ?, ?)"
  ).run(id, NOW, NOW);
}

function seedTemplate(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('tmpl', 'T', '', 1, 0, 0, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("GET /v1/goals/:goalId/workflow-run-compositions", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-compositions-routes-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 200 with compositions for a goal", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    // Use delegating status to avoid UNIQUE constraint on goal_id for active runs
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tmpl', 1, 'delegating', ?)"
    ).run("run-1", "goal-1", NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tmpl', 1, 'delegating', ?)"
    ).run("run-2", "goal-1", NOW);

    // Insert 2 compositions for goal-1
    insertComposition(
      db,
      {
        id: "comp-1",
        goalId: "goal-1",
        parentRunId: "run-1",
        childRunId: "run-2",
        delegateNodeId: "node-1",
        spawnSeq: 0,
        reads: { a: "b" },
        writes: { c: "d" },
        depth: 1,
        status: "active",
        costRollupUsd: null,
        createdAt: NOW,
        finishedAt: null,
      }
    );
    insertComposition(
      db,
      {
        id: "comp-2",
        goalId: "goal-1",
        parentRunId: "run-2",
        childRunId: "run-1",
        delegateNodeId: "node-2",
        spawnSeq: 1,
        reads: { e: "f" },
        writes: { g: "h" },
        depth: 2,
        status: "completed",
        costRollupUsd: 0.5,
        createdAt: NOW,
        finishedAt: "2026-06-14T01:00:00.000Z",
      }
    );

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-run-compositions",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as { compositions: Array<{ id: string }> };
    expect(body.compositions).toHaveLength(2);
    expect(body.compositions[0].id).toBe("comp-1");
    expect(body.compositions[1].id).toBe("comp-2");
  });

  it("returns 404 when goal does not exist", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/unknown-goal/workflow-run-compositions",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);

    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("goal_not_found");
  });

  it("returns 401 without auth header", async () => {
    seedGoal(db, "goal-1");

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-run-compositions",
    });
    expect(response.statusCode).toBe(401);
  });

  it("response body satisfies ListWorkflowRunCompositionsResponse contract", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    // Use delegating status to avoid UNIQUE constraint on goal_id for active runs
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tmpl', 1, 'delegating', ?)"
    ).run("run-1", "goal-1", NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tmpl', 1, 'delegating', ?)"
    ).run("run-2", "goal-1", NOW);

    insertComposition(
      db,
      {
        id: "comp-1",
        goalId: "goal-1",
        parentRunId: "run-1",
        childRunId: "run-2",
        delegateNodeId: "node-1",
        spawnSeq: 0,
        reads: { a: "b" },
        writes: { c: "d" },
        depth: 1,
        status: "active",
        costRollupUsd: null,
        createdAt: NOW,
        finishedAt: null,
      }
    );

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-run-compositions",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);

    const parsed = ListWorkflowRunCompositionsResponse.safeParse(JSON.parse(response.body));
    expect(parsed.success).toBe(true);
  });
});
