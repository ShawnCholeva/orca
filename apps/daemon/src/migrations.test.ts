import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";

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

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-migration-test-"));
  tempDirs.push(dir);
  return openDatabase(createConfig(dir));
}

function createMigrationsDir(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-migrations-dir-"));
  tempDirs.push(dir);

  const sourceDir = defaultMigrationsDir();
  for (const file of files) {
    copyFileSync(path.join(sourceDir, file), path.join(dir, file));
  }

  return dir;
}

describe("runMigrations", () => {
  it("applies all migrations on a fresh database in order", () => {
    const db = freshDb();
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([
      "0001_init.sql",
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "m7-001-suggested-orchestration.sql"
    ]);
  });

  it("is idempotent — re-running on an already-migrated database applies nothing", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([]);
  });

  it("creates expected tables including refinements and workspaces", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("events");
    expect(tables).toContain("goals");
    expect(tables).toContain("goal_refinements");
    expect(tables).toContain("workspaces");
    expect(tables).toContain("_migrations");
  });

  it("creates the expected named indices", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indices).toContain("idx_events_goal_seq");
    expect(indices).toContain("idx_events_type_seq");
    expect(indices).toContain("idx_goals_updated_at");
    expect(indices).toContain("idx_goals_status");
    expect(indices).toContain("idx_workspaces_goal_path");
    expect(indices).toContain("idx_workspaces_goal_attached");
  });

  it("upgrades an M1-only database to 0002 without losing rows", () => {
    const db = freshDb();
    const m1OnlyMigrations = createMigrationsDir(["0001_init.sql"]);

    runMigrations(db, m1OnlyMigrations);

    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "goal-1",
      "Legacy Goal",
      "created before 0002",
      "active",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      null
    );

    const upgradeResult = runMigrations(db, defaultMigrationsDir());

    expect(upgradeResult.applied).toEqual([
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "m7-001-suggested-orchestration.sql"
    ]);

    const goalCount = (
      db.prepare("SELECT count(*) AS cnt FROM goals WHERE id = ?").get("goal-1") as {
        cnt: number;
      }
    ).cnt;

    expect(goalCount).toBe(1);
  });

  it("creates workspaces table with the expected columns", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const columns = db.prepare("PRAGMA table_info(workspaces)").all() as {
      name: string;
    }[];

    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "goal_id",
      "path",
      "name",
      "workspace_type",
      "branch",
      "is_dirty",
      "git_probe",
      "attached_at"
    ]);
    expect(columns.some((column) => column.name === "input_path")).toBe(false);
  });

  it("enforces foreign keys for workspaces.goal_id", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    expect(() => {
      db.prepare(
        "INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "workspace-1",
        "missing-goal",
        "/tmp/example",
        "example",
        "folder",
        null,
        null,
        "not_a_repo",
        "2026-01-01T00:00:00.000Z"
      );
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("M4-003 session tables migration", () => {
  function seedGoal(db: ReturnType<typeof freshDb>, id: string) {
    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "Test Goal", "", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
  }

  function seedWorkspace(db: ReturnType<typeof freshDb>, id: string, goalId: string) {
    db.prepare(
      "INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, goalId, "/tmp/ws", "ws", "folder", null, null, "not_a_repo", "2026-01-01T00:00:00.000Z");
  }

  function seedSession(db: ReturnType<typeof freshDb>, id: string, goalId: string, workspaceId: string) {
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, goalId, workspaceId, "shell-manual", "Test Session", "created", "2026-01-01T00:00:00.000Z");
  }

  function seedOutputChunk(db: ReturnType<typeof freshDb>, sessionId: string, seq: number) {
    db.prepare(
      "INSERT INTO session_output_chunks (session_id, seq, byte_offset, byte_length, written_at, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(sessionId, seq, 0, 5, "2026-01-01T00:00:00.000Z", Buffer.from("hello"));
  }

  it("creates sessions and session_output_chunks tables on a fresh DB", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("session_output_chunks");
  });

  it("creates all three new indexes", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indices).toContain("idx_sessions_goal_created");
    expect(indices).toContain("idx_sessions_goal_status");
    expect(indices).toContain("idx_session_output_session_seq");
  });

  it("upgrades a DB with only 0001 and 0002 to the latest migration without error", () => {
    const db = freshDb();
    const m3Dir = createMigrationsDir(["0001_init.sql", "0002_workspaces_refinements.sql"]);

    const initialResult = runMigrations(db, m3Dir);
    expect(initialResult.applied).toEqual(["0001_init.sql", "0002_workspaces_refinements.sql"]);

    const upgradeResult = runMigrations(db, defaultMigrationsDir());
    expect(upgradeResult.applied).toEqual([
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "m7-001-suggested-orchestration.sql"
    ]);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("sessions");
    expect(tables).toContain("session_output_chunks");
  });

  it("is idempotent — applying 0004 twice applies nothing the second time", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([]);
  });

  it("cascades delete from goals to sessions", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, "goal-del");
    seedWorkspace(db, "ws-del", "goal-del");
    seedSession(db, "sess-del", "goal-del", "ws-del");

    db.prepare("DELETE FROM goals WHERE id = ?").run("goal-del");

    const count = (
      db.prepare("SELECT count(*) AS cnt FROM sessions WHERE id = ?").get("sess-del") as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it("restricts delete of a workspace that still has sessions", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, "goal-restrict");
    seedWorkspace(db, "ws-restrict", "goal-restrict");
    seedSession(db, "sess-restrict", "goal-restrict", "ws-restrict");

    expect(() => {
      db.prepare("DELETE FROM workspaces WHERE id = ?").run("ws-restrict");
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("cascades delete from sessions to session_output_chunks", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, "goal-chunk");
    seedWorkspace(db, "ws-chunk", "goal-chunk");
    seedSession(db, "sess-chunk", "goal-chunk", "ws-chunk");
    seedOutputChunk(db, "sess-chunk", 0);

    db.prepare("DELETE FROM sessions WHERE id = ?").run("sess-chunk");

    const count = (
      db
        .prepare("SELECT count(*) AS cnt FROM session_output_chunks WHERE session_id = ?")
        .get("sess-chunk") as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });
});

describe("M5-002 memory tables migration", () => {
  function seedGoal(db: ReturnType<typeof freshDb>, id: string) {
    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "Memory Goal", "", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
  }

  function seedWorkspace(db: ReturnType<typeof freshDb>, id: string, goalId: string) {
    db.prepare(
      "INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, goalId, "/tmp/ws-memory", "ws-memory", "folder", null, null, "not_a_repo", "2026-01-01T00:00:00.000Z");
  }

  function seedSession(db: ReturnType<typeof freshDb>, id: string, goalId: string, workspaceId: string) {
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, goalId, workspaceId, "shell-manual", "Memory Session", "exited", "2026-01-01T00:00:00.000Z");
  }

  function insertExtraction(
    db: ReturnType<typeof freshDb>,
    id: string,
    goalId: string,
    sessionId: string,
    status: "pending" | "running" | "succeeded" | "failed"
  ) {
    db.prepare(
      `INSERT INTO memory_extractions (
        id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
        source_offset_first, source_offset_last, summary_id, item_count, decision_count, promoted_count,
        failure_code, failure_message, requested_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      goalId,
      sessionId,
      "manual",
      status,
      "deterministic-v1",
      "fp-same",
      0,
      128,
      null,
      0,
      0,
      0,
      status === "failed" ? "internal_error" : null,
      status === "failed" ? "failed as expected" : null,
      "2026-01-01T00:00:00.000Z",
      null,
      null
    );
  }

  it("creates all four M5 tables and required indexes", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(tables).toContain("goal_memory_items");
    expect(tables).toContain("goal_decisions");
    expect(tables).toContain("session_summaries");
    expect(tables).toContain("memory_extractions");

    const memoryIndexes = (
      db.prepare("PRAGMA index_list('goal_memory_items')").all() as { name: string }[]
    ).map((row) => row.name);
    const decisionIndexes = (
      db.prepare("PRAGMA index_list('goal_decisions')").all() as { name: string }[]
    ).map((row) => row.name);
    const summaryIndexes = (
      db.prepare("PRAGMA index_list('session_summaries')").all() as { name: string }[]
    ).map((row) => row.name);
    const extractionIndexes = (
      db.prepare("PRAGMA index_list('memory_extractions')").all() as { name: string }[]
    ).map((row) => row.name);

    expect(memoryIndexes).toContain("idx_memory_goal_status_created");
    expect(memoryIndexes).toContain("idx_memory_goal_type");
    expect(memoryIndexes).toContain("idx_memory_dedupe");
    expect(decisionIndexes).toContain("idx_decision_goal_status_created");
    expect(summaryIndexes).toContain("idx_summary_session_created");
    expect(summaryIndexes).toContain("idx_summary_goal_created");
    expect(extractionIndexes).toContain("idx_extraction_session_requested");
    expect(extractionIndexes).toContain("idx_extraction_goal_status");
    expect(extractionIndexes).toContain("idx_extraction_runner_pickup");
    expect(extractionIndexes).toContain("idx_extraction_active_fingerprint");
  });

  it("enforces foreign keys on M5 tables", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    expect(() => {
      db.prepare(
        `INSERT INTO goal_memory_items (
          id, goal_id, type, status, content, content_hash, confidence, source_type, source_id, source_session_id,
          source_extraction_id, source_offset_first, source_offset_last, created_at, updated_at, promoted_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "mem-missing-goal",
        "missing-goal",
        "note",
        "candidate",
        "content",
        "hash-1",
        null,
        "manual",
        null,
        null,
        null,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
        null
      );
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces partial unique active extraction fingerprint index", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, "goal-fp");
    seedWorkspace(db, "ws-fp", "goal-fp");
    seedSession(db, "sess-fp", "goal-fp", "ws-fp");

    insertExtraction(db, "extract-pending-1", "goal-fp", "sess-fp", "pending");
    insertExtraction(db, "extract-failed-1", "goal-fp", "sess-fp", "failed");

    expect(() => {
      insertExtraction(db, "extract-pending-2", "goal-fp", "sess-fp", "pending");
    }).toThrow(/UNIQUE constraint failed/);
  });

  it("enforces partial unique memory dedupe index and allows reinsertion after archive", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, "goal-memory-dedupe");

    db.prepare(
      `INSERT INTO goal_memory_items (
        id, goal_id, type, status, content, content_hash, confidence, source_type, source_id, source_session_id,
        source_extraction_id, source_offset_first, source_offset_last, created_at, updated_at, promoted_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem-live-1",
      "goal-memory-dedupe",
      "note",
      "candidate",
      "same content",
      "same-hash",
      null,
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      null,
      null
    );

    expect(() => {
      db.prepare(
        `INSERT INTO goal_memory_items (
          id, goal_id, type, status, content, content_hash, confidence, source_type, source_id, source_session_id,
          source_extraction_id, source_offset_first, source_offset_last, created_at, updated_at, promoted_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "mem-live-2",
        "goal-memory-dedupe",
        "note",
        "candidate",
        "same content",
        "same-hash",
        null,
        "manual",
        null,
        null,
        null,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null,
        null
      );
    }).toThrow(/UNIQUE constraint failed/);

    db.prepare("UPDATE goal_memory_items SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(
      "archived",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "mem-live-1"
    );

    db.prepare(
      `INSERT INTO goal_memory_items (
        id, goal_id, type, status, content, content_hash, confidence, source_type, source_id, source_session_id,
        source_extraction_id, source_offset_first, source_offset_last, created_at, updated_at, promoted_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem-live-3",
      "goal-memory-dedupe",
      "note",
      "candidate",
      "same content",
      "same-hash",
      null,
      "manual",
      null,
      null,
      null,
      null,
      null,
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      null,
      null
    );
  });
});
