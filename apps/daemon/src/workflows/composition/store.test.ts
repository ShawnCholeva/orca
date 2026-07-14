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
  updateCompositionStatus, descendantRunIds, listCompositionsForGoal,
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
  db.prepare(`INSERT INTO goals (id, title, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
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
  describe("listCompositionsForGoal", () => {
    it("returns compositions for a goal in created_at ASC order", () => {
      // Seed goal g2 for cross-goal test
      db.prepare(`INSERT INTO goals (id, title, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run("g2", "Goal2", "desc", "active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
      // Seed runs for goal g2 to avoid FK constraint
      db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?,?,?,?,?,?)`)
        .run("r4", "g2", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z");
      db.prepare(`INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?,?,?,?,?,?)`)
        .run("r5", "g2", "tpl", 1, "delegating", "2026-07-01T00:00:00.000Z");
      // Insert 2 compositions for goal "g"
      insertComposition(db, comp({ id: "c1", goalId: "g", createdAt: "2026-07-01T10:00:00.000Z" }));
      insertComposition(db, comp({ id: "c2", goalId: "g", parentRunId: "r3", childRunId: "r4", createdAt: "2026-07-01T09:00:00.000Z" }));
      // Insert 1 composition for goal "g2" (proves goal-scoping)
      insertComposition(db, comp({ id: "c3", goalId: "g2", parentRunId: "r4", childRunId: "r5" }));

      const result = listCompositionsForGoal(db, "g");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("c2");
      expect(result[1].id).toBe("c1");
      expect(result[0].createdAt).toBe("2026-07-01T09:00:00.000Z");
      expect(result[1].createdAt).toBe("2026-07-01T10:00:00.000Z");
    });
    it("returns empty array for goal with no compositions", () => {
      // Seed another goal with no compositions
      db.prepare(`INSERT INTO goals (id, title, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run("g_empty", "GoalEmpty", "desc", "active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

      const result = listCompositionsForGoal(db, "g_empty");
      expect(result).toHaveLength(0);
    });
  });
});
