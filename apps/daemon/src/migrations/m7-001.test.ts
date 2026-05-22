import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";

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
    getAuthToken: () => "test-token"
  };
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tableColumns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function sqliteObjects(
  db: ReturnType<typeof openDatabase>,
  type: "table" | "index"
): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = ?")
      .all(type) as { name: string }[]
  ).map((row) => row.name);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("M7-001 migration schema", () => {
  it("creates all M7 tables, columns, and indexes on a fresh DB", () => {
    const dataDir = createTempDir("orca-m7-migration-fresh-");
    const db = openDatabase(createConfig(dataDir));

    runMigrations(db, defaultMigrationsDir());

    const tables = sqliteObjects(db, "table");
    expect(tables).toContain("tasks");
    expect(tables).toContain("task_generations");
    expect(tables).toContain("recommendations");
    expect(tables).toContain("recommendation_generations");
    expect(tables).toContain("recommendation_feedback");
    expect(tables).toContain("conflicts");

    const indexes = sqliteObjects(db, "index");
    const requiredIndexes = [
      "idx_tasks_goal_status_created",
      "idx_tasks_workspace_status",
      "idx_tasks_parent",
      "idx_tasks_goal_fingerprint_active",
      "idx_task_generations_active_fp",
      "idx_task_generations_goal_requested",
      "idx_task_generations_status",
      "idx_recs_goal_status_created",
      "idx_recs_goal_type",
      "idx_recs_task",
      "idx_recs_session",
      "idx_recs_conflict",
      "idx_recs_goal_fingerprint_active",
      "idx_rec_generations_active_fp",
      "idx_rec_generations_goal_requested",
      "idx_rec_generations_status",
      "idx_feedback_goal_created",
      "idx_feedback_recommendation",
      "idx_feedback_terminal_action",
      "idx_conflicts_goal_status",
      "idx_conflicts_goal_fp_open",
      "idx_sessions_task",
      "idx_context_packages_task"
    ];

    for (const indexName of requiredIndexes) {
      expect(indexes).toContain(indexName);
    }

    expect(tableColumns(db, "sessions")).toContain("task_id");
    expect(tableColumns(db, "sessions")).toContain("from_recommendation_id");
    expect(tableColumns(db, "context_packages")).toContain("task_id");
    expect(tableColumns(db, "context_packages")).toContain("from_recommendation_id");
  });

  it("upgrades a recorded M6 fixture DB without mutating pre-existing row counts", () => {
    const fixturePath = fileURLToPath(
      new URL("../../test-fixtures/m6-baseline.sqlite", import.meta.url)
    );

    expect(existsSync(fixturePath)).toBe(true);

    const dataDir = createTempDir("orca-m7-migration-upgrade-");
    copyFileSync(fixturePath, path.join(dataDir, "orca.db"));

    const db = openDatabase(createConfig(dataDir));

    const preCounts = {
      goals: (db.prepare("SELECT count(*) AS cnt FROM goals").get() as { cnt: number }).cnt,
      workspaces: (db.prepare("SELECT count(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt,
      sessions: (db.prepare("SELECT count(*) AS cnt FROM sessions").get() as { cnt: number }).cnt,
      contextPackages: (
        db.prepare("SELECT count(*) AS cnt FROM context_packages").get() as { cnt: number }
      ).cnt,
      contextAssemblies: (
        db.prepare("SELECT count(*) AS cnt FROM context_assemblies").get() as { cnt: number }
      ).cnt
    };

    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual(["0007_agents.sql", "m7-001-suggested-orchestration.sql"]);

    const postCounts = {
      goals: (db.prepare("SELECT count(*) AS cnt FROM goals").get() as { cnt: number }).cnt,
      workspaces: (db.prepare("SELECT count(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt,
      sessions: (db.prepare("SELECT count(*) AS cnt FROM sessions").get() as { cnt: number }).cnt,
      contextPackages: (
        db.prepare("SELECT count(*) AS cnt FROM context_packages").get() as { cnt: number }
      ).cnt,
      contextAssemblies: (
        db.prepare("SELECT count(*) AS cnt FROM context_assemblies").get() as { cnt: number }
      ).cnt
    };

    expect(postCounts).toEqual(preCounts);

    const sessionsWithAssociations = (
      db
        .prepare(
          "SELECT count(*) AS cnt FROM sessions WHERE task_id IS NOT NULL OR from_recommendation_id IS NOT NULL"
        )
        .get() as { cnt: number }
    ).cnt;
    expect(sessionsWithAssociations).toBe(0);

    const contextPackagesWithAssociations = (
      db
        .prepare(
          "SELECT count(*) AS cnt FROM context_packages WHERE task_id IS NOT NULL OR from_recommendation_id IS NOT NULL"
        )
        .get() as { cnt: number }
    ).cnt;
    expect(contextPackagesWithAssociations).toBe(0);
  });
});
