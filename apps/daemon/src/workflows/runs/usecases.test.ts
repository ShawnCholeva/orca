import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements } from "./projection.js";
import {
  ActiveWorkflowRunExistsError,
  cancelWorkflowRun,
  completeWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
  WorkflowRunInvalidTransitionError,
  type WorkflowRunUsecaseCtx,
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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
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

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  ctx: WorkflowRunUsecaseCtx;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-runs-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event);
  });
  let nextId = 0;
  return {
    db,
    events,
    ctx: {
      db,
      bus,
      now: () => NOW,
      idFactory: () => `fixed-id-${++nextId}`,
    },
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

describe("workflow run usecases", () => {
  it("allows only one active/paused/blocked run per goal", () => {
    const { db, events, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 7);

    const run = startWorkflowRun(ctx, {
      goalId: "goal-1",
      templateId: "orca/engineering",
    });

    expect(run.status).toBe("active");
    expect(run.templateVersion).toBe(7);
    const linkedGoal = db
      .prepare("SELECT active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { active_workflow_run_id: string | null };
    expect(linkedGoal.active_workflow_run_id).toBe(run.id);
    expect(run.currentStepRunId).toBeTruthy();

    expect(() =>
      startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" })
    ).toThrow(ActiveWorkflowRunExistsError);

    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.step.started",
    ]);
    const persistedEvents = db
      .prepare("SELECT type FROM events ORDER BY seq ASC")
      .all() as Array<{ type: string }>;
    expect(persistedEvents.map((row) => row.type)).toEqual([
      "workflow.run.started",
      "workflow.step.started",
    ]);
  });

  it("supports pause -> resume and emits lifecycle events", () => {
    const { events, ctx } = setup();
    seedGoal(ctx.db, "goal-1");
    seedTemplate(ctx.db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, {
      goalId: "goal-1",
      templateId: "orca/engineering",
    });

    const paused = pauseWorkflowRun(ctx, run.id);
    expect(paused.status).toBe("paused");
    const resumed = resumeWorkflowRun(ctx, run.id);
    expect(resumed.status).toBe("active");
    expect(resumed.blockedReason).toBeNull();

    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.step.started",
      "workflow.run.paused",
      "workflow.run.started",
    ]);
    expect(events[3]?.payload).toMatchObject({ workflowRunId: run.id, resumed: true });
  });

  it("cancel is terminal and clears active goal linkage", () => {
    const { db, events, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, {
      goalId: "goal-1",
      templateId: "orca/engineering",
    });
    const cancelled = cancelWorkflowRun(ctx, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBe(NOW);

    const linkedGoal = db
      .prepare("SELECT active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { active_workflow_run_id: string | null };
    expect(linkedGoal.active_workflow_run_id).toBeNull();

    expect(() => cancelWorkflowRun(ctx, run.id)).toThrow(WorkflowRunInvalidTransitionError);
    expect(() => completeWorkflowRun(ctx, run.id)).toThrow(WorkflowRunInvalidTransitionError);
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.step.started",
      "workflow.run.cancelled",
    ]);
  });
});
