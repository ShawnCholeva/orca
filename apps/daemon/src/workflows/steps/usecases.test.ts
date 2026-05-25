import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { getWorkflowRunById } from "../runs/projection.js";
import {
  markWorkflowRunBlocked,
  resumeWorkflowRun,
  startWorkflowRun,
  type WorkflowRunUsecaseCtx,
} from "../runs/usecases.js";
import {
  ENGINEERING_ID,
  seedEngineeringTemplate,
} from "../templates/seed-engineering.js";
import {
  advanceToNextStep,
  failStep,
  markStepBlocked,
  recordExitCriteriaSatisfaction,
  retryStep,
  stepFingerprint,
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

function getStep(db: Database.Database, id: string) {
  return db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, started_at, finished_at, blocked_reason, fingerprint FROM workflow_step_runs WHERE id = ?"
    )
    .get(id) as
    | {
        id: string;
        goal_id: string;
        workflow_run_id: string;
        step_template_id: string;
        ordinal: number;
        attempt: number;
        status: string;
        satisfied_exit_criteria_json: string;
        outstanding_exit_criteria_json: string;
        started_at: string | null;
        finished_at: string | null;
        blocked_reason: string | null;
        fingerprint: string;
      }
    | undefined;
}

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  runCtx: WorkflowRunUsecaseCtx;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-steps-"));
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
    runCtx: {
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow step usecases", () => {
  it("advances through all eight Engineering steps and completes the run", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    expect(run.currentStepRunId).toBeTruthy();

    let currentRun = run;
    while (currentRun.currentStepRunId) {
      const step = getStep(db, currentRun.currentStepRunId);
      expect(step).toBeTruthy();
      const outstanding = JSON.parse(step!.outstanding_exit_criteria_json) as string[];
      recordExitCriteriaSatisfaction(db, () => NOW, step!.id, outstanding);
      const next = advanceToNextStep(db, () => NOW, step!.id);
      currentRun = getWorkflowRunById(db, run.id)!;
      if (next === null) break;
    }

    const completedRun = getWorkflowRunById(db, run.id);
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.currentStepRunId).toBeNull();
    expect(completedRun?.finishedAt).toBe(NOW);
    const goalRow = db
      .prepare("SELECT active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { active_workflow_run_id: string | null };
    expect(goalRow.active_workflow_run_id).toBeNull();

    const stepCount = db
      .prepare("SELECT COUNT(*) as count FROM workflow_step_runs WHERE workflow_run_id = ?")
      .get(run.id) as { count: number };
    expect(stepCount.count).toBe(8);

    const eventTypes = db
      .prepare("SELECT type FROM events ORDER BY seq ASC")
      .all() as Array<{ type: string }>;
    expect(eventTypes.filter((event) => event.type === "workflow.step.started")).toHaveLength(8);
    expect(eventTypes.filter((event) => event.type === "workflow.step.completed")).toHaveLength(
      8
    );
    expect(eventTypes.at(-1)?.type).toBe("workflow.run.completed");
  });

  it("blocked + resume reuses the current step without incrementing attempt", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const initialStepId = run.currentStepRunId!;
    const initialStep = getStep(db, initialStepId)!;
    expect(initialStep.attempt).toBe(1);

    markStepBlocked(db, () => NOW, initialStepId, "Need <secret> detail");
    markWorkflowRunBlocked(runCtx, run.id, "waiting for operator");
    const resumed = resumeWorkflowRun(runCtx, run.id);
    expect(resumed.status).toBe("active");
    expect(resumed.currentStepRunId).toBe(initialStepId);

    const stepAfterResume = getStep(db, initialStepId)!;
    expect(stepAfterResume.attempt).toBe(1);
    expect(stepAfterResume.status).toBe("blocked");
    expect(stepAfterResume.blocked_reason).toBe("Need <secret> detail");
  });

  it("fail + retry creates attempt 2 with a new fingerprint", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const stepId = run.currentStepRunId!;
    const attempt1 = getStep(db, stepId)!;

    const failed = failStep(db, () => NOW, stepId);
    expect(failed.status).toBe("failed");

    const retried = retryStep(db, () => NOW, stepId);
    expect(retried.attempt).toBe(2);
    expect(retried.stepTemplateId).toBe(attempt1.step_template_id);
    expect(retried.workflowRunId).toBe(run.id);

    const retryRow = getStep(db, retried.id)!;
    expect(retryRow.fingerprint).toBe(stepFingerprint(run.id, attempt1.step_template_id, 2));
    expect(retryRow.fingerprint).not.toBe(attempt1.fingerprint);
    expect(
      db
        .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = ?")
        .get(run.id) as { current_step_run_id: string | null }
    ).toEqual({ current_step_run_id: retried.id });
  });

  it("step fingerprint uses sha256(run:step:attempt)", () => {
    const actual = stepFingerprint("run-1", "intake", 2);
    const expected = createHash("sha256").update("run-1:intake:2").digest("hex");
    expect(actual).toBe(expected);
  });
});
