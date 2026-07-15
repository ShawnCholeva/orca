import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { collectPriorStepArtifacts } from "./repair-context.js";

const NOW = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-repair-ctx-"));
  dirs.push(dir);
  const cfg = { dataDir: dir, port: 0, logLevel: "silent", sessionOutputTailBytes: 1, sessionStopGraceMs: 1, sessionWsBufferLimitBytes: 1, memoryExtractionMaxInputBytes: 1, memoryExtractionTimeoutMs: 1, hookResolverCommand: ["node"], getAuthToken: () => "t" } as unknown as Config;
  const db = openDatabase(cfg);
  runMigrations(db, defaultMigrationsDir());
  db.prepare("INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1','G','i','active',1,?,?,NULL)").run(NOW, NOW);
  db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/t','T','',1,1,1,'[]','[]',?,?)").run(NOW, NOW);
  db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1','goal-1','orca/t',1,'active','sr-prop-2',NULL,?,NULL)").run(NOW);
  return db;
}

function stepRun(db: Database.Database, id: string, tpl: string, ordinal: number, attempt: number, status: string): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,?,?,?)"
  ).run(id, "goal-1", "run-1", tpl, ordinal, attempt, status, NOW, status === "passed" ? NOW : null, "fp-" + id);
}

let artSeq = 0;
function output(db: Database.Database, stepRunId: string, body: object): void {
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES (?,?,?,?, 'step_output', ?, ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run("art-" + (++artSeq), "goal-1", "run-1", stepRunId, stepRunId, JSON.stringify(body), NOW);
}

afterEach(() => {
  closeDatabase();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("collectPriorStepArtifacts", () => {
  it("excludes the current step's OWN prior (rejected) attempt on a gate-reject loop re-run", () => {
    const db = setup();
    // triage ran once (earlier, different step).
    stepRun(db, "sr-triage", "triage", 0, 1, "passed");
    output(db, "sr-triage", { readiness: "ready" });
    // proposal attempt 1 was rejected by the Critique gate — its stale output must
    // NOT return as authoritative prior context for the re-run.
    stepRun(db, "sr-prop-1", "proposal", 3, 1, "passed");
    output(db, "sr-prop-1", { chosen_approach: "Throw RangeError", note: "user confirmed Approach A" });
    // proposal attempt 2 is the current (looped) re-run.
    stepRun(db, "sr-prop-2", "proposal", 3, 2, "active");

    const prior = collectPriorStepArtifacts(db, "run-1", "sr-prop-2");
    const stepIds = prior.map((p) => p.stepId);
    // Upstream context is still available…
    expect(stepIds).toContain("triage");
    // …but the step's OWN prior rejected attempt is gone (was the confusion source).
    expect(stepIds).not.toContain("proposal");
  });

  it("still returns a step's single (forward, non-looped) output unchanged", () => {
    const db = setup();
    stepRun(db, "sr-triage", "triage", 0, 1, "passed");
    output(db, "sr-triage", { readiness: "ready" });
    stepRun(db, "sr-prop-2", "proposal", 3, 1, "active"); // current step, no prior attempt

    const prior = collectPriorStepArtifacts(db, "run-1", "sr-prop-2");
    expect(prior.map((p) => p.stepId)).toEqual(["triage"]);
  });
});
