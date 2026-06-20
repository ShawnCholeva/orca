import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { EventBus } from "./events.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { seedAdapterExecutionModes } from "./adapters/execution-modes.js";
import { createDaemonContext } from "./daemon-context.js";

const tempDirs: string[] = [];

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

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createDaemonContext: AdapterDispatcher wiring", () => {
  it("exposes adapterDispatcher and resolves seeded adapters", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-ctx-dispatch-"));
    tempDirs.push(dir);
    const db = openDatabase(createConfig(dir));
    runMigrations(db, defaultMigrationsDir());
    seedAdapterExecutionModes(db, () => "2026-05-28T00:00:00.000Z", {
      "claude-code": ["shadow_session", "one_shot"],
      codex: ["one_shot", "shadow_session"],
    });

    const ctx = createDaemonContext(db, new EventBus());

    expect(ctx.adapterDispatcher).toBeDefined();
    const cc = ctx.adapterDispatcher.resolveMode("claude-code");
    expect(cc.mode).toBe("shadow_session");
    const cx = ctx.adapterDispatcher.resolveMode("codex");
    expect(cx.mode).toBe("shadow_session");
  });
});
