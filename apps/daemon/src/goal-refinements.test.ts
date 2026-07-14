import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import {
  getGoalRefinement,
  insertGoalRefinement,
  resetPreparedStatements,
} from "./goal-refinements.js";

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goal-refinements-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function insertGoalRow(db: Database.Database, goalId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(goalId, "Goal", "", "active", 1, now, now, null);
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("goal-refinements projections", () => {
  it("insert/get round-trip stores and returns refinement data", () => {
    const db = setup();
    const goalId = "goal-1";
    insertGoalRow(db, goalId);

    insertGoalRefinement(db, {
      goalId,
      skillId: "guided-goal-refinement",
      successCriteria: ["A", "B"],
      constraints: ["C1"],
      assumptions: ["H1"],
      refinedAt: "2026-01-01T01:00:00.000Z",
    });

    const refinement = getGoalRefinement(db, goalId);
    expect(refinement).toEqual({
      goalId,
      skillId: "guided-goal-refinement",
      successCriteria: ["A", "B"],
      constraints: ["C1"],
      assumptions: ["H1"],
      refinedAt: "2026-01-01T01:00:00.000Z",
    });
  });

  it("second insert for the same goal_id throws a constraint error", () => {
    const db = setup();
    const goalId = "goal-2";
    insertGoalRow(db, goalId);

    insertGoalRefinement(db, {
      goalId,
      skillId: "guided-goal-refinement",
      successCriteria: ["First"],
      constraints: [],
      assumptions: [],
      refinedAt: "2026-01-01T01:00:00.000Z",
    });

    expect(() =>
      insertGoalRefinement(db, {
        goalId,
        skillId: "guided-goal-refinement",
        successCriteria: ["Second"],
        constraints: [],
        assumptions: [],
        refinedAt: "2026-01-01T02:00:00.000Z",
      }),
    ).toThrow();

    // original row preserved
    const rows = (
      db.prepare("SELECT count(*) as cnt FROM goal_refinements WHERE goal_id = ?").get(goalId) as {
        cnt: number;
      }
    ).cnt;
    expect(rows).toBe(1);
  });

  it("get missing goal refinement returns null", () => {
    const db = setup();
    expect(getGoalRefinement(db, "missing-goal")).toBeNull();
  });

  it("JSON encode/decode preserves array contents exactly", () => {
    const db = setup();
    const goalId = "goal-3";
    insertGoalRow(db, goalId);

    const successCriteria = ["alpha", "beta", "gamma"];
    const constraints = ["cpu <= 2 cores", "memory <= 4 GB"];
    const assumptions = ["api stable", "workspace exists"];

    insertGoalRefinement(db, {
      goalId,
      skillId: "guided-goal-refinement",
      successCriteria,
      constraints,
      assumptions,
      refinedAt: "2026-01-01T03:00:00.000Z",
    });

    const raw = db
      .prepare(
        "SELECT success_criteria, constraints, assumptions FROM goal_refinements WHERE goal_id = ?",
      )
      .get(goalId) as { success_criteria: string; constraints: string; assumptions: string };

    expect(JSON.parse(raw.success_criteria)).toEqual(successCriteria);
    expect(JSON.parse(raw.constraints)).toEqual(constraints);
    expect(JSON.parse(raw.assumptions)).toEqual(assumptions);

    const refinement = getGoalRefinement(db, goalId);
    expect(refinement?.successCriteria).toEqual(successCriteria);
    expect(refinement?.constraints).toEqual(constraints);
    expect(refinement?.assumptions).toEqual(assumptions);
  });
});
