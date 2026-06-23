import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { nextTraversalSeq } from "../gates/usecases.js";
import { recordSplitDecision } from "./usecases.js";
import { listSplitDecisionsForRun } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES ('g','G','','active',1,'2026-06-22T00:00:00.000Z','2026-06-22T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','2026-06-22T00:00:00.000Z','2026-06-22T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','2026-06-22T00:00:00.000Z')"
  ).run();
});

describe("recordSplitDecision", () => {
  it("inserts and round-trips a split decision row", () => {
    const seq = nextTraversalSeq(db, "r");
    recordSplitDecision(db, () => "2026-06-22T00:00:01.000Z", {
      id: "sd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "route",
      traversalSeq: seq,
      selectedBranch: "ground_and_design",
      reason: "intent clear",
      selectedEdgeTo: "research",
      inputsConsidered: ["triage"],
      ledgerVersion: 2,
    });
    const decisions = listSplitDecisionsForRun(db, "r");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      nodeId: "route",
      selectedBranch: "ground_and_design",
      selectedEdgeTo: "research",
      ledgerVersion: 2,
    });
  });

  it("rejects a duplicate (run, node, traversalSeq)", () => {
    const args = {
      id: "sd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "route",
      traversalSeq: 1,
      selectedBranch: "approach_only",
      reason: "obvious",
      selectedEdgeTo: "proposal",
      inputsConsidered: [],
      ledgerVersion: 0,
    };
    recordSplitDecision(db, () => "2026-06-22T00:00:01.000Z", args);
    expect(() =>
      recordSplitDecision(db, () => "2026-06-22T00:00:02.000Z", { ...args, id: "sd2" })
    ).toThrow();
  });
});
