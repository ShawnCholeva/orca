import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { recordDecisionInTx } from "../decisions/usecases.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { resetWorkflowStepProjectionPreparedStatements } from "./projection.js";
import { registerWorkflowStepRoutes } from "./routes.js";

const NOW = "2026-01-01T00:00:00.000Z";

const GOAL_ID = "goal-1";
const RUN_ID = "run-1";
const STEP_RUN_ID = "step-1";
const QUESTION_DECISION_ID = "dec-1";

const tempDirs: string[] = [];

function createConfig(dataDir: string) {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent" as const,
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

interface TestContext {
  db: Database.Database;
  app: ReturnType<typeof fastify>;
}

function setup(): TestContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-skill-input-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());

  // Seed goal
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Test Goal', 'desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run(GOAL_ID, NOW, NOW);

  // Seed workflow template
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('tmpl-1', 'Test', 'desc', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);

  // Seed workflow run
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'tmpl-1', 1, 'active', ?, NULL, ?, NULL)"
  ).run(RUN_ID, GOAL_ID, STEP_RUN_ID, NOW);

  // Seed workflow step run (explicitly list columns, supply [] for exit criteria columns)
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
  ).run(STEP_RUN_ID, GOAL_ID, RUN_ID, NOW);

  // Seed a request_user_input decision (must be in a transaction per recordDecisionInTx usage)
  db.transaction(() => {
    recordDecisionInTx(
      db,
      () => NOW,
      {
        goalId: GOAL_ID,
        workflowRunId: RUN_ID,
        stepRunId: STEP_RUN_ID,
        decisionType: "request_user_input",
        selectedAction: "request_input:intake",
        reason: "What problem?",
        influencedBy: [],
        inputFingerprint: "fp-q1",
      },
      { idFactory: () => QUESTION_DECISION_ID }
    );
  })();

  let nextId = 0;
  const app = fastify({ logger: false });
  // Deliberately omit orchestrationTransportBroker/operatorRegistry
  // so orchestratorService is null and requestNextDecision is skipped.
  // No auth middleware registered — bare Fastify, no auth header needed.
  registerWorkflowStepRoutes(app, {
    db,
    now: () => NOW,
    idFactory: () => `artifact-${++nextId}`,
  });

  return { db, app };
}

const openApps: Array<ReturnType<typeof fastify>> = [];

afterEach(async () => {
  for (const a of openApps.splice(0)) {
    await a.close();
  }
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("submit-input: interview_turn artifact creation", () => {
  it("creates an interview_turn artifact paired to the question decision", async () => {
    const { db, app } = setup();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: QUESTION_DECISION_ID,
        answerText: "scrolling",
      },
    });

    expect(response.statusCode).toBe(200);

    const turns = listArtifactsForRun(db, RUN_ID).filter(
      (a) => a.type === "interview_turn" && a.stepRunId === STEP_RUN_ID
    );
    expect(turns).toHaveLength(1);
    const parsed = JSON.parse(turns[0]!.body) as {
      turnIndex: number;
      questionDecisionId: string;
      question: string;
      answer: string;
    };
    expect(parsed).toMatchObject({
      turnIndex: 0,
      questionDecisionId: QUESTION_DECISION_ID,
      question: "What problem?",
      answer: "scrolling",
    });
  });

  it("rejects a mismatched questionDecisionId with 400 and creates no artifact", async () => {
    const { db, app } = setup();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: "dec-XXX",
        answerText: "x",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");

    const turns = listArtifactsForRun(db, RUN_ID).filter(
      (a) => a.type === "interview_turn" && a.stepRunId === STEP_RUN_ID
    );
    expect(turns).toHaveLength(0);
  });

  it("returns 409 for a duplicate answer and leaves exactly 1 interview_turn", async () => {
    const { db, app } = setup();
    openApps.push(app);

    // First submission succeeds
    const first = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: QUESTION_DECISION_ID,
        answerText: "scrolling",
      },
    });
    expect(first.statusCode).toBe(200);

    // Second submission with same questionDecisionId → 409
    const second = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: QUESTION_DECISION_ID,
        answerText: "scrolling again",
      },
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body) as { error: { code: string } };
    expect(body.error.code).toBe("question_already_answered");

    // Still exactly 1 interview_turn artifact
    const turns = listArtifactsForRun(db, RUN_ID).filter(
      (a) => a.type === "interview_turn" && a.stepRunId === STEP_RUN_ID
    );
    expect(turns).toHaveLength(1);
  });
});

describe("submit-input: PTY answer injection", () => {
  function setupWithSession(db: Database.Database): {
    sessionId: string;
    writeSpy: ReturnType<typeof vi.fn>;
  } {
    const sessionId = "sess-inject-1";
    const writeSpy = vi.fn();

    // Seed a workspace for FK
    db.prepare(
      `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ws-inject-1', '/tmp/repo', 'main', '', NOW, NOW);
    db.prepare(
      `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
    ).run(GOAL_ID, 'ws-inject-1', NOW);

    // Seed a running session linked to the step run
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, started_at, workflow_step_run_id) VALUES (?, ?, 'ws-inject-1', 'claude-code', 'S', 'running', ?, ?, ?)"
    ).run(sessionId, GOAL_ID, NOW, NOW, STEP_RUN_ID);

    return { sessionId, writeSpy };
  }

  it("injects answer into the running PTY session when sessionRuntime is provided", async () => {
    const { db } = setup();

    const { sessionId, writeSpy } = setupWithSession(db);

    let nextId = 0;
    const app2 = fastify({ logger: false });
    openApps.push(app2);

    registerWorkflowStepRoutes(app2, {
      db,
      now: () => NOW,
      idFactory: () => `artifact-${++nextId}`,
      sessionRuntime: {
        getHandle: (id: string) => (id === sessionId ? { write: writeSpy } : undefined),
      },
    });

    const response = await app2.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: QUESTION_DECISION_ID,
        answerText: "us-west-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(writeSpy).toHaveBeenCalledWith(Buffer.from("us-west-2\n", "utf8"));
  });

  it("does not throw when sessionRuntime is absent", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-no-runtime-"));
    tempDirs.push(dir);
    const db2 = openDatabase({ ...createConfig(dir) });
    runMigrations(db2, defaultMigrationsDir());

    // Minimal seeding (no session)
    db2.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
    ).run(GOAL_ID, NOW, NOW);
    db2.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('tmpl-1', 'T', 'd', 1, 1, 1, '[]', '[]', ?, ?)"
    ).run(NOW, NOW);
    db2.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'tmpl-1', 1, 'active', ?, NULL, ?, NULL)"
    ).run(RUN_ID, GOAL_ID, STEP_RUN_ID, NOW);
    db2.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
    ).run(STEP_RUN_ID, GOAL_ID, RUN_ID, NOW);
    db2.transaction(() => {
      recordDecisionInTx(
        db2,
        () => NOW,
        {
          goalId: GOAL_ID,
          workflowRunId: RUN_ID,
          stepRunId: STEP_RUN_ID,
          decisionType: "request_user_input",
          selectedAction: "request_input:intake",
          reason: "Region?",
          influencedBy: [],
          inputFingerprint: "fp-q-no-rt",
        },
        { idFactory: () => QUESTION_DECISION_ID }
      );
    })();

    let nextId = 0;
    const app3 = fastify({ logger: false });
    openApps.push(app3);
    registerWorkflowStepRoutes(app3, {
      db: db2,
      now: () => NOW,
      idFactory: () => `a-${++nextId}`,
      // sessionRuntime intentionally omitted
    });

    const response = await app3.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-step-runs/${STEP_RUN_ID}/submit-input`,
      payload: {
        stepRunId: STEP_RUN_ID,
        questionDecisionId: QUESTION_DECISION_ID,
        answerText: "us-west-2",
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
