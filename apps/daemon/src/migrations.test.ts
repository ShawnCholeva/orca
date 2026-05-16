import { mkdtempSync, rmSync } from "node:fs";
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

describe("runMigrations", () => {
  it("applies 0001_init.sql on a fresh database", () => {
    const db = freshDb();
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual(["0001_init.sql"]);
  });

  it("is idempotent — re-running on an already-migrated database applies nothing", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());
    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([]);
  });

  it("creates the events and goals tables", () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain("events");
    expect(tables).toContain("goals");
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
  });
});
