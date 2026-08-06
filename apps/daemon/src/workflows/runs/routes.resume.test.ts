import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { WorkflowRunResponse } from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements } from "./projection.js";
import { markStepBlocked } from "../steps/usecases.js";
import {
  markWorkflowRunBlocked,
  pauseWorkflowRun,
  startWorkflowRun,
  type WorkflowRunUsecaseCtx,
} from "./usecases.js";
import { registerWorkflowRunRoutes } from "./routes.js";

const tempDirs: string[] = [];
const NOW = "2026-07-29T00:00:00.000Z";

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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database, id: string, version: number): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)"
  ).run(
    id,
    "Engineering",
    "desc",
    version,
    JSON.stringify([
      {
        id: "intake",
        ordinal: 0,
        name: "Intake",
        instructions: "Collect user input and capture a goal brief.",
        outputSchema: [{ key: "goal_brief", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

function setup(): { db: Database.Database; ctx: WorkflowRunUsecaseCtx } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-runs-resume-route-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const bus = new EventBus();
  let nextId = 0;
  return {
    db,
    ctx: { db, bus, now: () => NOW, idFactory: () => `fixed-id-${++nextId}` },
  };
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetRunProjectionPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /v1/goals/:goalId/workflow-runs/:id/resume", () => {
  it("invokes the resume hook with the NEW step-run id, not the terminal one", async () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });
    const terminalStepRunId = run.currentStepRunId!;

    // A run blocked at the rescue cap: its current step run is terminal (blocked),
    // and the run itself is blocked — the exact scenario the cap path leaves behind.
    markStepBlocked(db, () => NOW, terminalStepRunId, "no progress after 3 restarts");
    markWorkflowRunBlocked(ctx, run.id, "no progress after 3 restarts");

    const calls: Array<{ goalId: string; runId: string; stepRunId: string }> = [];
    const app: FastifyInstance = Fastify();
    registerWorkflowRunRoutes(app, {
      db,
      bus: ctx.bus,
      now: () => NOW,
      idFactory: ctx.idFactory,
      onResumed: async (args) => {
        calls.push(args);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/${run.id}/resume`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const parsed = WorkflowRunResponse.parse(JSON.parse(response.body));
    const newStepRunId = parsed.run.currentStepRunId;
    expect(newStepRunId).toBeTruthy();
    expect(newStepRunId).not.toBe(terminalStepRunId);

    expect(calls).toEqual([
      { goalId: "goal-1", runId: run.id, stepRunId: newStepRunId },
    ]);
  });

  it("does not invoke the resume hook when resume fails, but does when a later resume succeeds", async () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    // A freshly-started run is 'active' — resume is only valid from paused/blocked,
    // so this must hit the existing 409 path and never reach the hook.
    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });

    const calls: Array<{ goalId: string; runId: string; stepRunId: string }> = [];
    const app: FastifyInstance = Fastify();
    registerWorkflowRunRoutes(app, {
      db,
      bus: ctx.bus,
      now: () => NOW,
      idFactory: ctx.idFactory,
      onResumed: async (args) => {
        calls.push(args);
      },
    });

    const invalidResp = await app.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/${run.id}/resume`,
    });
    expect(invalidResp.statusCode).toBe(409);
    expect(calls).toEqual([]);

    // Now make the run resumable and try again — the hook should fire this time,
    // proving the assertion above is actually exercising the hook wiring rather
    // than trivially never calling it.
    pauseWorkflowRun(ctx, run.id);
    const validResp = await app.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/${run.id}/resume`,
    });
    await app.close();

    expect(validResp.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ goalId: "goal-1", runId: run.id });
  });

  it("still returns the run payload when no onResumed dep is configured", async () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });
    const terminalStepRunId = run.currentStepRunId!;
    markStepBlocked(db, () => NOW, terminalStepRunId, "no progress after 3 restarts");
    markWorkflowRunBlocked(ctx, run.id, "no progress after 3 restarts");

    const app: FastifyInstance = Fastify();
    registerWorkflowRunRoutes(app, {
      db,
      bus: ctx.bus,
      now: () => NOW,
      idFactory: ctx.idFactory,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/${run.id}/resume`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const parsed = WorkflowRunResponse.parse(JSON.parse(response.body));
    expect(parsed.run.status).toBe("active");
    expect(parsed.run.currentStepRunId).not.toBe(terminalStepRunId);
  });
});
