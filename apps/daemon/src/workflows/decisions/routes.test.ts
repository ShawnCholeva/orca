import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  ListWorkflowDecisionsResponse,
  WorkflowDecisionResponse,
  type WorkflowDecisionInfluence,
} from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";
import { recordDecision } from "./usecases.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, ?, ?, ?)"
  ).run(
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
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(runId, goalId, NOW);
}

function seedStep(db: Database.Database, goalId: string, runId: string, stepId: string): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'intake', 0, 1, 'active', '[]', '[\"brief captured\"]', NULL, ?, NULL, 'fp-1')"
  ).run(stepId, goalId, runId, NOW);
}

function influence(id: string): WorkflowDecisionInfluence {
  return {
    kind: "artifact",
    id,
    label: id,
    effect: "required",
  };
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("workflow decision routes", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-decision-routes-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists decisions for a run scoped by goal", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_user_input",
        selectedAction: "request brief",
        reason: "brief missing",
        influencedBy: [influence("artifact-1")],
        inputFingerprint: "fp-1",
      },
      { idFactory: () => "decision-1" }
    );

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-1/decisions",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const parsed = ListWorkflowDecisionsResponse.parse(JSON.parse(response.body));
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0]?.decisionId).toBe("decision-1");
  });

  it("returns 404 when run does not belong to goal", async () => {
    seedGoal(db, "goal-1");
    seedGoal(db, "goal-2");
    seedTemplate(db);
    seedRun(db, "goal-2", "run-2");

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-runs/run-2/decisions",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it("gets a single decision scoped by goal", async () => {
    seedGoal(db, "goal-1");
    seedTemplate(db);
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_artifact",
        selectedAction: "request artifact",
        reason: "artifact needed",
        influencedBy: [influence("artifact-1")],
        inputFingerprint: "fp-1",
      },
      { idFactory: () => "decision-1" }
    );

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-decisions/decision-1",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const parsed = WorkflowDecisionResponse.parse(JSON.parse(response.body));
    expect(parsed.decision.decisionId).toBe("decision-1");
  });

  it("returns 404 when decision does not belong to goal", async () => {
    seedGoal(db, "goal-1");
    seedGoal(db, "goal-2");
    seedTemplate(db);
    seedRun(db, "goal-2", "run-2");
    seedStep(db, "goal-2", "run-2", "step-2");

    recordDecision(
      db,
      () => NOW,
      {
        goalId: "goal-2",
        workflowRunId: "run-2",
        stepRunId: "step-2",
        decisionType: "request_artifact",
        selectedAction: "request artifact",
        reason: "artifact needed",
        influencedBy: [influence("artifact-2")],
        inputFingerprint: "fp-2",
      },
      { idFactory: () => "decision-2" }
    );

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/workflow-decisions/decision-2",
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });
});
