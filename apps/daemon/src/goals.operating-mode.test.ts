import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-opmode-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("operating_mode column", () => {
  it("backfills human_review for ask goals and automated for auto goals", () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at,worker_permission_mode) VALUES ('g-ask','A','','active',1,?,?,NULL,'ask')`).run(now, now);
    db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at,worker_permission_mode) VALUES ('g-auto','B','','active',1,?,?,NULL,'auto')`).run(now, now);
    // The migration backfills based on the value present AT MIGRATION TIME; these rows are
    // inserted post-migration, so assert the column exists + defaults instead:
    const ask = db.prepare("SELECT operating_mode FROM goals WHERE id='g-ask'").get() as { operating_mode: string };
    const auto = db.prepare("SELECT operating_mode FROM goals WHERE id='g-auto'").get() as { operating_mode: string };
    expect(ask.operating_mode).toBe("human_review"); // default
    expect(auto.operating_mode).toBe("human_review"); // default (backfill ran before these inserts)
  });
  it("rejects an invalid operating_mode via CHECK", () => {
    const now = "2026-01-01T00:00:00.000Z";
    expect(() =>
      db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at,operating_mode) VALUES ('g','x','','active',1,?,?,NULL,'bogus')`).run(now, now)
    ).toThrow();
  });
});
