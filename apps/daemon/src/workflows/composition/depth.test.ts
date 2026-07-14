import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { MAX_DELEGATION_DEPTH, delegationTargets, delegationDepth } from "./depth.js";
import { insertComposition } from "./store.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-depth-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;

function seed() {
  // workflow_templates row required by workflow_runs FK
  db.prepare(`INSERT INTO workflow_templates (id, name, steps_json, guardrails_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run("tpl", "Test Template", "[]", "[]", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  // goal
  db.prepare(`INSERT INTO goals (id, title, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run("g", "Goal", "desc", "active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

beforeEach(() => { db = openTestDb(); seed(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("depth/targets", () => {
  it("MAX_DELEGATION_DEPTH is 5", () => { expect(MAX_DELEGATION_DEPTH).toBe(5); });
  it("delegationTargets extracts child template refs from delegate nodes", () => {
    const tpl = { graph: { nodes: [
      { id: "s1", type: "step" }, { id: "d1", type: "delegate", childTemplateId: "child", childTemplateVersion: 2 },
    ] } } as never;
    expect(delegationTargets(tpl)).toEqual([{ childTemplateId: "child", version: 2 }]);
  });
});

describe("delegationDepth", () => {
  it("returns 0 for a root run with no parent_composition_id", () => {
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r0", "g", "tpl", 1, "active", "2026-07-01T00:00:00.000Z", null);
    expect(delegationDepth(db, "r0")).toBe(0);
  });

  it("returns 1 for a direct child in a delegation chain", () => {
    // r0 (root)
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r0", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z", null);
    // r1 (child, parent_composition_id = 'c1')
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r1", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z", "c1");
    // composition c1 linking r0 -> r1
    insertComposition(db, {
      id: "c1", goalId: "g", parentRunId: "r0", childRunId: "r1",
      delegateNodeId: "d1", spawnSeq: 0, reads: {}, writes: {}, depth: 1,
      status: "active", costRollupUsd: null, createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null,
    });
    expect(delegationDepth(db, "r1")).toBe(1);
  });

  it("returns correct depth for a nested delegation chain (r0 -> c1 -> r1 -> c2 -> r2)", () => {
    // r0 (root)
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r0", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z", null);
    // r1 (parent_composition_id = 'c1')
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r1", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z", "c1");
    // r2 (parent_composition_id = 'c2')
    db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, parent_composition_id)
      VALUES (?,?,?,?,?,?,?)`)
      .run("r2", "g", "tpl", 1, "active", "2026-07-01T00:00:00.000Z", "c2");
    // composition c1: r0 -> r1
    insertComposition(db, {
      id: "c1", goalId: "g", parentRunId: "r0", childRunId: "r1",
      delegateNodeId: "d1", spawnSeq: 0, reads: {}, writes: {}, depth: 1,
      status: "active", costRollupUsd: null, createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null,
    });
    // composition c2: r1 -> r2
    insertComposition(db, {
      id: "c2", goalId: "g", parentRunId: "r1", childRunId: "r2",
      delegateNodeId: "d1", spawnSeq: 0, reads: {}, writes: {}, depth: 2,
      status: "active", costRollupUsd: null, createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null,
    });
    expect(delegationDepth(db, "r1")).toBe(1);
    expect(delegationDepth(db, "r2")).toBe(2);
  });
});
