import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { actionClassOf, recordApprovalOutcome, resetPreparedStatements } from "./accountability.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database { const dir = mkdtempSync(path.join(os.tmpdir(), "orca-acct-")); tempDirs.push(dir); const db = openDatabase(createConfig(dir)); runMigrations(db, defaultMigrationsDir()); return db; }
function seedGoal(db: Database.Database) { const now = "2026-01-01T00:00:00.000Z"; db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at) VALUES ('g','x','','active',1,?,?,NULL)`).run(now, now); }
let db: Database.Database; let bus: EventBus;
beforeEach(() => { db = openTestDb(); bus = new EventBus(); seedGoal(db); });
afterEach(() => { closeDatabase(); resetPreparedStatements(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ctx = () => ({ db, bus, now: () => "2026-05-01T00:00:00.000Z" });

describe("accountability", () => {
  it("derives a stable action class", () => {
    const a = actionClassOf("Bash", { riskClass: "high", permissionTier: "full_access", reasons: [], hardConstraintViolations: [] });
    expect(a).toBe("Bash:full_access");
  });
  it("suggests remember at the 3rd consecutive approval, resets on deny", () => {
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(true);
    recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "deny" });
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
  });
});
