import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, lockFilePath, isPidAlive } from "./singleton.js";

describe("singleton lock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-lock-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("acquires when free, blocks a second live holder", () => {
    expect(acquireLock(dir)).toBe(true);
    // simulate a different live holder by leaving our own pid in the file
    expect(acquireLock(dir)).toBe(false);
  });

  it("steals a lock held by a dead pid", () => {
    writeFileSync(lockFilePath(dir), "999999999", "utf8"); // pid that does not exist
    expect(acquireLock(dir)).toBe(true);
  });

  it("does NOT steal a lock whose pid is unreadable/corrupt", () => {
    writeFileSync(lockFilePath(dir), "not-a-pid", "utf8");
    expect(acquireLock(dir)).toBe(false);
  });

  it("releaseLock removes our lock", () => {
    acquireLock(dir);
    releaseLock(dir);
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });

  it("isPidAlive true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive false for impossible pid", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });
});
