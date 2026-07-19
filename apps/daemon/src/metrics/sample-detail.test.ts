import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { getSampleDetail } from "./sample-detail.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token",
  };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-metrics-sample-detail-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g1','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',11,1,0,'[]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('r1','g1','tpl',11,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('t1','g1','r1',NULL,'step_complete',NULL,
                '{"grounding":{"verdict":"failed","checks":[{"rule":"member_of","field":"chosen_approach","mode":"enforce","result":"failed","detail":"value X not allowed"},{"rule":"paths_exist","field":"known_files","mode":"enforce","result":"passed"}]}}',
                NULL,
                '{"outcome":{"status":"failed","failure_code":"evidence_veto"}}',
                '2026-05-01T00:10:00.000Z')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('t2','g1','r1',NULL,'step_complete',NULL,NULL,NULL,NULL,'2026-05-01T00:20:00.000Z')`).run();
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("getSampleDetail", () => {
  it("resolves a transition to goal/run/failure/checks, excluding passed checks", () => {
    const s = getSampleDetail(db, "t1")!;
    expect(s.goalId).toBe("g1");
    expect(s.workflowRunId).toBe("r1");
    expect(s.failureCode).toBe("evidence_veto");
    expect(s.status).toBe("failed");
    expect(s.templateVersion).toBe(11);
    expect(s.checks).toEqual([
      { label: "member_of on chosen_approach", detail: "value X not allowed", result: "failed" },
    ]);
  });

  it("returns null for an unknown transition id", () => {
    expect(getSampleDetail(db, "nope")).toBeNull();
  });

  it("returns checks: [] with no throw when evidence_json is null", () => {
    const s = getSampleDetail(db, "t2")!;
    expect(s.checks).toEqual([]);
  });
});
