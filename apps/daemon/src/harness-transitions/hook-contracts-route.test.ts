import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerHarnessTransitionRoutes } from "./routes.js";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
let db: Database.Database; let server: FastifyInstance;
beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-hook-contracts-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  server = Fastify(); registerHarnessTransitionRoutes(server, { db }); await server.ready();
});
afterEach(async () => { await server.close(); closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("GET /v1/harness/hook-contracts", () => {
  it("enumerates per-provider hook contract entries with a status each", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/harness/hook-contracts" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contracts: Array<{ provider: string; surface: string; status: string }> };
    expect(body.contracts.length).toBeGreaterThan(0);
    const agyWorker = body.contracts.find((c) => c.provider === "antigravity" && c.surface === "worker");
    expect(agyWorker!.status).toBe("unverified");
    for (const c of body.contracts) {
      expect(["ok", "degraded", "unverified", "unknown", "nonconformant"]).toContain(c.status);
    }
  });
});
