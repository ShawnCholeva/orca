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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-routes-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  server = Fastify(); registerHarnessTransitionRoutes(server, { db }); await server.ready();
});
afterEach(async () => { await server.close(); closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("GET /v1/harness/registry", () => {
  it("returns facets, boundaries, and sensors", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/harness/registry" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facets.map((f: { key: string }) => f.key).sort()).toEqual(["composition", "evidence", "risk", "stateDeps", "telemetry"]);
    expect(body.boundaries.map((b: { key: string }) => b.key).sort()).toEqual(["delegate_join", "delegate_spawn", "mark_done", "step_complete", "step_launch", "tool_gate"]);
    const sensorByKind = Object.fromEntries(body.sensors.map((s: { kind: string; status: string }) => [s.kind, s.status]));
    expect(sensorByKind.typecheck).toBe("implemented");
    // Full ladder registered in Phase 3 — integration + static are now implemented.
    expect(sensorByKind.integration).toBe("implemented");
    expect(sensorByKind.static).toBe("implemented");
  });
});
