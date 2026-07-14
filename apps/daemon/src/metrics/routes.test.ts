import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerMetricsRoutes } from "./routes.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-metrics-routes-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const recentEnd = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
  db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,0,'[{"id":"define-intent","name":"Define Intent"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,?,?)`).run(recent, recentEnd);
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','define-intent',0,1,'passed','[]','[]',NULL,?,?,'fp1')`).run(recent, recentEnd);
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('ht1','g','run1','sr1','step_complete',NULL,
                '{"sensorsRun":[],"verdict":"passed","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}',NULL,
                '{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"succeeded","failure_code":null}}',
                ?)`).run(recentEnd);
}

afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("metrics routes", () => {
  it("GET /v1/metrics/templates returns a summary array", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates?period=30d" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summaries: Array<{ templateId: string }> };
    expect(body.summaries.map((s) => s.templateId)).toContain("tpl");
  });

  it("GET /v1/metrics/templates/:id returns detail with steps", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates/tpl?period=30d" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { detail: { steps: Array<{ name: string }> } };
    expect(body.detail.steps.map((s) => s.name)).toContain("Define Intent");
  });

  it("400 on invalid period", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates?period=1y" });
    expect(res.statusCode).toBe(400);
  });

  it("400 on invalid period for detail route", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates/tpl?period=1y" });
    expect(res.statusCode).toBe(400);
  });

  it("404 on unknown template", async () => {
    const db = openTestDb(); seed(db);
    const f = Fastify(); registerMetricsRoutes(f, { db });
    const res = await f.inject({ method: "GET", url: "/v1/metrics/templates/nope?period=7d" });
    expect(res.statusCode).toBe(404);
  });
});
