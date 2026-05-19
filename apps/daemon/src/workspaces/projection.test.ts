import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { Workspace } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import {
  deleteWorkspace,
  DuplicateWorkspaceError,
  findWorkspaceByPath,
  insertWorkspace,
  listWorkspacesByGoal,
  resetPreparedStatements,
} from "./projection.js";

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
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-workspace-projection-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function insertGoalRow(db: Database.Database, goalId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(goalId, "Goal", "", "active", 1, now, now, null);
}

function workspaceRow(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: overrides.id ?? "ws-1",
    goalId: overrides.goalId ?? "goal-1",
    path: overrides.path ?? "/tmp/a",
    name: overrides.name ?? "a",
    workspaceType: overrides.workspaceType ?? "folder",
    branch: overrides.branch ?? null,
    isDirty: overrides.isDirty ?? null,
    gitProbe: overrides.gitProbe ?? "not_a_repo",
    attachedAt: overrides.attachedAt ?? "2026-01-01T01:00:00.000Z",
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace projections", () => {
  it("inserts and finds a workspace by path", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");
    const workspace = workspaceRow({
      workspaceType: "repo",
      branch: "main",
      isDirty: false,
      gitProbe: "ok",
    });

    insertWorkspace(db, workspace);

    const found = findWorkspaceByPath(db, "goal-1", "/tmp/a");
    expect(found).toEqual(workspace);
  });

  it("lists workspaces ordered by attached_at ASC then id ASC", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");

    const later = workspaceRow({
      id: "ws-3",
      path: "/tmp/c",
      name: "c",
      attachedAt: "2026-01-01T02:00:00.000Z",
    });
    const tie1 = workspaceRow({
      id: "ws-1",
      path: "/tmp/a",
      name: "a",
      attachedAt: "2026-01-01T01:00:00.000Z",
    });
    const tie2 = workspaceRow({
      id: "ws-2",
      path: "/tmp/b",
      name: "b",
      attachedAt: "2026-01-01T01:00:00.000Z",
    });

    insertWorkspace(db, later);
    insertWorkspace(db, tie2);
    insertWorkspace(db, tie1);

    const ordered = listWorkspacesByGoal(db, "goal-1");
    expect(ordered.map((workspace) => workspace.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("deleteWorkspace returns true when deleted and false when missing", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");
    insertWorkspace(db, workspaceRow());

    expect(deleteWorkspace(db, "goal-1", "ws-1")).toBe(true);
    expect(deleteWorkspace(db, "goal-1", "ws-1")).toBe(false);
  });

  it("duplicate (goal_id, path) raises DuplicateWorkspaceError", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");
    insertWorkspace(db, workspaceRow({ id: "ws-1", path: "/tmp/dup" }));

    expect(() => insertWorkspace(db, workspaceRow({ id: "ws-2", path: "/tmp/dup" }))).toThrow(
      DuplicateWorkspaceError,
    );
    expect(() => insertWorkspace(db, workspaceRow({ id: "ws-2", path: "/tmp/dup" }))).toThrow(
      expect.objectContaining({ code: "workspace_duplicate" }),
    );
  });

  it("returns empty list for goal with no workspaces", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");

    expect(listWorkspacesByGoal(db, "goal-1")).toEqual([]);
  });

  it("findWorkspaceByPath returns null when not present", () => {
    const db = setup();
    insertGoalRow(db, "goal-1");

    expect(findWorkspaceByPath(db, "goal-1", "/tmp/missing")).toBeNull();
  });
});
