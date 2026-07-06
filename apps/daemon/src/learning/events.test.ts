import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { recordEvent, listEventsByTemplate, currentTemplateVersion } from "./events.js";

const NOW = "2026-07-06T00:00:00.000Z";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-events-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("learning events store", () => {
  it("round-trips each event type and lists newest-first with a clamped cap", () => {
    const mk = (i: number): void => recordEvent(db, {
      templateId: "tpl", proposalId: `p${i}`, stepTemplateId: "s1",
      eventType: "dismissed", templateVersion: 1, payload: { kind: "dismissed" },
    }, `2026-07-06T00:00:0${Math.min(i, 9)}.000Z`);
    for (let i = 0; i < 7; i++) mk(i);
    const events = listEventsByTemplate(db, "tpl", 3);
    expect(events).toHaveLength(3);
    expect(events[0].proposalId).toBe("p6"); // newest first
    expect(listEventsByTemplate(db, "tpl", 500)).toHaveLength(7); // clamp <=100 still returns all 7
  });

  it("rejects an oversized payload and a mismatched kind", () => {
    expect(() => recordEvent(db, { templateId: "tpl", proposalId: "p", stepTemplateId: "s1", eventType: "created",
      payload: { kind: "dismissed" } as never, templateVersion: 1 }, NOW)).toThrow();
    const bigSkips = Array.from({ length: 20 }, (_, i) => ({ stepTemplateId: `step-${i}`, reason: "x".repeat(300) }));
    expect(() => recordEvent(db, { templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "analyzed",
      payload: { kind: "analyzed", stepsDiagnosed: 20, proposalsCreated: 0, skips: bigSkips }, templateVersion: 1 }, NOW)).toThrow(/payload/i);
  });

  it("rolled_back payload round-trips the frozen outcome snapshot", () => {
    recordEvent(db, { templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "rolled_back", templateVersion: 3,
      payload: { kind: "rolled_back", outcome: { targetDelta: -0.08, targetDeltaVersions: { latest: 3, prior: 2 }, invalidOutputRateDelta: null, regressionDetected: true } } }, NOW);
    const [e] = listEventsByTemplate(db, "tpl");
    expect(e.payload).toMatchObject({ kind: "rolled_back", outcome: { targetDelta: -0.08, regressionDetected: true } });
  });

  it("currentTemplateVersion throws when the template is missing", () => {
    expect(() => currentTemplateVersion(db, "nope")).toThrow();
  });
});
