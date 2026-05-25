import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  WORKFLOW_DECISION_MAX_INFLUENCES,
  WORKFLOW_DECISION_MAX_REASON_BYTES,
  type WorkflowDecisionInfluence,
} from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import {
  decisionFingerprint,
  getDecisionById,
  listDecisionsForRun,
  recordDecision,
} from "./usecases.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

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
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-decisions-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?)"
  ).run(
    id,
    "Engineering",
    "desc",
    JSON.stringify([
      {
        id: "intake",
        ordinal: 0,
        name: "Intake",
        purpose: "Collect user input",
        requiredInputs: [],
        requiredOutputs: ["goal_brief"],
        gateType: "human-input",
        recommendedCapabilities: [],
        validationExpectations: [],
        exitCriteria: ["brief captured"],
        recommendedOperatorIds: [],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

function seedRun(db: Database.Database, goalId: string, runId: string): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, 1, 'active', NULL, NULL, ?, NULL)"
  ).run(runId, goalId, "orca/engineering", NOW);
}

function seedStep(db: Database.Database, goalId: string, runId: string, stepId: string): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'intake', 0, 1, 'active', '[]', '[\"brief captured\"]', NULL, ?, NULL, 'fp-1')"
  ).run(stepId, goalId, runId, NOW);
}

function baseInfluence(id: string): WorkflowDecisionInfluence {
  return {
    kind: "artifact",
    id,
    label: `artifact ${id}`,
    effect: "required",
  };
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow decisions usecases", () => {
  it("write + read + list", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering");
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    const decision = recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_artifact",
        selectedAction: "ask user for goal brief",
        reason: "goal brief is required to continue",
        influencedBy: [baseInfluence("artifact-a")],
        inputFingerprint: "fp-1",
      },
      { idFactory: () => "decision-1" }
    );

    expect(decision.decisionId).toBe("decision-1");
    expect(decision.goalId).toBe("goal-1");
    expect(decision.workflowRunId).toBe("run-1");
    expect(decision.stepRunId).toBe("step-1");

    const fetched = getDecisionById(db, "decision-1");
    expect(fetched?.decisionId).toBe("decision-1");
    expect(fetched?.influencedBy).toHaveLength(1);

    const listed = listDecisionsForRun(db, "run-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.decisionId).toBe("decision-1");

    const event = db
      .prepare("SELECT type, payload FROM events ORDER BY seq DESC LIMIT 1")
      .get() as { type: string; payload: string };
    expect(event.type).toBe("workflow.decision.recorded");
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload.influencedByCount).toBe(1);
    expect(payload).not.toHaveProperty("reason");
  });

  it("fingerprint dedup returns existing row", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering");
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    const fingerprint = decisionFingerprint({
      runId: "run-1",
      stepRunId: "step-1",
      decisionType: "request_user_input",
      payload: { missing: ["goal_brief"] },
    });

    const first = recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_user_input",
        selectedAction: "request goal brief",
        reason: "needs user input",
        influencedBy: [baseInfluence("artifact-a")],
        inputFingerprint: fingerprint,
      },
      { idFactory: () => "decision-1" }
    );

    const second = recordDecision(
      db,
      () => "2026-01-01T00:00:01.000Z",
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_user_input",
        selectedAction: "different text ignored by dedupe",
        reason: "different reason ignored by dedupe",
        influencedBy: [baseInfluence("artifact-b")],
        inputFingerprint: fingerprint,
      },
      { idFactory: () => "decision-2" }
    );

    expect(first.decisionId).toBe("decision-1");
    expect(second.decisionId).toBe("decision-1");
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM workflow_decisions")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  it("truncates oversized reason to max bytes", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering");
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    const oversized = "🤖".repeat(900);
    const decision = recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "evaluate_exit_criteria",
        selectedAction: "evaluate",
        reason: oversized,
        influencedBy: [baseInfluence("artifact-a")],
        inputFingerprint: "fp-oversize",
      },
      { idFactory: () => "decision-oversize" }
    );

    expect(Buffer.byteLength(decision.reason, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_DECISION_MAX_REASON_BYTES
    );
  });

  it("truncates influencedBy to configured cap", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering");
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    const influencedBy = Array.from({ length: WORKFLOW_DECISION_MAX_INFLUENCES + 5 }).map(
      (_, idx) => baseInfluence(`artifact-${idx}`)
    );

    const decision = recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "select_operator",
        selectedAction: "use codex",
        reason: "operator selected",
        influencedBy,
        inputFingerprint: "fp-influences",
      },
      { idFactory: () => "decision-influences" }
    );

    expect(decision.influencedBy).toHaveLength(WORKFLOW_DECISION_MAX_INFLUENCES);
    const event = db
      .prepare("SELECT payload FROM events WHERE type = 'workflow.decision.recorded' ORDER BY seq DESC LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(event.payload) as { influencedByCount: number };
    expect(payload.influencedByCount).toBe(WORKFLOW_DECISION_MAX_INFLUENCES);
  });
});
