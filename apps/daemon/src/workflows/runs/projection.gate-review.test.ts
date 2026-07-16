import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { getWorkflowRunById, resetPreparedStatements } from "./projection.js";

const NOW = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-projection-"));
  dirs.push(dir);
  const cfg = { dataDir: dir, port: 0, logLevel: "silent", sessionOutputTailBytes: 1, sessionStopGraceMs: 1, sessionWsBufferLimitBytes: 1, memoryExtractionMaxInputBytes: 1, memoryExtractionTimeoutMs: 1, hookResolverCommand: ["node"], getAuthToken: () => "t" } as unknown as Config;
  const db = openDatabase(cfg);
  runMigrations(db, defaultMigrationsDir());
  db.prepare("INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1','G','i','active',1,?,?,NULL)").run(NOW, NOW);
  db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/t','T','',1,1,1,'[]','[]',?,?)").run(NOW, NOW);
  return db;
}

function seedGateRun(db: Database.Database, gateStash: object): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, pending_gate_route_json, blocked_reason, started_at, finished_at) VALUES ('run-1','goal-1','orca/t',1,'active',NULL,'critique','gate',?,NULL,?,NULL)"
  ).run(JSON.stringify(gateStash), NOW);
}

afterEach(() => {
  resetPreparedStatements();
  closeDatabase();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("run projection — pendingGateReview", () => {
  it("surfaces a worker gate's recommendation while parked awaiting a human decision", () => {
    const db = setup();
    seedGateRun(db, {
      awaitingHumanDecision: true,
      gateNodeId: "critique",
      sourceStepRunId: "step-src",
      recommendedOutcome: "rejected",
      reasoning: "The lock is held across the trade call.",
      issueRefs: ["threading.Lock", "trading purity"],
    });

    const review = getWorkflowRunById(db, "run-1")!.pendingGateReview;
    expect(review).toEqual({
      gateNodeId: "critique",
      recommendedOutcome: "rejected",
      reasoning: "The lock is held across the trade call.",
      reason: null,
      issueRefs: ["threading.Lock", "trading purity"],
      residualRisks: [],
      inputsConsidered: [],
    });
  });

  it("is null for an in-flight worker gate (awaitingWorker, no verdict yet)", () => {
    const db = setup();
    seedGateRun(db, { awaitingWorker: true, gateNodeId: "critique", sourceStepRunId: "step-src", surrogateStepRunId: "sur-1" });
    expect(getWorkflowRunById(db, "run-1")!.pendingGateReview ?? null).toBeNull();
  });

  it("is null for a plain human gate park (no recommendation)", () => {
    const db = setup();
    seedGateRun(db, { awaitingHumanDecision: true, gateNodeId: "designgate", sourceStepRunId: "step-src" });
    expect(getWorkflowRunById(db, "run-1")!.pendingGateReview ?? null).toBeNull();
  });
});
