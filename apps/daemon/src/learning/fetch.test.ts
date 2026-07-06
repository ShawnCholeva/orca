import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listRevisionSignalsByTemplate } from "./fetch.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-fetch-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'2026-05-01T00:00:00.000Z','2026-05-01T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr1','g','run1','s1',0,1,'passed','[]','[]',NULL,'2026-05-01T00:00:00.000Z','2026-05-01T00:10:00.000Z','fp1')`).run();
  const scoring = JSON.stringify({ successScore: 0.5, quality: { outputCompleteness: 0.5, outputCorrectness: 0.5, instructionAdherence: 0.5, downstreamReadiness: 0.5, riskLevel: 0.2 }, reason: "x", handoffReady: false });
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs1','sr1','g',0,?,'follow the output schema','2026-05-01T00:05:00.000Z')`).run(scoring);
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs2','sr1','g',1,?,NULL,'2026-05-01T00:06:00.000Z')`).run(scoring);
  const reasonScoring = JSON.stringify({ successScore: 0.9, reason: "output missed the acceptance list" });
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs3','sr1','g',2,?,'still off','2026-05-01T00:07:00.000Z')`).run(reasonScoring);
  db.prepare(`INSERT INTO step_revision_signals (id,step_run_id,goal_id,revision_index,superseded_scoring_json,feedback_text,created_at)
              VALUES ('rs4','sr1','g',3,'not json','again','2026-05-01T00:08:00.000Z')`).run();
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("listRevisionSignalsByTemplate", () => {
  it("joins signals to step_template_id within the window", () => {
    const rows = listRevisionSignalsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    expect(rows).toHaveLength(4);
    expect(rows[0].stepTemplateId).toBe("s1");
    expect(rows.map((r) => r.feedbackText)).toContain("follow the output schema");
  });
  it("excludes signals outside the window", () => {
    const rows = listRevisionSignalsByTemplate(db, "tpl", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    expect(rows).toHaveLength(0);
  });
  it("parses supersededReason from superseded_scoring_json, and is null on malformed JSON", () => {
    const rows = listRevisionSignalsByTemplate(db, "tpl", "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    const withReason = rows.find((r) => r.id === "rs3");
    expect(withReason?.supersededReason).toBe("output missed the acceptance list");
    const malformed = rows.find((r) => r.id === "rs4");
    expect(malformed?.supersededReason).toBeNull();
  });
});
