import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertProposal, getProposal, getBaseline } from "./store.js";
import { applyLearnedInstructionEdit, rollbackAppliedProposal, restoreTemplateDefault, StaleProposalError, NoBaselineError } from "./apply.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-apply-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function seedLockedTemplate(db: Database.Database) {
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate","instructions":"old"}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
}
function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1",
    component: "step_instructions", beforeInstructions: "old", afterInstructions: "new schema-aware text",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}
function stepsJson(db: Database.Database): string {
  return (db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = 'tpl'`).get() as { steps_json: string }).steps_json;
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seedLockedTemplate(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("applyLearnedInstructionEdit", () => {
  it("writes in place on a locked built-in, captures baseline, bumps version", () => {
    insertProposal(db, proposal());
    const { newVersion } = applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    expect(newVersion).toBe(2);
    expect(stepsJson(db)).toContain("new schema-aware text");
    expect(getProposal(db, "p1")).toMatchObject({ status: "applied", appliedAsVersion: 2, decidedBy: "owner" });
    expect(getBaseline(db, "tpl")?.baselineStepsJson).toContain('"instructions":"old"');
  });

  it("honors editedInstructions and sets humanEdited", () => {
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { editedInstructions: "human final text", decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    expect(stepsJson(db)).toContain("human final text");
    expect(getProposal(db, "p1")?.humanEdited).toBe(true);
  });

  it("rejects a stale proposal (template moved)", () => {
    insertProposal(db, proposal({ templateVersionAtProposal: 99 }));
    expect(() => applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" })).toThrow(StaleProposalError);
    // Supersede write must persist even though the function threw.
    expect(getProposal(db, "p1")?.status).toBe("superseded");
    // Template must NOT have been written — the throw happens before the success-path transaction.
    expect(stepsJson(db)).not.toContain("new schema-aware text");
    expect(stepsJson(db)).toContain('"instructions":"old"');
  });

  it("supersedes other pending proposals for the same step when one is applied", () => {
    insertProposal(db, proposal({ id: "p1" }));
    insertProposal(db, proposal({ id: "p2" }));
    applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    expect(getProposal(db, "p1")?.status).toBe("applied");
    expect(getProposal(db, "p2")?.status).toBe("superseded");
  });
});

describe("rollback + restore", () => {
  it("rolls back to before text on a forward version", () => {
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    const { newVersion } = rollbackAppliedProposal(db, "p1", { decidedBy: "owner", now: "2026-06-30T02:00:00.000Z" });
    expect(newVersion).toBe(3);
    expect(stepsJson(db)).toContain('"instructions":"old"');
    expect(getProposal(db, "p1")?.status).toBe("rolled_back");
  });

  it("restore-default requires a baseline and supersedes applied", () => {
    expect(() => restoreTemplateDefault(db, "tpl", "2026-06-30T02:00:00.000Z")).toThrow(NoBaselineError);
    insertProposal(db, proposal());
    applyLearnedInstructionEdit(db, "p1", { decidedBy: "owner", now: "2026-06-30T01:00:00.000Z" });
    restoreTemplateDefault(db, "tpl", "2026-06-30T03:00:00.000Z");
    expect(stepsJson(db)).toContain('"instructions":"old"');
    expect(getProposal(db, "p1")?.status).toBe("superseded");
    expect(getBaseline(db, "tpl")?.restoredAt).toBe("2026-06-30T03:00:00.000Z");
  });
});
