import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { TemplateInstructionProposal } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import {
  insertProposal, getProposal, listProposalsByTemplate, pendingProposalForStep,
  updateProposalDecision, supersedeOtherPending, captureBaseline, getBaseline, markBaselineRestored,
} from "./store.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-store-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1",
    component: "step_instructions", beforeInstructions: "old", afterInstructions: "new",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 62, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("learning store", () => {
  it("inserts and reads back a proposal", () => {
    insertProposal(db, proposal());
    expect(getProposal(db, "p1")).toMatchObject({ id: "p1", status: "pending" });
    expect(listProposalsByTemplate(db, "tpl")).toHaveLength(1);
    expect(pendingProposalForStep(db, "tpl", "s1")?.id).toBe("p1");
  });

  it("updates decision and supersedes other pending for the step", () => {
    insertProposal(db, proposal({ id: "p1" }));
    insertProposal(db, proposal({ id: "p2" }));
    updateProposalDecision(db, "p1", { status: "applied", decidedAt: "2026-06-30T01:00:00.000Z", decidedBy: "owner", appliedAsVersion: 2 });
    supersedeOtherPending(db, "tpl", "s1", "p1");
    expect(getProposal(db, "p1")).toMatchObject({ status: "applied", appliedAsVersion: 2, decidedBy: "owner" });
    expect(getProposal(db, "p2")?.status).toBe("superseded");
  });

  it("captures a baseline once and marks it restored", () => {
    captureBaseline(db, "tpl", '[{"id":"s1"}]', "2026-06-30T00:00:00.000Z");
    captureBaseline(db, "tpl", '[{"id":"CHANGED"}]', "2026-06-30T02:00:00.000Z"); // no-op
    expect(getBaseline(db, "tpl")?.baselineStepsJson).toBe('[{"id":"s1"}]');
    markBaselineRestored(db, "tpl", "2026-06-30T03:00:00.000Z");
    expect(getBaseline(db, "tpl")?.restoredAt).toBe("2026-06-30T03:00:00.000Z");
  });
});
