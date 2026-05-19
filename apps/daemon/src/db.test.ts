import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";

const createdDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    getAuthToken: () => "test-token"
  };
}

afterEach(() => {
  closeDatabase();

  for (const dirPath of createdDirs.splice(0)) {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

describe("database", () => {
  it("creates database file and enables WAL journal mode", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "orca-db-test-"));
    createdDirs.push(dataDir);

    const db = openDatabase(createConfig(dataDir));

    expect(existsSync(path.join(dataDir, "orca.db"))).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("enables foreign key enforcement", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "orca-db-test-"));
    createdDirs.push(dataDir);

    const db = openDatabase(createConfig(dataDir));

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("can be closed and reopened on the same path", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "orca-db-test-"));
    createdDirs.push(dataDir);

    const first = openDatabase(createConfig(dataDir));
    first.prepare("CREATE TABLE IF NOT EXISTS reopen_check (id INTEGER)").run();

    closeDatabase();

    expect(() => openDatabase(createConfig(dataDir))).not.toThrow();
  });
});
