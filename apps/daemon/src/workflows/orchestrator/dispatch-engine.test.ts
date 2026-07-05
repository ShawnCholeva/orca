import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { insertRecommendation } from "../../recommendations/projection.js";
import { insertFeedback, resetFeedbackStatements } from "../../recommendations/feedback.js";
import { recommendationFingerprint } from "../../recommendations/fingerprint.js";
import { recommendationFeedbackInterventions, stepEvaluationFailed } from "./dispatch-engine.js";

describe("stepEvaluationFailed", () => {
  it("is true only when the persisted step result's evaluationStatus is failed", () => {
    expect(stepEvaluationFailed(JSON.stringify({ evaluationStatus: "failed" }))).toBe(true);
    expect(stepEvaluationFailed(JSON.stringify({ evaluationStatus: "scored" }))).toBe(false);
    expect(stepEvaluationFailed(null)).toBe(false);
    expect(stepEvaluationFailed("not json")).toBe(false);
  });
});

const tempDirs: string[] = [];
const PROPOSED = JSON.stringify({ kind: "ask_user", question: "Proceed?" });

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-dispatch-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function insertRec(db: Database.Database, goalId: string, recId: string): void {
  insertRecommendation(db, {
    id: recId,
    goalId,
    generationId: null,
    type: "ask_user",
    status: "proposed",
    source: "deterministic_provider",
    title: "T",
    rationale: "T",
    proposedActionJson: PROPOSED,
    confidence: 0.8,
    sourcesJson: "[]",
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: null,
    fingerprint: recommendationFingerprint(goalId, "ask_user", `${recId}${PROPOSED}`),
    supersededById: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function feedbackAt(db: Database.Database, id: string, recId: string, at: string): void {
  insertFeedback(db, {
    id,
    goalId: "g",
    recommendationId: recId,
    action: "accept",
    note: null,
    modifiedPayloadJson: null,
    createdAt: at,
  });
}

function stepCompleteAt(db: Database.Database, id: string, at: string): void {
  db.prepare(
    `INSERT INTO harness_transitions
       (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
        risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
     VALUES (?, 'g', NULL, NULL, 'step_complete', NULL, NULL, NULL, NULL, ?)`
  ).run(id, at);
}

afterEach(() => {
  closeDatabase();
  resetFeedbackStatements();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recommendationFeedbackInterventions", () => {
  it("stamps only feedback created since the previous step_complete", () => {
    const db = freshDb();
    seedGoal(db, "g");
    insertRec(db, "g", "rec-1");
    insertRec(db, "g", "rec-2");
    insertRec(db, "g", "rec-3");
    // Two feedback rows already attributed to an earlier step...
    feedbackAt(db, "fb-1", "rec-1", "2026-01-01T00:00:01.000Z");
    feedbackAt(db, "fb-2", "rec-2", "2026-01-01T00:00:02.000Z");
    // ...the previous step_complete closed that window...
    stepCompleteAt(db, "t-prev", "2026-01-01T00:00:03.000Z");
    // ...and only this row arrived during the current step.
    feedbackAt(db, "fb-3", "rec-3", "2026-01-01T00:00:04.000Z");

    expect(recommendationFeedbackInterventions(db, "g")).toEqual([
      { kind: "recommendation_feedback", ref: "fb-3" },
    ]);
  });

  it("stamps all feedback so far on the first step (no prior step_complete)", () => {
    const db = freshDb();
    seedGoal(db, "g");
    insertRec(db, "g", "rec-1");
    insertRec(db, "g", "rec-2");
    feedbackAt(db, "fb-1", "rec-1", "2026-01-01T00:00:01.000Z");
    feedbackAt(db, "fb-2", "rec-2", "2026-01-01T00:00:02.000Z");

    expect(recommendationFeedbackInterventions(db, "g").map((i) => i.ref)).toEqual([
      "fb-2",
      "fb-1",
    ]);
  });
});
