import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { conflictPolicyForGoal, conflictPolicyForMode } from "./conflict-policy.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-conflict-policy-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.pragma("foreign_keys = OFF");
  return db;
}

const NOW = "2026-06-26T00:00:00.000Z";

function seedGoal(db: Database.Database, id: string, mode: "human_review" | "automated"): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, operating_mode, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'G', 'd', 'active', 1, ?, ?, ?, NULL, NULL, NULL)"
  ).run(id, mode, NOW, NOW);
}

describe("conflictPolicyForMode", () => {
  it("maps automated -> auto (warn) and human_review -> escalate (pause)", () => {
    expect(conflictPolicyForMode("automated")).toBe("auto");
    expect(conflictPolicyForMode("human_review")).toBe("escalate");
  });
});

describe("conflictPolicyForGoal", () => {
  it("derives the policy from the goal's operating_mode", () => {
    const db = setupDb();
    seedGoal(db, "g-auto", "automated");
    seedGoal(db, "g-hr", "human_review");
    expect(conflictPolicyForGoal(db, "g-auto")).toBe("auto");
    expect(conflictPolicyForGoal(db, "g-hr")).toBe("escalate");
  });

  it("defaults to escalate (the safe floor) when the goal is absent", () => {
    const db = setupDb();
    expect(conflictPolicyForGoal(db, "g-missing")).toBe("escalate");
  });
});
