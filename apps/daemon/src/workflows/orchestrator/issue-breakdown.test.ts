import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import {
  DependencyTaskGoalMismatchError,
  DependencyTaskNotFoundError,
} from "../../tasks/usecases.js";
import { writeIssueBreakdown } from "./issue-breakdown.js";

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-issue-breakdown-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(id, NOW, NOW);
}

function seedWorkflow(db: Database.Database, goalId: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', ?, 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(goalId, NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', ?, 'run-1', 'issue-breakdown', 2, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
  ).run(goalId, NOW);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeIssueBreakdown", () => {
  it("writes generator tasks linked to workflow_step_run_id and emits workflow.task.dag.created", () => {
    const db = freshDb();
    seedGoal(db, "goal-1");
    seedWorkflow(db, "goal-1");

    const result = writeIssueBreakdown(db, () => NOW, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      tasks: [
        {
          title: "Implement endpoint",
          description: "Add API route and tests",
          acceptanceCriteria: ["Route returns 200"],
          validationSteps: ["pnpm --filter @orca/daemon test workflows"],
          role: "engineer",
          dependencies: [],
        },
        {
          title: "Review endpoint",
          description: "Review implementation",
          acceptanceCriteria: ["Review completed"],
          validationSteps: ["Manual review"],
          role: "reviewer",
          dependencies: [],
        },
      ],
    });

    expect(result.taskIds).toHaveLength(2);

    const tasks = db
      .prepare(
        "SELECT id, goal_id, origin, status, workflow_step_run_id FROM tasks WHERE id IN (?, ?) ORDER BY created_at ASC"
      )
      .all(result.taskIds[0], result.taskIds[1]) as Array<{
      id: string;
      goal_id: string;
      origin: string;
      status: string;
      workflow_step_run_id: string | null;
    }>;
    expect(tasks).toHaveLength(2);
    for (const row of tasks) {
      expect(row.goal_id).toBe("goal-1");
      expect(row.origin).toBe("generator");
      expect(row.status).toBe("proposed");
      expect(row.workflow_step_run_id).toBe("step-1");
    }

    const event = db
      .prepare(
        "SELECT type, payload FROM events WHERE type = 'workflow.task.dag.created' ORDER BY seq DESC LIMIT 1"
      )
      .get() as { type: string; payload: string } | undefined;
    expect(event?.type).toBe("workflow.task.dag.created");
    const payload = JSON.parse(event!.payload) as Record<string, unknown>;
    expect(payload.goalId).toBe("goal-1");
    expect(payload.workflowRunId).toBe("run-1");
    expect(payload.stepRunId).toBe("step-1");
    expect(payload.count).toBe(2);
    expect(Array.isArray(payload.taskIds)).toBe(true);
  });

  it("throws when dependency task is missing", () => {
    const db = freshDb();
    seedGoal(db, "goal-1");
    seedWorkflow(db, "goal-1");

    expect(() =>
      writeIssueBreakdown(db, () => NOW, {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        tasks: [
          {
            title: "Child task",
            description: "",
            acceptanceCriteria: [],
            validationSteps: [],
            role: "engineer",
            dependencies: ["missing-task"],
          },
        ],
      })
    ).toThrow(DependencyTaskNotFoundError);
  });

  it("throws when dependency task belongs to another goal", () => {
    const db = freshDb();
    seedGoal(db, "goal-1");
    seedGoal(db, "goal-2");
    seedWorkflow(db, "goal-1");
    db.prepare(
      "INSERT INTO tasks (id, goal_id, parent_task_id, workspace_id, role, status, origin, title, description, acceptance_criteria_json, validation_steps_json, dependencies_json, sources_json, generation_id, fingerprint, created_at, updated_at, archived_at, workflow_step_run_id) VALUES ('dep-1', 'goal-2', NULL, NULL, 'engineer', 'open', 'user', 'dep', '', '[]', '[]', '[]', '[]', NULL, 'fp-dep', ?, ?, NULL, NULL)"
    ).run(NOW, NOW);

    expect(() =>
      writeIssueBreakdown(db, () => NOW, {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        tasks: [
          {
            title: "Child task",
            description: "",
            acceptanceCriteria: [],
            validationSteps: [],
            role: "engineer",
            dependencies: ["dep-1"],
          },
        ],
      })
    ).toThrow(DependencyTaskGoalMismatchError);
  });
});
