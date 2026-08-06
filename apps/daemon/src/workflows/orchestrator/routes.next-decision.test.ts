import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { registerOrchestratorRoutes } from "./routes.js";
import {
  createConfig,
  fakeBroker,
  fakeRegistry,
  fakeStepDispatch,
  NOW,
  seedSkillWorkflow,
} from "./skill-step-test-helpers.js";

// These cover the fix for the "run parks with an operator selected and no
// worker" bug: requestNextDecision only *selects* the current step's operator
// (deliberately — its internal recursion must stay select-without-launch),
// so the /next-decision route must follow through and launch the worker
// itself for any client that hits it.

const GOAL_ID = "goal-1";
const RUN_ID = "run-1";
const STEP_RUN_ID = "step-1";

const tempDirs: string[] = [];
const openApps: Array<ReturnType<typeof fastify>> = [];

function seedWorkspace(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("ws-1", "/tmp/repo", "main", "", NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(GOAL_ID, "ws-1", NOW);
}

// A launcher that mimics the production ProductionWorkflowSessionLauncher
// closely enough for the double-launch guard (a query against `sessions`) to
// see a real row: it inserts a `sessions` row linked to the step run.
function makeRecordingLauncher(db: Database.Database) {
  let n = 0;
  const launch = vi.fn(async (ctx: { goalId: string; workflowStepRunId: string }) => {
    n += 1;
    const id = `sess-${n}`;
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, started_at, workflow_step_run_id) VALUES (?, ?, 'ws-1', 'claude-code', 'S', 'created', ?, ?, ?)"
    ).run(id, ctx.goalId, NOW, NOW, ctx.workflowStepRunId);
    return { sessionId: id };
  });
  return { launch };
}

function sessionRows(db: Database.Database): Array<{ id: string; workflow_step_run_id: string | null }> {
  return db
    .prepare("SELECT id, workflow_step_run_id FROM sessions")
    .all() as Array<{ id: string; workflow_step_run_id: string | null }>;
}

function setup(): { db: Database.Database; app: ReturnType<typeof fastify> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-next-decision-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedSkillWorkflow(db);
  seedWorkspace(db);
  return { db, app: fastify({ logger: false }) };
}

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

describe("POST /v1/goals/:goalId/workflow-runs/:id/next-decision — launch follow-through", () => {
  it("spawns a worker session for the freshly-started run's first step, not just a selection", async () => {
    const { db, app } = setup();
    openApps.push(app);
    const launcher = makeRecordingLauncher(db);

    registerOrchestratorRoutes(app, {
      db,
      bus: new EventBus(),
      orchestrationTransportBroker: fakeBroker({ action: "ask", question: "unused" }),
      operatorRegistry: fakeRegistry(),
      workflowSessionLauncher: launcher,
      stepDispatch: fakeStepDispatch(),
      now: () => NOW,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-runs/${RUN_ID}/next-decision`,
      payload: { workflowRunId: RUN_ID },
    });

    expect(response.statusCode).toBe(200);
    const rows = sessionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workflow_step_run_id).toBe(STEP_RUN_ID);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a second session when the route is called again for the same step", async () => {
    const { db, app } = setup();
    openApps.push(app);
    const launcher = makeRecordingLauncher(db);

    registerOrchestratorRoutes(app, {
      db,
      bus: new EventBus(),
      orchestrationTransportBroker: fakeBroker({ action: "ask", question: "unused" }),
      operatorRegistry: fakeRegistry(),
      workflowSessionLauncher: launcher,
      stepDispatch: fakeStepDispatch(),
      now: () => NOW,
    });

    const first = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-runs/${RUN_ID}/next-decision`,
      payload: { workflowRunId: RUN_ID },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-runs/${RUN_ID}/next-decision`,
      payload: { workflowRunId: RUN_ID },
    });
    expect(second.statusCode).toBe(200);

    expect(sessionRows(db)).toHaveLength(1);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it("returns the decision response (not a 500) when the follow-through launch throws", async () => {
    const { db, app } = setup();
    openApps.push(app);

    // isAdapterReady succeeds the first time (so requestNextDecision's own
    // selection resolves and the decision succeeds), then throws on the
    // second, independent resolution inside the follow-through launch —
    // exercising a failure path spawnStepAgent does not catch internally.
    let calls = 0;
    const explodingStepDispatch = {
      async isAdapterReady(adapterId: string) {
        calls += 1;
        if (calls > 1) throw new Error("adapter readiness check exploded");
        return adapterId === "claude-code";
      },
      supportsModel(adapterId: string, modelId: string) {
        return adapterId === "claude-code" && modelId === "claude-haiku-4-5";
      },
      resolveMode(adapterId: string) {
        return { adapterId, mode: "one_shot" as const, fallbacks: ["shadow_session" as const] };
      },
    };

    registerOrchestratorRoutes(app, {
      db,
      bus: new EventBus(),
      orchestrationTransportBroker: fakeBroker({ action: "ask", question: "unused" }),
      operatorRegistry: fakeRegistry(),
      workflowSessionLauncher: { launch: vi.fn(async () => ({ sessionId: "sess-x" })) },
      stepDispatch: explodingStepDispatch,
      now: () => NOW,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/${GOAL_ID}/workflow-runs/${RUN_ID}/next-decision`,
      payload: { workflowRunId: RUN_ID },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { decision: { decisionType: string } };
    expect(body.decision.decisionType).toBe("select_operator");
  });
});
