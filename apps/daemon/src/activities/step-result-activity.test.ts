import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import type { ActivityStoreCtx } from "./store.js";
import {
  materializeStepResultActivity,
  reconcileStepResultActivities
} from "./step-result-activity.js";

function makeCtx(db: Database.Database) {
  const events: Array<{ type: string }> = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  let n = 0;
  const ctx: ActivityStoreCtx = {
    db,
    bus,
    now: () => "2026-06-09T00:00:00.000Z",
    idFactory: () => `activity-${++n}`
  };
  return { ctx, events };
}

function seedTerminalStepRun(
  db: Database.Database,
  input: {
    stepRunId: string;
    goalId: string;
    workflowRunId: string;
    stepName: string;
  }
): void {
  db.prepare(
    `INSERT INTO goals (
       id, title, intent, status, autonomy_level, created_at, updated_at, archived_at
     ) VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(input.goalId, "2026-06-09", "2026-06-09");
  db.prepare(
    `INSERT INTO workflow_templates (
       id, name, description, version, is_built_in, is_locked, steps_json,
       guardrails_json, created_at, updated_at
     ) VALUES (?, 'Test', '', 1, 0, 0, ?, '[]', ?, ?)`
  ).run(
    `template-${input.workflowRunId}`,
    JSON.stringify([{ id: "step-template", name: input.stepName }]),
    "2026-06-09",
    "2026-06-09"
  );
  db.prepare(
    `INSERT INTO workflow_runs (
       id, goal_id, template_id, template_version, status, current_step_run_id,
       blocked_reason, started_at, finished_at
     ) VALUES (?, ?, ?, 1, 'completed', ?, NULL, ?, ?)`
  ).run(
    input.workflowRunId,
    input.goalId,
    `template-${input.workflowRunId}`,
    input.stepRunId,
    "2026-06-09",
    "2026-06-09"
  );
  db.prepare(
    `INSERT INTO workflow_step_runs (
       id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason,
       started_at, finished_at, fingerprint, step_result_json
     ) VALUES (?, ?, ?, 'step-template', 0, 1, 'passed', '[]', '[]', NULL, ?, ?, ?, ?)`
  ).run(
    input.stepRunId,
    input.goalId,
    input.workflowRunId,
    "2026-06-09",
    "2026-06-09",
    `fingerprint-${input.stepRunId}`,
    JSON.stringify({ stepId: input.stepRunId })
  );
}

function seedActivity(
  db: Database.Database,
  input: {
    id: string;
    stepRunId: string;
    goalId: string;
    workflowRunId: string;
    turnOrdinal: number;
    status: string;
    substepStatus: string;
  }
): void {
  db.prepare(
    `INSERT INTO activities (
       id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
       status, current_text, final_summary, source_kind, work_category, confidence,
       pending_question, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'Working on the step...', NULL, 'tool_use', 'other', NULL, NULL, ?, ?, NULL)`
  ).run(
    input.id,
    input.goalId,
    input.workflowRunId,
    input.stepRunId,
    input.turnOrdinal,
    input.status,
    "2026-06-09",
    "2026-06-09"
  );
  db.prepare(
    `INSERT INTO activity_steps (id, activity_id, ordinal, text, category, status, diff, created_at)
     VALUES (?, ?, 0, 'Working on the step...', 'other', ?, NULL, ?)`
  ).run(`${input.id}-st`, input.id, input.substepStatus, "2026-06-09");
}

describe("step result activities", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  afterEach(() => {
    db.close();
  });

  it("creates exactly one step_result activity for a terminal step run", () => {
    const { ctx, events } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s1",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Investigate"
    });

    materializeStepResultActivity(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1"
    });
    materializeStepResultActivity(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1"
    });

    const rows = db
      .prepare(
        "SELECT * FROM activities WHERE step_run_id = 's1' AND source_kind = 'step_result'"
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(1);
  });

  it("reconciliation backfills terminal rows missing a result activity", () => {
    const { ctx } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s2",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Plan"
    });

    reconcileStepResultActivities(ctx);

    const rows = db
      .prepare(
        "SELECT * FROM activities WHERE step_run_id = 's2' AND source_kind = 'step_result'"
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("sweeps a dangling active worker activity when materializing the step result", () => {
    const { ctx, events } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s1",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Investigate"
    });
    seedActivity(db, {
      id: "a-stale",
      stepRunId: "s1",
      goalId: "g1",
      workflowRunId: "r1",
      turnOrdinal: 0,
      status: "active",
      substepStatus: "active"
    });

    materializeStepResultActivity(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1"
    });

    const stale = db
      .prepare("SELECT status FROM activities WHERE id = 'a-stale'")
      .get() as { status: string };
    expect(stale.status).toBe("expired");
    const substep = db
      .prepare("SELECT status FROM activity_steps WHERE activity_id = 'a-stale'")
      .get() as { status: string };
    expect(substep.status).toBe("done");
    const result = db
      .prepare(
        "SELECT status FROM activities WHERE step_run_id = 's1' AND source_kind = 'step_result'"
      )
      .get() as { status: string };
    expect(result.status).toBe("completed");
    // One activity.changed for the sweep + one for the new step_result activity.
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(2);
  });

  it("does not modify a completed activity that has an active substep (interrupt glyph)", () => {
    const { ctx } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s3",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Build"
    });
    seedActivity(db, {
      id: "a-int",
      stepRunId: "s3",
      goalId: "g1",
      workflowRunId: "r1",
      turnOrdinal: 0,
      status: "completed",
      substepStatus: "active"
    });

    materializeStepResultActivity(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s3"
    });

    const row = db
      .prepare("SELECT status FROM activities WHERE id = 'a-int'")
      .get() as { status: string };
    expect(row.status).toBe("completed");
    const substep = db
      .prepare("SELECT status FROM activity_steps WHERE activity_id = 'a-int'")
      .get() as { status: string };
    expect(substep.status).toBe("active");
  });

  it("does not touch active activities belonging to a different step run", () => {
    const { ctx } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s1",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Investigate"
    });
    seedActivity(db, {
      id: "a-other",
      stepRunId: "s-other",
      goalId: "g1",
      workflowRunId: "r1",
      turnOrdinal: 0,
      status: "active",
      substepStatus: "active"
    });

    materializeStepResultActivity(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1"
    });

    const row = db
      .prepare("SELECT status FROM activities WHERE id = 'a-other'")
      .get() as { status: string };
    expect(row.status).toBe("active");
    const substep = db
      .prepare("SELECT status FROM activity_steps WHERE activity_id = 'a-other'")
      .get() as { status: string };
    expect(substep.status).toBe("active");
  });

  it("self-heals stuck active activities on boot via reconciliation", () => {
    const { ctx } = makeCtx(db);
    seedTerminalStepRun(db, {
      stepRunId: "s2",
      goalId: "g1",
      workflowRunId: "r1",
      stepName: "Plan"
    });
    seedActivity(db, {
      id: "a-stuck",
      stepRunId: "s2",
      goalId: "g1",
      workflowRunId: "r1",
      turnOrdinal: 0,
      status: "active",
      substepStatus: "active"
    });

    reconcileStepResultActivities(ctx);

    const stuck = db
      .prepare("SELECT status FROM activities WHERE id = 'a-stuck'")
      .get() as { status: string };
    expect(stuck.status).toBe("expired");
    const substep = db
      .prepare("SELECT status FROM activity_steps WHERE activity_id = 'a-stuck'")
      .get() as { status: string };
    expect(substep.status).toBe("done");
    const result = db
      .prepare(
        "SELECT status FROM activities WHERE step_run_id = 's2' AND source_kind = 'step_result'"
      )
      .get() as { status: string };
    expect(result.status).toBe("completed");
  });
});
