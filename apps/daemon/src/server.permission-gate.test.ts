// apps/daemon/src/server.permission-gate.test.ts
// Unit-tests the gate decision logic by exercising a small extracted helper.
// To keep this testable without booting Fastify, the implementation extracts the
// decision into `resolvePermissionDecision(db, sessionId, payload)` (see Step 3);
// this test calls that helper directly against a seeded DB.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { EventBus } from "./events.js";
import { resolvePermissionDecision } from "./permission-gate.js";
import { resetPreparedStatements as resetTx } from "./harness-transitions/usecases.js";
import { listTransitionsByGoal } from "./harness-transitions/usecases.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-permgate-")); tempDirs.push(dir);
  const db = openDatabase(createConfig(dir)); runMigrations(db, defaultMigrationsDir()); return db;
}
function seed(db: Database.Database, mode: string) {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at,operating_mode) VALUES ('g','x','','active',1,?,?,NULL,?)`).run(now, now, mode);
  db.prepare(`INSERT INTO workspaces (id,path,name,description,created_at,updated_at) VALUES ('ws','/tmp/r','m','',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sessions (id,goal_id,workspace_id,adapter_id,title,status,created_at) VALUES ('s','g','ws','claude-code','t','running',?)`).run(now);
}
let db: Database.Database; let bus: EventBus; let n = 0;
beforeEach(() => { db = openTestDb(); bus = new EventBus(); n = 0; });
afterEach(() => { closeDatabase(); resetTx(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ctx = () => ({ db, bus, now: () => "2026-05-01T00:00:00.000Z", idFactory: () => `id-${++n}` });

describe("resolvePermissionDecision", () => {
  it("automated allows a normal edit and records an allow tool_gate transition", () => {
    seed(db, "automated");
    const d = resolvePermissionDecision(ctx(), "s", { toolName: "Edit", toolInput: { file_path: "/tmp/r/a" }, toolUseId: "u1" });
    expect(d).toBe("allow");
    const t = listTransitionsByGoal(db, "g").find((x) => x.boundary === "tool_gate");
    expect(t?.risk?.gate_decision).toBe("allow");
  });
  it("human_review asks for an edit", () => {
    seed(db, "human_review");
    expect(resolvePermissionDecision(ctx(), "s", { toolName: "Edit", toolInput: {}, toolUseId: "u2" })).toBe("require_approval");
  });
  it("denies rm -rf even when automated (hard constraint)", () => {
    seed(db, "automated");
    expect(resolvePermissionDecision(ctx(), "s", { toolName: "Bash", toolInput: { command: "rm -rf /" }, toolUseId: "u3" })).toBe("deny");
  });
  it("denies an unknown session (fail-closed)", () => {
    expect(resolvePermissionDecision(ctx(), "nope", { toolName: "Read", toolInput: {}, toolUseId: "u4" })).toBe("deny");
  });
  it("a require_approval decision records EXACTLY ONE tool_gate transition", () => {
    seed(db, "human_review");
    const d = resolvePermissionDecision(ctx(), "s", { toolName: "Edit", toolInput: { file_path: "/tmp/r/a" }, toolUseId: "u5" });
    expect(d).toBe("require_approval");
    const gates = listTransitionsByGoal(db, "g").filter((x) => x.boundary === "tool_gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]?.risk?.gate_decision).toBe("require_approval");
  });
  it("a deny decision records its tool_gate transition and the helper returns deny", () => {
    seed(db, "automated");
    const d = resolvePermissionDecision(ctx(), "s", { toolName: "Bash", toolInput: { command: "rm -rf /" }, toolUseId: "u6" });
    expect(d).toBe("deny");
    const gates = listTransitionsByGoal(db, "g").filter((x) => x.boundary === "tool_gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]?.risk?.gate_decision).toBe("deny");
  });
});
