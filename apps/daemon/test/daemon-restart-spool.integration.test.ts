// apps/daemon/test/daemon-restart-spool.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndDeliver } from "../src/hooks-resolver/resolver.js";
import { listSpool } from "../src/discovery/spool.js";
import { startDaemon } from "../src/index.js";

describe("completion survives a daemon-down window", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-restart-")); process.env.ORCA_DATA_DIR = dir; process.env.ORCA_PORT = "0"; });
  afterEach(() => { delete process.env.ORCA_DATA_DIR; delete process.env.ORCA_PORT; rmSync(dir, { recursive: true, force: true }); });

  it("spools a stop hook with no daemon, then drains it on startup", async () => {
    // 1) daemon is DOWN: resolver must spool, not lose the signal
    const r = await resolveAndDeliver({
      dataDir: dir,
      relUrl: "/v1/agent-hooks/response-done",
      body: JSON.stringify({ sessionId: "nonexistent", adapterId: "claude-code", responseText: "done" }),
      spoolable: true,
      now: () => new Date().toISOString(),
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);

    // 2) daemon starts: startup drains the spool through the real route handler
    const handle = await startDaemon();
    try {
      // the unknown session is a no-op in onResponseDone, but the spool entry is consumed
      expect(listSpool(dir)).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
