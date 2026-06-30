import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listTransitionsByTemplate, listStepRunsByTemplate, listTemplatesWithRuns } from "./fetch.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-metrics-fetch-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',2,1,0,'[]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','define-intent',0,1,'passed','[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z','fp1')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('ht1','g','run1','sr1','step_complete',NULL,
                '{"sensorsRun":[],"verdict":"passed","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}',
                NULL,
                '{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"succeeded","failure_code":null}}',
                '2026-05-01T00:10:00.000Z')`).run();
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("metrics fetch", () => {
  it("lists transitions joined to template version + step template id, within window", () => {
    const rows = listTransitionsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].templateVersion).toBe(1);
    expect(rows[0].stepTemplateId).toBe("define-intent");
    expect(rows[0].transition.evidence?.verdict).toBe("passed");
  });

  it("excludes transitions outside the window", () => {
    const rows = listTransitionsByTemplate(db, "tpl", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(0);
  });

  it("lists step runs for a template within window", () => {
    const rows = listStepRunsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].stepTemplateId).toBe("define-intent");
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].status).toBe("passed");
  });

  it("lists templates that have at least one run", () => {
    const rows = listTemplatesWithRuns(db);
    expect(rows).toEqual([{ templateId: "tpl", name: "Brainstorm", latestVersion: 2 }]);
  });
});
