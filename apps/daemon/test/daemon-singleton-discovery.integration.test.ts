import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiscoveryFile } from "../src/discovery/discovery-file.js";
import { startDaemon } from "../src/index.js";

describe("daemon startup writes discovery file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-boot-")); process.env.ORCA_DATA_DIR = dir; process.env.ORCA_PORT = "0"; });
  afterEach(() => { delete process.env.ORCA_DATA_DIR; delete process.env.ORCA_PORT; rmSync(dir, { recursive: true, force: true }); });

  it("writes daemon.json with a live url+token after listen", async () => {
    const handle = await startDaemon();
    try {
      const rec = readDiscoveryFile(dir);
      expect(rec).not.toBeNull();
      expect(rec!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(rec!.token.length).toBeGreaterThan(0);
      expect(rec!.pid).toBe(process.pid);
    } finally {
      await handle.close();
    }
  });

  it("removes daemon.json on close", async () => {
    const handle = await startDaemon();
    await handle.close();
    expect(readDiscoveryFile(dir)).toBeNull();
  });
});
