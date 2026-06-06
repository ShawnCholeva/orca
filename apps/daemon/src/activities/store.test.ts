import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import {
  completeLive,
  expireLive,
  getLiveForStepRun,
  getPausedForGoal,
  openOrUpdateLive,
  pauseForInput,
  type ActivityStoreCtx
} from "./store.js";

function ctxFor(db: Database.Database) {
  const events: Array<{ type: string }> = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  let n = 0;
  const ctx: ActivityStoreCtx = {
    db,
    bus,
    now: () => "2026-06-05T00:00:00.000Z",
    idFactory: () => `id-${++n}`
  };
  return { ctx, events };
}

function seedGoal(db: Database.Database) {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES ('g1', 't', '', 'active', 1, '2026-06-05', '2026-06-05', null)`
  ).run();
}

describe("ActivityStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    seedGoal(db);
  });

  afterEach(() => {
    db.close();
  });

  const base = {
    goalId: "g1",
    workflowRunId: "r1",
    stepRunId: "s1",
    agentSessionId: "sess1"
  };

  it("opens a live row then updates it in place (one live per step)", () => {
    const { ctx, events } = ctxFor(db);
    const a = openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });
    const b = openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "tool_use",
      currentText: "Reading...",
      workCategory: "reading"
    });

    expect(b.id).toBe(a.id);
    expect(b.currentText).toBe("Reading...");
    expect(b.turnOrdinal).toBe(0);
    expect(events.filter((event) => event.type === "activity.changed").length).toBe(2);
  });

  it("opens a new turn after the prior one completes", () => {
    const { ctx } = ctxFor(db);
    const a = openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });

    completeLive(ctx, {
      stepRunId: "s1",
      finalSummary: "Done.",
      confidence: "high"
    });
    const b = openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "tool_use",
      currentText: "Reading...",
      workCategory: "reading"
    });

    expect(b.id).not.toBe(a.id);
    expect(b.turnOrdinal).toBe(1);
    expect(getLiveForStepRun(db, "s1")?.id).toBe(b.id);
  });

  it("pauses with an embedded question and resolves it via getPausedForGoal", () => {
    const { ctx } = ctxFor(db);
    const pendingQuestion = {
      questionId: "q1",
      toolUseId: "t1",
      questions: [
        {
          header: "Signals",
          question: "Which?",
          multiSelect: true,
          options: [{ label: "A", description: "x" }]
        }
      ]
    };

    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });
    pauseForInput(ctx, {
      stepRunId: "s1",
      currentText: "I need your call.",
      pendingQuestion
    });

    const paused = getPausedForGoal(db, "g1");
    expect(paused?.pendingQuestion).toEqual(pendingQuestion);
    expect(paused?.status).toBe("paused_for_input");
  });

  it("throws when stored pending_question is malformed", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });
    pauseForInput(ctx, {
      stepRunId: "s1",
      currentText: "I need your call.",
      pendingQuestion: {
        questionId: "q1",
        toolUseId: "t1",
        questions: [
          {
            header: "Signals",
            question: "Which?",
            multiSelect: true,
            options: [{ label: "A", description: "x" }]
          }
        ]
      }
    });
    db.prepare("UPDATE activities SET pending_question = ? WHERE step_run_id = ?").run("", "s1");

    expect(() => getPausedForGoal(db, "g1")).toThrow();
  });

  it("expireLive clears the live row without a durable summary", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "weak_signal",
      currentText: "Still working...",
      workCategory: null
    });

    expireLive(ctx, { stepRunId: "s1" });

    const expired = db.prepare("SELECT final_summary FROM activities WHERE step_run_id = ?").get(
      "s1"
    ) as { final_summary: string | null };
    expect(getLiveForStepRun(db, "s1")).toBeUndefined();
    expect(expired.final_summary).toBeNull();
  });

  it("expireLive leaves paused questions unchanged", () => {
    const { ctx, events } = ctxFor(db);
    const pendingQuestion = {
      questionId: "q1",
      toolUseId: "t1",
      questions: [
        {
          header: "Signals",
          question: "Which?",
          multiSelect: true,
          options: [{ label: "A", description: "x" }]
        }
      ]
    };

    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });
    pauseForInput(ctx, {
      stepRunId: "s1",
      currentText: "I need your call.",
      pendingQuestion
    });
    const eventCount = events.filter((event) => event.type === "activity.changed").length;

    expireLive(ctx, { stepRunId: "s1" });

    const paused = getPausedForGoal(db, "g1");
    expect(paused?.status).toBe("paused_for_input");
    expect(paused?.pendingQuestion).toEqual(pendingQuestion);
    expect(events.filter((event) => event.type === "activity.changed").length).toBe(eventCount);
  });
});
