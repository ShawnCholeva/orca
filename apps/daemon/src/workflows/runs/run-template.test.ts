import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../../db.js";
import type { Config } from "../../config.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements, getWorkflowRunById } from "./projection.js";
import { loadRunTemplate } from "./run-template.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token",
  };
}

function seedTemplate(db: Database.Database, id: string, version: number, stepName: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)"
  ).run(
    id, "Engineering", "desc", version,
    JSON.stringify([{ id: "intake", ordinal: 0, name: stepName, instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }]),
    JSON.stringify([]), NOW, NOW
  );
}

function insertRun(db: Database.Database, id: string, templateId: string, version: number, snapshotJson: string | null): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 't', 'd', 'active', 1, ?, ?, NULL)"
  ).run(`goal-${id}`, NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, template_snapshot_json, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL)"
  ).run(id, `goal-${id}`, templateId, version, snapshotJson, NOW);
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-template-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

afterEach(() => {
  closeDatabase();
  resetRunProjectionPreparedStatements();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadRunTemplate", () => {
  it("returns the parsed snapshot when present, ignoring live template edits", () => {
    const db = setup();
    seedTemplate(db, "orca/engineering", 1, "Original");
    const snapshot = JSON.stringify({
      id: "orca/engineering", name: "Engineering", description: "desc", version: 1,
      category: "Engineering", isBuiltIn: true, isLocked: true,
      steps: [{ id: "intake", ordinal: 0, name: "Original", instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }],
      guardrails: [], createdAt: NOW, updatedAt: NOW, scope: "global", scopeName: "", graph: null,
    });
    insertRun(db, "run-1", "orca/engineering", 1, snapshot);

    db.prepare("UPDATE workflow_templates SET steps_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "intake", ordinal: 0, name: "EDITED", instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }]), "orca/engineering");

    const run = getWorkflowRunById(db, "run-1")!;
    const tpl = loadRunTemplate(db, run)!;
    expect(tpl.steps[0].name).toBe("Original");
  });

  it("accepts a minimal { id, templateId } shape", () => {
    const db = setup();
    seedTemplate(db, "orca/engineering", 1, "Snap");
    const snapshot = JSON.stringify({
      id: "orca/engineering", name: "Engineering", description: "desc", version: 1,
      category: "Engineering", isBuiltIn: true, isLocked: true,
      steps: [{ id: "intake", ordinal: 0, name: "Snap", instructions: "do", outputSchema: [{ key: "k", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }],
      guardrails: [], createdAt: NOW, updatedAt: NOW, scope: "global", scopeName: "", graph: null,
    });
    insertRun(db, "run-3", "orca/engineering", 1, snapshot);

    const tpl = loadRunTemplate(db, { id: "run-3", templateId: "orca/engineering" })!;
    expect(tpl.steps[0].name).toBe("Snap");
  });

  it("falls back to the live template when the snapshot is null", () => {
    const db = setup();
    seedTemplate(db, "orca/engineering", 1, "LiveName");
    insertRun(db, "run-2", "orca/engineering", 1, null);

    const run = getWorkflowRunById(db, "run-2")!;
    const tpl = loadRunTemplate(db, run)!;
    expect(tpl.steps[0].name).toBe("LiveName");
  });
});
