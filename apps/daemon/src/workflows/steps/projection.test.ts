import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowStepProjectionPreparedStatements, getWorkflowStepRunById, recordOperatorSelection } from "./projection.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string) {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent" as const,
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-proj-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function insertMinimalStepRun(db: Database.Database, id: string): void {
  // Insert required workflow_template row first
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, '[]', '[]', ?, ?)"
  ).run("tpl-1", "Test Template", "", 1, NOW, NOW);
  // Insert required workflow_run row
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, started_at, finished_at) VALUES (?, ?, ?, ?, 'active', NULL, ?, NULL)"
  ).run("wr-1", "goal-1", "tpl-1", 1, NOW);
  // Insert step_run row
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, started_at, finished_at, blocked_reason, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)"
  ).run(id, "goal-1", "wr-1", "tpl-step-1", 1, 1, "pending", "[]", "[]", NOW, "fp-1");
}

afterEach(() => {
  closeDatabase();
  resetWorkflowStepProjectionPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recordOperatorSelection", () => {
  it("accepts null providerId and modelId (agent ops)", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    insertMinimalStepRun(db, "sr1");

    recordOperatorSelection(db, "sr1", {
      operatorId: "agent:codex",
      providerId: null,
      modelId: null,
      at: "2026-05-27T00:00:00.000Z",
    });

    const result = getWorkflowStepRunById(db, "sr1");
    expect(result).not.toBeNull();
    expect(result!.selectedOperatorId).toBe("agent:codex");
    expect(result!.selectedProviderId).toBeNull();
    expect(result!.selectedModelId).toBeNull();
  });
});
