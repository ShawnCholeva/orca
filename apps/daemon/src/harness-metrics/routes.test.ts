import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerHarnessMetricsRoutes } from "./routes.js";

const tempDirs: string[] = [];

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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-harness-metrics-routes-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, now, now);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/goals/:goalId/harness-metrics", () => {
  it("returns 200 with a metrics body for a seeded goal", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/g/harness-metrics" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { metrics: Record<string, unknown> };
    expect(body.metrics).toBeDefined();
    for (const key of [
      "trajectory_efficiency",
      "verification_strength",
      "recovery",
      "state_consistency",
      "safety_compliance",
      "replayability",
    ]) {
      expect(body.metrics).toHaveProperty(key);
    }
  });

  it("returns 404 for an unknown goal", async () => {
    const db = openTestDb();
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/missing/harness-metrics" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("goal_not_found");
  });
});

describe("GET /v1/goals/:goalId/harness-replay", () => {
  it("returns 200 with chronological steps for a seeded goal", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'tool_gate', ?, NULL, NULL, NULL, '2026-01-01T00:00:02.000Z')`
    ).run(
      "t-2",
      JSON.stringify({
        risk_class: "low",
        permission_tier: "read_only",
        classification_reasons: [],
        gate_decision: "deny",
        hard_constraint_violations: [],
      })
    );
    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'step_complete', NULL, ?, NULL, NULL, '2026-01-01T00:00:01.000Z')`
    ).run(
      "t-1",
      JSON.stringify({
        sensorsRun: [],
        verdict: "passed",
        untestedRegions: [],
        residualRisk: [],
        oracleAdequacy: { sufficient: true, gaps: [] },
      })
    );

    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/g/harness-replay" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      steps: Array<{ seq: number; boundary: string; summary: string }>;
    };
    expect(body.steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(body.steps.map((s) => s.boundary)).toEqual(["step_complete", "tool_gate"]);
    expect(body.steps.map((s) => s.summary)).toEqual(["passed", "deny"]);
  });

  it("returns 200 with an empty trajectory for a seeded goal with no transitions", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/g/harness-replay" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ steps: [] });
  });

  it("returns 404 for an unknown goal", async () => {
    const db = openTestDb();
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/missing/harness-replay" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("goal_not_found");
  });
});

describe("GET /v1/goals/:goalId/harness-attribution", () => {
  it("returns 200 with failure clusters for a seeded goal", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    const telemetry = JSON.stringify({
      cost: null,
      latency_ms: null,
      model: null,
      provider_id: null,
      provider_version: null,
      prompt_ref: null,
      raw_output_ref: null,
      rejected_alternatives: [],
      human_interventions: [],
      outcome: { status: "failed", failure_code: "timeout" },
    });
    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'step_launch', ?, '2026-01-01T00:00:00.000Z')`
    ).run("t-1", telemetry);

    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/g/harness-attribution" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      clusters: Array<{ failure_code: string; boundary: string; count: number }>;
    };
    expect(body.clusters).toEqual([
      {
        failure_code: "timeout",
        boundary: "step_launch",
        count: 1,
        sample_transition_ids: ["t-1"],
      },
    ]);
  });

  it("returns 200 with an empty array for a goal with no failures", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/g/harness-attribution" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clusters: [] });
  });

  it("returns 404 for an unknown goal", async () => {
    const db = openTestDb();
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({ method: "GET", url: "/v1/goals/missing/harness-attribution" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("goal_not_found");
  });
});

describe("GET /v1/goals/:goalId/harness-transitions/:transitionId/provenance", () => {
  it("returns 200 with a provenance body for a seeded transition", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, created_at)
       VALUES (?, 'g', NULL, NULL, 'tool_gate', '2026-01-01T00:00:00.000Z')`
    ).run("trans-1");
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({
      method: "GET",
      url: "/v1/goals/g/harness-transitions/trans-1/provenance",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { provenance: { transition: { id: string } } };
    expect(body.provenance.transition.id).toBe("trans-1");
  });

  it("returns 404 for an unknown transition", async () => {
    const db = openTestDb();
    seedGoal(db, "g");
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({
      method: "GET",
      url: "/v1/goals/g/harness-transitions/missing/provenance",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("transition_not_found");
  });

  it("returns 404 for an unknown goal", async () => {
    const db = openTestDb();
    const f = Fastify();
    registerHarnessMetricsRoutes(f, { db });

    const res = await f.inject({
      method: "GET",
      url: "/v1/goals/missing/harness-transitions/whatever/provenance",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("goal_not_found");
  });
});
