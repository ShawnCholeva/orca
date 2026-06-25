import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { assertFacetConformance, assertBoundaryConformance } from "./conformance.js";

const dirs: string[] = [];
function config(dataDir: string): Config {
  return {
    dataDir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node", "x.js"],
    getAuthToken: () => "t",
  };
}
function migratedDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-conformance-"));
  dirs.push(dir);
  const db = openDatabase(config(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
afterEach(() => { closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("assertFacetConformance", () => {
  it("passes on a migrated database", () => {
    const db = migratedDb();
    expect(() => assertFacetConformance(db)).not.toThrow();
  });

  it("throws when the harness_transitions table is missing a facet column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE harness_transitions (id TEXT, goal_id TEXT)");
    expect(() => assertFacetConformance(db)).toThrow(/risk_json/);
  });
});

describe("assertBoundaryConformance", () => {
  it("passes — every boundary enum value has a registered emitter", () => {
    expect(() => assertBoundaryConformance()).not.toThrow();
  });
});
