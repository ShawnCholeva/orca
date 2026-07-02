import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { WorkflowRunComposition } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import {
  insertComposition, getCompositionByChildRun, listChildCompositions, nextSpawnSeq,
  updateCompositionStatus, descendantRunIds,
} from "./store.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-composition-store-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function comp(over: Partial<WorkflowRunComposition> = {}): WorkflowRunComposition {
  return { id: "c1", goalId: "g", parentRunId: "r1", childRunId: "r2", delegateNodeId: "d1",
    spawnSeq: 0, reads: { a: "b" }, writes: { c: "d" }, depth: 1, status: "active",
    costRollupUsd: null, createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null, ...over };
}

let db: Database.Database;

function seed() {
  // workflow_templates row required by workflow_runs FK
  db.prepare(`INSERT INTO workflow_templates (id, name, steps_json, guardrails_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run("tpl", "Test Template", "[]", "[]", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  // goal
  db.prepare(`INSERT INTO goals (id, title, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run("g", "Goal", "desc", "active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  // workflow_runs: r1+r2 use 'delegating' (outside the unique-active-per-goal index), r3 is 'active'
  db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?,?,?,?,?,?)`)
    .run("r1", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z");
  db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?,?,?,?,?,?)`)
    .run("r2", "g", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z");
  db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?,?,?,?,?,?)`)
    .run("r3", "g", "tpl", 1, "active", "2026-07-01T00:00:00.000Z");
}

beforeEach(() => { db = openTestDb(); seed(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("composition store", () => {
  it("inserts + reads by child, lists by parent, computes next spawn seq", () => {
    insertComposition(db, comp());
    expect(getCompositionByChildRun(db, "r2")?.id).toBe("c1");
    expect(listChildCompositions(db, "r1")).toHaveLength(1);
    expect(nextSpawnSeq(db, "r1", "d1")).toBe(1);
  });
  it("updates status + cost and computes descendant run ids", () => {
    insertComposition(db, comp());                                  // r1 -> r2
    insertComposition(db, comp({ id: "c2", parentRunId: "r2", childRunId: "r3", depth: 2 }));  // r2 -> r3
    updateCompositionStatus(db, "c1", { status: "completed", costRollupUsd: 0.5, finishedAt: "2026-07-01T01:00:00.000Z" });
    expect(getCompositionByChildRun(db, "r2")?.status).toBe("completed");
    expect(new Set(descendantRunIds(db, "r1"))).toEqual(new Set(["r1", "r2", "r3"]));
  });
});
