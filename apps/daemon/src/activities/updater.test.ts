import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listActivitiesByGoal } from "./projection.js";
import { getLiveForStepRun } from "./store.js";
import type { ActivityStoreCtx } from "./store.js";
import { ActivityUpdater } from "./updater.js";

describe("ActivityUpdater", () => {
  let db: Database.Database;
  let nowMs: number;
  let events: Array<{ type: string }>;
  let ctx: ActivityStoreCtx;
  let updater: ActivityUpdater;

  const base = {
    goalId: "g1",
    workflowRunId: "r1",
    stepRunId: "s1",
    agentSessionId: "sess1"
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-05', '2026-06-05', null)`
    ).run();

    nowMs = Date.parse("2026-06-05T00:00:00.000Z");
    events = [];
    const bus = new EventBus();
    bus.subscribe((event) => events.push(event));
    let nextId = 0;
    ctx = {
      db,
      bus,
      now: () => new Date(nowMs).toISOString(),
      idFactory: () => `activity-${++nextId}`
    };
    updater = new ActivityUpdater(() => nowMs);
  });

  afterEach(() => {
    db.close();
  });

  it("opens a live bubble naming the started step", () => {
    updater.apply(ctx, {
      kind: "step_started",
      ...base,
      stepName: "Implement updater"
    });

    expect(listActivitiesByGoal(db, "g1")).toMatchObject([
      {
        status: "active",
        currentText: "Watching the step agent start Implement updater…",
        sourceKind: "step_started",
        workCategory: null
      }
    ]);
  });

  it("coalesces same-category tool signals inside the throttle window", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });

    nowMs += 100;
    updater.apply(ctx, { kind: "tool_use", ...base, category: "reading", detail: "Read file.ts", diff: null, toolUseId: null });
    nowMs += 1_000;
    updater.apply(ctx, { kind: "tool_use", ...base, category: "reading", detail: "Read file.ts", diff: null, toolUseId: null });
    nowMs += 1_000;
    updater.apply(ctx, { kind: "tool_use", ...base, category: "reading", detail: "Read file.ts", diff: null, toolUseId: null });

    const activities = listActivitiesByGoal(db, "g1");
    expect(activities.filter((activity) => activity.workCategory === "reading")).toHaveLength(1);
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(2);
  });

  it("updates immediately when the tool category changes", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });
    nowMs += 100;
    updater.apply(ctx, { kind: "tool_use", ...base, category: "reading", detail: "Read file.ts", diff: null, toolUseId: null });
    nowMs += 100;
    updater.apply(ctx, { kind: "tool_use", ...base, category: "editing", detail: "Edited store.ts", diff: null, toolUseId: null });

    expect(listActivitiesByGoal(db, "g1")).toMatchObject([
      {
        currentText: "Edited store.ts",
        sourceKind: "tool_use",
        workCategory: "editing"
      }
    ]);
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(3);
  });

  it("reassures after weak-signal silence then expires an empty completion", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });

    nowMs += 9_999;
    updater.apply(ctx, { kind: "weak_signal_tick", ...base });
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(1);

    nowMs += 2;
    updater.apply(ctx, { kind: "weak_signal_tick", ...base });
    expect(listActivitiesByGoal(db, "g1")).toMatchObject([
      {
        status: "active",
        currentText: "Still working on the step; no new output yet.",
        sourceKind: "weak_signal",
        workCategory: null
      }
    ]);

    updater.apply(ctx, {
      kind: "turn_completed",
      stepRunId: "s1",
      summary: "   ",
      confidence: null
    });

    const activities = listActivitiesByGoal(db, "g1");
    expect(activities).toMatchObject([
      {
        status: "expired",
        finalSummary: null
      }
    ]);
    expect(
      activities.filter(
        (activity) => activity.status === "completed" && activity.finalSummary !== null
      )
    ).toHaveLength(0);
  });

  it("ignores a stale weak-signal tick after the turn completes", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });
    updater.apply(ctx, {
      kind: "turn_completed",
      stepRunId: "s1",
      summary: "Finished.",
      confidence: "high"
    });
    const activitiesBefore = listActivitiesByGoal(db, "g1");
    const eventCountBefore = events.filter(
      (event) => event.type === "activity.changed"
    ).length;

    nowMs += 10_001;
    updater.apply(ctx, { kind: "weak_signal_tick", ...base });

    const activitiesAfter = listActivitiesByGoal(db, "g1");
    expect(activitiesAfter).toEqual(activitiesBefore);
    expect(activitiesAfter.some((activity) => activity.status === "active")).toBe(false);
    expect(events.filter((event) => event.type === "activity.changed")).toHaveLength(
      eventCountBefore
    );
  });

  it("persists exactly one completed final summary", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });
    updater.apply(ctx, {
      kind: "turn_completed",
      stepRunId: "s1",
      summary: "  Implemented paced narration.  ",
      confidence: "high"
    });

    const completed = listActivitiesByGoal(db, "g1").filter(
      (activity) => activity.status === "completed"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.finalSummary).toBe("Implemented paced narration.");
  });

  it("preserves null confidence on a completed summary", () => {
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });
    updater.apply(ctx, {
      kind: "turn_completed",
      stepRunId: "s1",
      summary: "Completed without a confidence signal.",
      confidence: null
    });

    expect(listActivitiesByGoal(db, "g1")).toMatchObject([
      {
        status: "completed",
        finalSummary: "Completed without a confidence signal.",
        confidence: null
      }
    ]);
  });

  it("pauses with the embedded pending question", () => {
    const pendingQuestion = {
      questionId: "q1",
      toolUseId: "tool-1",
      questions: [
        {
          header: "Approach",
          question: "Which approach?",
          multiSelect: false,
          options: [{ label: "A", description: "Use A" }]
        }
      ]
    };
    updater.apply(ctx, { kind: "step_started", ...base, stepName: null });

    updater.apply(ctx, {
      kind: "question_pending",
      stepRunId: "s1",
      text: "I need your decision.",
      pendingQuestion
    });

    expect(listActivitiesByGoal(db, "g1")).toMatchObject([
      {
        status: "paused_for_input",
        currentText: "I need your decision.",
        sourceKind: "question_pending",
        pendingQuestion
      }
    ]);
  });
});

function ctx() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, step_run_id TEXT,
      agent_session_id TEXT, turn_ordinal INTEGER, status TEXT, current_text TEXT,
      final_summary TEXT, source_kind TEXT, work_category TEXT, confidence TEXT,
      pending_question TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
    CREATE TABLE activity_steps (
      id TEXT PRIMARY KEY, activity_id TEXT, ordinal INTEGER, text TEXT,
      category TEXT, status TEXT, diff TEXT, tool_use_id TEXT, created_at TEXT);
  `);
  let n = 0;
  return { db, bus: { publish() {} } as unknown as EventBus, now: () => "2026-06-16T00:00:00.000Z", idFactory: () => `id-${n++}` };
}
const sig = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null };

describe("ActivityUpdater steps", () => {
  it("step_started opens an activity with no persisted steps", () => {
    const c = ctx();
    new ActivityUpdater().apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    expect(getLiveForStepRun(c.db, "s1")!.steps).toEqual([]);
  });

  it("tool_use appends a persisted step with detail + diff", () => {
    const c = ctx();
    const u = new ActivityUpdater();
    u.apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    u.apply(c, { kind: "tool_use", ...sig, category: "reading", detail: "Read verifier.ts", diff: null, toolUseId: null });
    const live = getLiveForStepRun(c.db, "s1")!;
    expect(live.steps.map((s) => s.text)).toEqual(["Read verifier.ts"]);
    expect(live.steps[0].status).toBe("active");
  });

  it("weak_signal appends no step", () => {
    const c = ctx();
    const u = new ActivityUpdater();
    u.apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    u.apply(c, { kind: "weak_signal_tick", ...sig });
    expect(getLiveForStepRun(c.db, "s1")!.steps).toEqual([]);
  });

  it("does not surface reasoning notes as activity steps (raw worker prose is suppressed)", () => {
    const c = ctx();
    const u = new ActivityUpdater();
    u.apply(c, { kind: "step_started", ...sig, stepName: "Root Cause" });
    u.apply(c, {
      kind: "reasoning_note",
      ...sig,
      text: "I'll compare an app-wide table against per-goal storage",
    });
    expect(getLiveForStepRun(c.db, "s1")!.steps).toEqual([]);
  });
});
