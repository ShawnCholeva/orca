import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { nextTraversalSeq, recordGateDecision } from "./usecases.js";
import { listGateDecisionsForRun } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES ('g','G','','active',1,'2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','2026-06-12T00:00:00.000Z')"
  ).run();
});

describe("nextTraversalSeq", () => {
  it("increments and persists the per-run counter", () => {
    expect(nextTraversalSeq(db, "r")).toBe(1);
    expect(nextTraversalSeq(db, "r")).toBe(2);
  });
});

describe("recordGateDecision", () => {
  it("inserts an immutable gate decision row", () => {
    const seq = nextTraversalSeq(db, "r");
    recordGateDecision(db, () => "2026-06-12T00:00:01.000Z", {
      id: "gd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "gate",
      traversalSeq: seq,
      outcome: "rejected",
      reason: "validation failed",
      reasoning: null,
      selectedEdgeTo: "execution",
      inputsConsidered: ["validation"],
      issueRefs: ["issue-1"],
      ledgerVersion: 0,
    });
    const decisions = listGateDecisionsForRun(db, "r");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ nodeId: "gate", outcome: "rejected", selectedEdgeTo: "execution" });
  });

  it("persists and round-trips ledgerVersion", () => {
    const seq = nextTraversalSeq(db, "r");
    recordGateDecision(db, () => "2026-06-12T00:00:01.000Z", {
      id: "gd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "gate",
      traversalSeq: seq,
      outcome: "approved",
      reason: "all good",
      reasoning: null,
      selectedEdgeTo: "next-step",
      inputsConsidered: [],
      issueRefs: [],
      ledgerVersion: 3,
    });
    const decisions = listGateDecisionsForRun(db, "r");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].ledgerVersion).toBe(3);
  });

  it("rejects a duplicate (run, node, traversalSeq)", () => {
    const args = {
      id: "gd1",
      goalId: "g",
      workflowRunId: "r",
      nodeId: "gate",
      traversalSeq: 1,
      outcome: "approved" as const,
      reason: "ok",
      reasoning: null,
      selectedEdgeTo: "done",
      inputsConsidered: [],
      issueRefs: [],
      ledgerVersion: 0,
    };
    recordGateDecision(db, () => "2026-06-12T00:00:01.000Z", args);
    expect(() => recordGateDecision(db, () => "2026-06-12T00:00:02.000Z", { ...args, id: "gd2" })).toThrow();
  });

  it("persists reasoning on the gate decision", () => {
    const id = recordGateDecision(db, () => "2026-07-04T00:00:00.000Z", {
      goalId: "g",
      workflowRunId: "r",
      nodeId: "n",
      traversalSeq: 1,
      outcome: "approved",
      reason: "ok",
      reasoning: "criteria met",
      selectedEdgeTo: "next",
      inputsConsidered: [],
      issueRefs: [],
      ledgerVersion: 1,
    });
    const row = db.prepare("SELECT reasoning FROM workflow_gate_decisions WHERE id = ?").get(id) as {
      reasoning: string | null;
    };
    expect(row.reasoning).toBe("criteria met");
  });
});
