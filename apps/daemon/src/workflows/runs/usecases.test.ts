import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus, eventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements } from "./projection.js";
import { markStepBlocked } from "../steps/usecases.js";
import { archiveGoal } from "../../goals.js";
import {
  ActiveWorkflowRunExistsError,
  cancelWorkflowRun,
  completeWorkflowRun,
  markWorkflowRunBlocked,
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

// Seed a goal + template + an active run parked on its first (active) step run.
function seedActiveRunOnStep(
  ctx: WorkflowRunUsecaseCtx,
  goalId = "goal-1",
  templateId = "orca/engineering"
): { goalId: string; runId: string; stepRunId: string } {
  seedGoal(ctx.db, goalId);
  seedTemplate(ctx.db, templateId, 1);
  const run = startWorkflowRun(ctx, { goalId, templateId });
  return { goalId, runId: run.id, stepRunId: run.currentStepRunId! };
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

  it("snapshots the template definition into the run at start", () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 7);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });

    const row = db
      .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
      .get(run.id) as { template_snapshot_json: string | null };
    expect(row.template_snapshot_json).not.toBeNull();
    const snap = JSON.parse(row.template_snapshot_json!);
    expect(snap.id).toBe("orca/engineering");
    expect(snap.version).toBe(7);
    expect(snap.steps[0].id).toBe("intake");
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

  it("resuming a blocked run starts a fresh attempt of the same step", () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });
    const stepRunId = run.currentStepRunId!;

    markStepBlocked(db, () => NOW, stepRunId, "no progress after 3 restarts");
    markWorkflowRunBlocked(ctx, run.id, "no progress after 3 restarts");

    const resumed = resumeWorkflowRun(ctx, run.id);
    expect(resumed.status).toBe("active");
    expect(resumed.currentStepRunId).not.toBe(stepRunId);

    const fresh = db
      .prepare("SELECT attempt, status, step_template_id FROM workflow_step_runs WHERE id = ?")
      .get(resumed.currentStepRunId) as { attempt: number; status: string; step_template_id: string };
    expect(fresh.status).toBe("active");
    expect(fresh.attempt).toBe(2);
    expect(fresh.step_template_id).toBe("intake");

    const old = db
      .prepare("SELECT status FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string };
    expect(old.status).toBe("blocked");
  });

  it("completing a run marks the goal completed", () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });
    completeWorkflowRun(ctx, run.id);

    const g = db
      .prepare("SELECT status, active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { status: string; active_workflow_run_id: string | null };
    expect(g.status).toBe("completed");
    expect(g.active_workflow_run_id).toBeNull();
  });

  it("completing a run does not un-archive an archived goal", () => {
    const { db, ctx } = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);

    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });

    // Archive the goal while the run is still active (active_workflow_run_id remains set)
    db.prepare(
      "UPDATE goals SET status = 'archived', archived_at = ? WHERE id = ?"
    ).run(NOW, "goal-1");

    completeWorkflowRun(ctx, run.id);

    const g = db
      .prepare("SELECT status, active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { status: string; active_workflow_run_id: string | null };
    expect(g.status).toBe("archived");
    expect(g.active_workflow_run_id).toBeNull();
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
      "workflow.step.blocked",
      "workflow.run.cancelled",
    ]);
  });

  it("cancelling a run closes the step that was in flight", () => {
    const { db, events, ctx } = setup();
    const { runId, stepRunId } = seedActiveRunOnStep(ctx);

    cancelWorkflowRun(ctx, runId);

    const stepRun = db
      .prepare("SELECT status, finished_at, blocked_reason FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string; finished_at: string | null; blocked_reason: string | null };
    expect(stepRun.status).toBe("blocked");
    expect(stepRun.finished_at).not.toBeNull();
    expect(stepRun.blocked_reason).toBe("run_cancelled");

    // Not just persisted — must actually reach the bus, alongside workflow.run.cancelled.
    const blockedEvent = events.find((event) => event.type === "workflow.step.blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.payload).toMatchObject({ stepRunId });
  });

  it("cancelling leaves already-finished step runs untouched", () => {
    const { db, ctx } = setup();
    const { runId, stepRunId } = seedActiveRunOnStep(ctx);
    db.prepare("UPDATE workflow_step_runs SET status = 'passed', finished_at = ? WHERE id = ?")
      .run(NOW, stepRunId);

    cancelWorkflowRun(ctx, runId);

    const stepRun = db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string };
    expect(stepRun.status).toBe("passed");
  });

  it("archiving a goal closes the step that was in flight", () => {
    const { db, ctx } = setup();
    const { goalId, stepRunId } = seedActiveRunOnStep(ctx);

    // archiveGoal publishes on the module-level eventBus singleton, not ctx.bus.
    const published: DomainEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      published.push(event);
    });
    try {
      archiveGoal(goalId);
    } finally {
      unsubscribe();
    }

    const stepRun = db.prepare("SELECT status, blocked_reason FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string; blocked_reason: string | null };
    expect(stepRun.status).toBe("blocked");
    expect(stepRun.blocked_reason).toBe("goal_archived");

    // Not just persisted — must actually reach the bus, alongside goal.archived.
    const blockedEvent = published.find((event) => event.type === "workflow.step.blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.payload).toMatchObject({ stepRunId });
  });
});
