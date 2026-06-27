import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { deriveWriteSet, parseNameStatus } from "./write-set.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-write-set-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  // Seed without the full FK chain (session/workspace/goal).
  db.pragma("foreign_keys = OFF");
  return db;
}

const NOW = "2026-06-24T00:00:00.000Z";

function seedMemory(db: Database.Database, id: string, sessionId: string | null): void {
  db.prepare(
    `INSERT INTO goal_memory_items
       (id, goal_id, type, status, content, content_hash, source_type, source_session_id, created_at, updated_at)
     VALUES (?, 'g1', 'note', 'candidate', 'c', ?, 'session', ?, ?, ?)`,
  ).run(id, id, sessionId, NOW, NOW);
}

function seedDecision(db: Database.Database, id: string, sessionId: string | null): void {
  db.prepare(
    `INSERT INTO goal_decisions
       (id, goal_id, title, decision_text, status, source_type, source_session_id, created_at, updated_at)
     VALUES (?, 'g1', 't', 'd', 'proposed', 'session', ?, ?, ?)`,
  ).run(id, sessionId, NOW, NOW);
}

describe("parseNameStatus", () => {
  it("parses ordinary M/A/D lines as status + path", () => {
    expect(parseNameStatus("M\tsrc/x.ts\nA\tsrc/new.ts\nD\tsrc/gone.ts\n")).toEqual([
      { status: "M", path: "src/x.ts" },
      { status: "A", path: "src/new.ts" },
      { status: "D", path: "src/gone.ts" },
    ]);
  });

  it("parses rename/copy lines (two tabs) to the DESTINATION path, not a tab-embedded ref", () => {
    expect(parseNameStatus("R100\tsrc/old.ts\tsrc/new.ts\n")).toEqual([
      { status: "R100", path: "src/new.ts" },
    ]);
    expect(parseNameStatus("C75\ta.ts\tb.ts\n")).toEqual([{ status: "C75", path: "b.ts" }]);
  });

  it("skips blank lines and lines without a tab", () => {
    expect(parseNameStatus("\nM\tsrc/x.ts\nnotabhere\n")).toEqual([
      { status: "M", path: "src/x.ts" },
    ]);
  });
});

describe("deriveWriteSet", () => {
  it("combines bounded git diff file entries with session-created memory/decision rows", () => {
    const db = setupDb();
    seedMemory(db, "m1", "s1");
    seedDecision(db, "d1", "s1");
    // Rows from a different session must be excluded.
    seedMemory(db, "m2", "other");
    seedDecision(db, "d2", null);

    const fakeDiffer = (_cwd: string) => [
      { status: "M", path: "src/x.ts" },
      { status: "A", path: "src/new.ts" },
      { status: "D", path: "src/gone.ts" },
      { status: "R100", path: "src/renamed.ts" },
    ];

    const writeSet = deriveWriteSet(db, { workspacePath: "/repo", sessionId: "s1" }, fakeDiffer);

    expect(writeSet).toContainEqual({ kind: "file", ref: "src/x.ts", change_kind: "modified" });
    expect(writeSet).toContainEqual({ kind: "file", ref: "src/new.ts", change_kind: "created" });
    expect(writeSet).toContainEqual({ kind: "file", ref: "src/gone.ts", change_kind: "deleted" });
    expect(writeSet).toContainEqual({ kind: "file", ref: "src/renamed.ts", change_kind: "modified" });
    expect(writeSet).toContainEqual({ kind: "memory_item", ref: "m1", change_kind: "created" });
    expect(writeSet).toContainEqual({ kind: "decision", ref: "d1", change_kind: "created" });

    expect(writeSet).not.toContainEqual({ kind: "memory_item", ref: "m2", change_kind: "created" });
    expect(writeSet).not.toContainEqual({ kind: "decision", ref: "d2", change_kind: "created" });

  });

  it("omits file entries when the git differ fails, still returns created rows", () => {
    const db = setupDb();
    seedMemory(db, "m1", "s1");

    const failingDiffer = () => {
      throw new Error("git unavailable");
    };

    const writeSet = deriveWriteSet(db, { workspacePath: "/repo", sessionId: "s1" }, failingDiffer);

    expect(writeSet).toEqual([{ kind: "memory_item", ref: "m1", change_kind: "created" }]);
  });
});
