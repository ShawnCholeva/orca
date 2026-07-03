import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertWorkspaceEntity, linkGoalWorkspace } from "../workspaces/projection.js";
import { probeWorkspaceForSession, realVersionProbe } from "./workspace-version.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-ws-version-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.pragma("foreign_keys = OFF");
  return db;
}

const NOW = "2026-06-26T00:00:00.000Z";

function seedWorkspace(db: Database.Database, id: string, goalId: string, p: string): void {
  insertWorkspaceEntity(db, {
    id,
    path: p,
    name: id,
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
  });
  linkGoalWorkspace(db, goalId, id, NOW);
}

function seedSession(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, 'claude-code', 't', 'running', ?)"
  ).run(id, goalId, workspaceId, NOW);
}

describe("probeWorkspaceForSession", () => {
  it("returns the session's workspace id, path, and live branch/dirty from the probe", () => {
    const db = setupDb();
    seedWorkspace(db, "ws1", "g1", "/repo/one");
    seedSession(db, "s1", "g1", "ws1");

    const result = probeWorkspaceForSession(db, "s1", () => ({ branch: "feature/x", dirty: true, commitHash: "abc123" }));

    expect(result).toEqual({ id: "ws1", path: "/repo/one", branch: "feature/x", dirty: true, commitHash: "abc123" });
  });

  it("returns null when the session does not exist", () => {
    const db = setupDb();
    expect(probeWorkspaceForSession(db, "s-none", () => ({ branch: "main", dirty: false, commitHash: null }))).toBeNull();
  });

  it("returns null when the session's workspace entity is absent", () => {
    const db = setupDb();
    seedSession(db, "s1", "g1", "ws-gone");
    expect(probeWorkspaceForSession(db, "s1", () => ({ branch: "main", dirty: false, commitHash: null }))).toBeNull();
  });
});

describe("realVersionProbe", () => {
  it("fails safe to {branch:null, dirty:null, commitHash:null} when the path is not a git repo", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-not-a-repo-"));
    tempDirs.push(dir);
    expect(realVersionProbe(dir)).toEqual({ branch: null, dirty: null, commitHash: null });
  });
});
