import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryFilePath,
  writeDiscoveryFile,
  readDiscoveryFile,
  removeDiscoveryFile,
  type DiscoveryRecord,
} from "./discovery-file.js";

const rec: DiscoveryRecord = {
  version: 1,
  url: "http://127.0.0.1:8787",
  token: "tok-123",
  pid: 4242,
  startedAt: "2026-06-20T00:00:00.000Z",
  protocol: "http",
};

describe("discovery-file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-disc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes and reads back the record", () => {
    writeDiscoveryFile(dir, rec);
    expect(readDiscoveryFile(dir)).toEqual(rec);
  });

  it("path is daemon.json under dataDir", () => {
    expect(discoveryFilePath(dir)).toBe(join(dir, "daemon.json"));
  });

  it("returns null when absent", () => {
    expect(readDiscoveryFile(dir)).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    writeFileSync(discoveryFilePath(dir), "{not json", "utf8");
    expect(readDiscoveryFile(dir)).toBeNull();
  });

  it("removeDiscoveryFile is idempotent", () => {
    writeDiscoveryFile(dir, rec);
    removeDiscoveryFile(dir);
    removeDiscoveryFile(dir);
    expect(existsSync(discoveryFilePath(dir))).toBe(false);
  });

  it("writes with 0600 permissions (non-Windows)", () => {
    if (process.platform === "win32") return;
    writeDiscoveryFile(dir, rec);
    expect(statSync(discoveryFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});
