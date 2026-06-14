import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";
import { commitLedgerVersion } from "../ledger/usecases.js";

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

function seedRun(db: Database.Database, goalId: string, runId: string): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tmpl', 1, 'active', ?)"
  ).run(runId, goalId, NOW);
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("GET /v1/goals/:goalId/workflow-runs/:id/ledger", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-ledger-routes-"));
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

  it("returns committed records (latest state) and version history after two commits", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    seedRun(db, "goal-1", "run-1");

    // Commit version 1: create a requirement
    const c1 = commitLedgerVersion(db, () => "2026-06-14T00:00:01.000Z", {
      goalId: "goal-1",
      workflowRunId: "run-1",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [
        {
          operation: "create",
          record_id: "local:req1",
          record_type: "requirement",
          status: "open",
          evidence_refs: [],
          note: "initial requirement",
        },
      ],
    });
    expect(c1.version).toBe(1);

    const canonicalReq = c1.idMap["local:req1"];

    // Commit version 2: update the requirement
    const c2 = commitLedgerVersion(db, () => "2026-06-14T00:00:02.000Z", {
      goalId: "goal-1",
      workflowRunId: "run-1",
      sourceStepRunId: "sr-2",
      traversalSeq: 2,
      updates: [
        {
          operation: "update",
          record_id: canonicalReq,
          record_type: "requirement",
          status: "satisfied",
          evidence_refs: ["ev-1"],
          note: "requirement met",
        },
      ],
    });
    expect(c2.version).toBe(2);

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-1/ledger",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      committed: { version: number; records: Array<{ id: string; status: string; note: string }> };
      versions: Array<{ version: number; sourceStepRunId: string | null; traversalSeq: number; createdAt: string }>;
    };

    // committed reflects the latest state
    expect(body.committed.version).toBe(2);
    expect(body.committed.records).toHaveLength(1);
    const rec = body.committed.records[0];
    expect(rec).toBeDefined();
    expect(rec!.id).toBe(canonicalReq);
    expect(rec!.status).toBe("satisfied");
    expect(rec!.note).toBe("requirement met");

    // version history has 2 entries
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toMatchObject({ version: 1, sourceStepRunId: "sr-1", traversalSeq: 1, createdAt: "2026-06-14T00:00:01.000Z" });
    expect(body.versions[1]).toMatchObject({ version: 2, sourceStepRunId: "sr-2", traversalSeq: 2, createdAt: "2026-06-14T00:00:02.000Z" });
  });

  it("returns version 0 and empty records/versions for a run with no commits", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    seedRun(db, "goal-1", "run-1");

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-1/ledger",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      committed: { version: number; records: unknown[] };
      versions: unknown[];
    };
    expect(body.committed.version).toBe(0);
    expect(body.committed.records).toHaveLength(0);
    expect(body.versions).toHaveLength(0);
  });

  it("returns 404 when the run does not belong to the goal", async () => {
    seedGoal(db, "goal-1");
    seedGoal(db, "goal-2");
    seedTemplate(db);
    seedRun(db, "goal-2", "run-2");

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-2/ledger",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 401 without auth header", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    seedRun(db, "goal-1", "run-1");

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-1/ledger",
    });
    expect(response.statusCode).toBe(401);
  });
});
