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
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql",
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql"
    ]);
  });

  it("is idempotent — re-running on an already-migrated database applies nothing", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([]);
  });

  it("records suggested orchestration as applied when the schema already exists", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    db.prepare("DELETE FROM _migrations WHERE name = ?").run(
      "0008_suggested_orchestration.sql"
    );

    const result = runMigrations(db, defaultMigrationsDir());

    expect(result.applied).toEqual(["0008_suggested_orchestration.sql"]);
    const rows = db
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .all("0008_suggested_orchestration.sql") as { name: string }[];
    expect(rows).toHaveLength(1);
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

  it("upgrades a base-schema database to 0002 without losing rows", () => {
    const db = freshDb();
    const baseSchemaMigrations = createMigrationsDir(["0001_init.sql"]);

    runMigrations(db, baseSchemaMigrations);

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
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql",
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql"
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

  it("creates orchestrator_messages with the expected columns", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const columns = db.prepare("PRAGMA table_info(orchestrator_messages)").all() as {
      name: string;
    }[];

    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "goal_id",
      "role",
      "kind",
      "body",
      "correlation_id",
      "created_at",
      "raw_agent_text",
      "why_rationale",
      "internal_kind",
      "pending_question",
      "pending_approval",
    ]);
  });

  it("workflow_step_runs has operator-selection columns", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    const cols = db.prepare("PRAGMA table_info(workflow_step_runs)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("selected_operator_id");
    expect(names).toContain("selected_provider_id");
    expect(names).toContain("selected_model_id");
    expect(names).toContain("operator_selected_at");
    expect(names).toContain("step_result_json");
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

describe("session tables migration", () => {
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
    ).run(id, goalId, workspaceId, "claude-code", "Test Session", "created", "2026-01-01T00:00:00.000Z");
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
    const refinementWorkspaceDir = createMigrationsDir(["0001_init.sql", "0002_workspaces_refinements.sql"]);

    const initialResult = runMigrations(db, refinementWorkspaceDir);
    expect(initialResult.applied).toEqual(["0001_init.sql", "0002_workspaces_refinements.sql"]);

    const upgradeResult = runMigrations(db, defaultMigrationsDir());
    expect(upgradeResult.applied).toEqual([
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql",
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql"
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

describe("memory tables migration", () => {
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
    ).run(id, goalId, workspaceId, "claude-code", "Memory Session", "exited", "2026-01-01T00:00:00.000Z");
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

  it("creates all four memory tables and required indexes", () => {
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

  it("enforces foreign keys on memory tables", () => {
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

describe("migration 0009 agent readiness", () => {
  it("adds readiness columns to agents and enforces status CHECK", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-mig-9-"));
    tempDirs.push(dir);
    const db = openDatabase(createConfig(dir));
    runMigrations(db, defaultMigrationsDir());

    const cols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      "readiness_status",
      "readiness_checked_at",
      "readiness_detail",
      "readiness_repair",
      "readiness_version",
    ]) {
      expect(names).toContain(expected);
    }

    db.prepare(
      `INSERT INTO agents (id, name, short_label, description, swatch, recommended, connected, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "claude-code",
      "Claude Code",
      "CC",
      "test",
      "#000000",
      1,
      0,
      1,
      "2026-05-22T00:00:00.000Z",
      "2026-05-22T00:00:00.000Z",
    );

    // CHECK constraint rejects junk
    expect(() =>
      db
        .prepare(`UPDATE agents SET readiness_status = 'bogus' WHERE id = ?`)
        .run("claude-code"),
    ).toThrow();

    // NULL allowed
    db.prepare(`UPDATE agents SET readiness_status = NULL WHERE id = ?`).run("claude-code");

    // every legal value accepted
    for (const v of ["unchecked", "ready", "missing", "needs_auth", "misconfigured", "failed"]) {
      db.prepare(`UPDATE agents SET readiness_status = ? WHERE id = ?`).run(v, "claude-code");
    }
    closeDatabase();
  });
});

describe("migration 0010 workflows", () => {
  it("creates workflow tables and expected indices", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    for (const expected of [
      "workflow_templates",
      "workflow_runs",
      "workflow_step_runs",
      "workflow_artifacts",
      "workflow_decisions",
      "workflow_guardrail_evaluations",
      "workflow_llm_calls"
    ]) {
      expect(tables).toContain(expected);
    }

    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    for (const expected of [
      "idx_workflow_templates_built_in",
      "idx_workflow_runs_goal_status",
      "idx_workflow_runs_active_per_goal",
      "idx_workflow_step_runs_fp",
      "idx_workflow_step_runs_goal",
      "idx_workflow_step_runs_run_ordinal",
      "idx_workflow_artifacts_goal_type",
      "idx_workflow_artifacts_run_step",
      "idx_workflow_decisions_run_created",
      "idx_workflow_decisions_goal_created",
      "idx_workflow_decisions_step",
      "idx_workflow_decisions_fp_window",
      "idx_workflow_guardrail_eval_run",
      "idx_workflow_guardrail_eval_goal",
      "idx_workflow_llm_calls_provider_created",
      "idx_workflow_llm_calls_goal_created"
    ]) {
      expect(indices).toContain(expected);
    }
  });

  it("adds goal/session/context/task/recommendation workflow columns", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const goalsCols = (
      db.prepare("PRAGMA table_info(goals)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(goalsCols).toContain("orchestrator_provider");
    expect(goalsCols).toContain("orchestrator_model");
    expect(goalsCols).toContain("active_workflow_run_id");
    expect(goalsCols).toContain("worker_permission_mode");

    const sessionsCols = (
      db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(sessionsCols).toContain("workflow_step_run_id");

    const contextCols = (
      db.prepare("PRAGMA table_info(context_packages)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(contextCols).toContain("workflow_step_run_id");

    const taskCols = (
      db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(taskCols).toContain("workflow_step_run_id");

    const recCols = (
      db.prepare("PRAGMA table_info(recommendations)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(recCols).toContain("workflow_step_run_id");
  });

  it("keeps goal_id on all goal-scoped workflow tables", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    for (const table of [
      "workflow_runs",
      "workflow_step_runs",
      "workflow_artifacts",
      "workflow_decisions",
      "workflow_guardrail_evaluations",
      "workflow_llm_calls"
    ]) {
      const cols = (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name);
      expect(cols).toContain("goal_id");
    }
  });

  it("upgrades from 0009 to latest and then re-run is a no-op", () => {
    const db = freshDb();
    const dir0009 = createMigrationsDir([
      "0001_init.sql",
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql"
    ]);

    const before = runMigrations(db, dir0009);
    expect(before.applied).toEqual([
      "0001_init.sql",
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql"
    ]);

    const upgrade = runMigrations(db, defaultMigrationsDir());
    expect(upgrade.applied).toEqual([
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql",
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql"
    ]);

    const rerun = runMigrations(db, defaultMigrationsDir());
    expect(rerun.applied).toEqual([]);
  });

  it("keeps foreign keys enabled and enforces workflow FK constraints", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
    expect(foreignKeys).toBe(1);

    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "orca/engineering",
      "Engineering",
      "",
      1,
      1,
      1,
      "[]",
      "[]",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    expect(() => {
      db.prepare(
        "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "run-1",
        "missing-goal",
        "orca/engineering",
        1,
        "active",
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows workflow recommendation types after migrations", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', 'desc', 'active', 1, ?, ?, NULL)"
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    db.prepare(
      `INSERT INTO recommendations
        (id, goal_id, generation_id, type, status, source, title, rationale,
         proposed_action_json, confidence, sources_json, related_task_id,
         related_session_id, related_context_pkg_id, related_conflict_id,
         fingerprint, superseded_by_id, superseded_reason, created_at, updated_at,
         resolved_at, workflow_step_run_id)
       VALUES ('rec-1', 'goal-1', NULL, 'advance_workflow_step', 'proposed',
         'deterministic_provider', 'Advance', 'ok',
         '{"kind":"advance_workflow_step","workflowRunId":"run-1","workflowStepRunId":"step-1","toStepTemplateId":"qa"}',
         0.8, '[]', NULL, NULL, NULL, NULL, 'fp-1', NULL, NULL, ?, ?, NULL, NULL)`
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const row = db
      .prepare("SELECT type FROM recommendations WHERE id = 'rec-1'")
      .get() as { type: string };
    expect(row.type).toBe("advance_workflow_step");
  });
});

describe("migration 0021 workflow_template scope and graph", () => {
  it("adds scope, scope_name, graph_json columns to workflow_templates", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const cols = (db.prepare("PRAGMA table_info(workflow_templates)").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain("scope");
    expect(cols).toContain("scope_name");
    expect(cols).toContain("graph_json");
  });

  it("rows inserted without new columns get back-compat defaults", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    // Insert using only the original column set
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "custom/back-compat",
      "Back Compat",
      "desc",
      1,
      0,
      0,
      "[]",
      "[]",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    const row = db
      .prepare("SELECT scope, scope_name, graph_json FROM workflow_templates WHERE id = ?")
      .get("custom/back-compat") as { scope: string; scope_name: string; graph_json: string | null };

    expect(row.scope).toBe("global");
    expect(row.scope_name).toBe("");
    expect(row.graph_json).toBeNull();
  });
});

describe("migration 0012 orchestration transport", () => {
  function seedGoal(db: ReturnType<typeof freshDb>, id: string) {
    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "Transport Goal", "", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
  }

  function seedWorkflowGraph(
    db: ReturnType<typeof freshDb>,
    goalId: string,
    workflowRunId: string,
    stepRunId: string
  ) {
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "orca/transport-test",
      "Transport Test",
      "",
      1,
      1,
      1,
      "[]",
      "[]",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      workflowRunId,
      goalId,
      "orca/transport-test",
      1,
      "active",
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      null
    );

    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      stepRunId,
      goalId,
      workflowRunId,
      "step-1",
      1,
      1,
      "pending",
      "[]",
      "[]",
      null,
      null,
      null,
      "fp-step-1"
    );
  }

  it("creates orchestration tables and required indexes", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    for (const expected of [
      "orchestration_workers",
      "orchestration_worker_output_chunks",
      "orchestration_transport_attempts",
      "orchestration_worker_hook_traces",
      "orchestration_human_reviews"
    ]) {
      expect(tables).toContain(expected);
    }

    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    for (const expected of [
      "idx_orchestration_workers_provider_model_state",
      "idx_orchestration_workers_state_health",
      "idx_orchestration_workers_goal_run_step",
      "idx_orchestration_worker_output_written",
      "idx_orchestration_attempts_goal_created",
      "idx_orchestration_attempts_run_created",
      "idx_orchestration_attempts_step_created",
      "idx_orchestration_attempts_worker_created",
      "idx_orchestration_attempts_active_reconcile",
      "idx_orchestration_hook_traces_attempt_created",
      "idx_orchestration_hook_traces_worker_created",
      "idx_orchestration_human_reviews_goal_created",
      "idx_orchestration_human_reviews_run_created",
      "idx_orchestration_human_reviews_step_created",
      "idx_orchestration_human_reviews_attempt",
      "idx_orchestration_human_reviews_status_created"
    ]) {
      expect(indices).toContain(expected);
    }
  });

  it("enforces orchestration CHECK constraints", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    seedGoal(db, "goal-check");
    seedWorkflowGraph(db, "goal-check", "run-check", "step-check");

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, pid, command, args_json, cwd, current_goal_id, current_workflow_run_id, current_step_run_id, last_health_at, last_output_at, failure_reason, failure_detail, created_at, started_at, stopped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "worker-check",
      "orca/openai",
      "gpt-5",
      "codex",
      "ready",
      null,
      null,
      null,
      null,
      "goal-check",
      "run-check",
      "step-check",
      null,
      null,
      null,
      null,
      "2026-01-01T00:00:00.000Z",
      null,
      null
    );

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("worker-bad-state", "orca/openai", "gpt-5", "codex", "invalid", "2026-01-01T00:00:00.000Z");
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "attempt-bad-transport",
        "goal-check",
        "run-check",
        "step-check",
        null,
        "orca/openai",
        "gpt-5",
        "invalid_transport",
        "worker-check",
        "pending",
        null,
        null,
        null,
        null,
        "fp-attempt",
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/CHECK constraint failed/);

    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "attempt-check",
      "goal-check",
      "run-check",
      "step-check",
      null,
      "orca/openai",
      "gpt-5",
      "one_shot",
      "worker-check",
      "pending",
      null,
      null,
      null,
      null,
      "fp-attempt-check",
      "2026-01-01T00:00:00.000Z",
      null
    );

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "attempt-bad-status",
        "goal-check",
        "run-check",
        "step-check",
        null,
        "orca/openai",
        "gpt-5",
        "one_shot",
        "worker-check",
        "invalid_status",
        null,
        null,
        null,
        null,
        "fp-attempt-bad-status",
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_worker_hook_traces (id, attempt_id, worker_id, provider_id, hook_event_name, hook_status, summary, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "trace-bad-status",
        "attempt-check",
        "worker-check",
        "orca/openai",
        "before-submit",
        "invalid_status",
        "summary",
        null,
        "2026-01-01T00:00:00.000Z"
      );
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_human_reviews (id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status, submitted_proposal_json, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "review-bad-status",
        "goal-check",
        "run-check",
        "step-check",
        "attempt-check",
        "select_operator",
        "{}",
        "invalid_status",
        null,
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/CHECK constraint failed/);
  });

  it("enforces orchestration foreign keys and cascades", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    seedGoal(db, "goal-fk");
    seedWorkflowGraph(db, "goal-fk", "run-fk", "step-fk");

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("worker-fk", "orca/openai", "gpt-5", "codex", "ready", "2026-01-01T00:00:00.000Z");

    db.prepare(
      "INSERT INTO orchestration_worker_output_chunks (worker_id, seq, byte_offset, byte_length, written_at, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("worker-fk", 1, 0, 4, "2026-01-01T00:00:00.000Z", Buffer.from("test"));

    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "attempt-fk",
      "goal-fk",
      "run-fk",
      "step-fk",
      null,
      "orca/openai",
      "gpt-5",
      "hidden_interactive",
      "worker-fk",
      "running",
      null,
      null,
      null,
      null,
      "fp-attempt-fk",
      "2026-01-01T00:00:00.000Z",
      null
    );

    db.prepare(
      "INSERT INTO orchestration_worker_hook_traces (id, attempt_id, worker_id, provider_id, hook_event_name, hook_status, summary, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "trace-fk",
      "attempt-fk",
      "worker-fk",
      "orca/openai",
      "after-submit",
      "started",
      "summary",
      null,
      "2026-01-01T00:00:00.000Z"
    );

    db.prepare(
      "INSERT INTO orchestration_human_reviews (id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status, submitted_proposal_json, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "review-fk",
      "goal-fk",
      "run-fk",
      "step-fk",
      "attempt-fk",
      "select_operator",
      "{}",
      "pending",
      null,
      "2026-01-01T00:00:00.000Z",
      null
    );

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "attempt-missing-goal",
        "goal-missing",
        null,
        null,
        null,
        "orca/openai",
        "gpt-5",
        "one_shot",
        null,
        "pending",
        null,
        null,
        null,
        null,
        "fp-attempt-missing-goal",
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/FOREIGN KEY constraint failed/);

    expect(() => {
      db.prepare(
        "INSERT INTO orchestration_human_reviews (id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status, submitted_proposal_json, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "review-missing-attempt",
        "goal-fk",
        "run-fk",
        "step-fk",
        "attempt-missing",
        "select_operator",
        "{}",
        "pending",
        null,
        "2026-01-01T00:00:00.000Z",
        null
      );
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare("UPDATE orchestration_transport_attempts SET worker_id = NULL WHERE id = ?").run(
      "attempt-fk"
    );
    db.prepare("DELETE FROM orchestration_workers WHERE id = ?").run("worker-fk");

    const outputCount = (
      db
        .prepare("SELECT count(*) AS cnt FROM orchestration_worker_output_chunks WHERE worker_id = ?")
        .get("worker-fk") as { cnt: number }
    ).cnt;
    expect(outputCount).toBe(0);

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("worker-fk-2", "orca/openai", "gpt-5", "codex", "ready", "2026-01-01T00:00:00.000Z");

    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "attempt-cascade",
      "goal-fk",
      "run-fk",
      "step-fk",
      null,
      "orca/openai",
      "gpt-5",
      "hidden_interactive",
      null,
      "running",
      null,
      null,
      null,
      null,
      "fp-attempt-cascade",
      "2026-01-01T00:00:00.000Z",
      null
    );

    db.prepare(
      "INSERT INTO orchestration_worker_hook_traces (id, attempt_id, worker_id, provider_id, hook_event_name, hook_status, summary, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "trace-cascade",
      "attempt-cascade",
      "worker-fk-2",
      "orca/openai",
      "after-submit",
      "started",
      "summary",
      null,
      "2026-01-01T00:00:00.000Z"
    );

    db.prepare("DELETE FROM orchestration_transport_attempts WHERE id = ?").run("attempt-cascade");
    const traceCount = (
      db
        .prepare("SELECT count(*) AS cnt FROM orchestration_worker_hook_traces WHERE id = ?")
        .get("trace-cascade") as { cnt: number }
    ).cnt;
    expect(traceCount).toBe(0);
  });

  it("upgrades from M8 schema and registers 0012 exactly once", () => {
    const db = freshDb();
    const m8Dir = createMigrationsDir([
      "0001_init.sql",
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql"
    ]);

    const baseline = runMigrations(db, m8Dir);
    expect(baseline.applied).toEqual([
      "0001_init.sql",
      "0002_workspaces_refinements.sql",
      "0004_sessions.sql",
      "0005_memory.sql",
      "0006_context.sql",
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql"
    ]);

    const upgrade = runMigrations(db, defaultMigrationsDir());
    expect(upgrade.applied).toEqual([
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql"
    ]);

    const rerun = runMigrations(db, defaultMigrationsDir());
    expect(rerun.applied).toEqual([]);
  });
});
