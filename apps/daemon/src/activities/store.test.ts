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
  pauseForConfirmation,
  pauseForInput,
  pauseForMarkDone,
  pauseForProviderRecovery,
  recordOrchestratorReasoning,
  resolveMarkDoneActivity,
  resumeFromConfirmation,
  resumeFromProviderRecovery,
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

  it("completes a live row with null confidence", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_started",
      currentText: "Watching...",
      workCategory: null
    });

    const completed = completeLive(ctx, {
      stepRunId: "s1",
      finalSummary: "Done.",
      confidence: null
    });

    const stored = db
      .prepare("SELECT status, confidence FROM activities WHERE step_run_id = ?")
      .get("s1") as { status: string; confidence: string | null };
    expect(completed?.status).toBe("completed");
    expect(completed?.confidence).toBeNull();
    expect(stored).toEqual({ status: "completed", confidence: null });
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

  it("pauses a live activity for confirmation", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    const paused = pauseForConfirmation(ctx, {
      stepRunId: "s1",
      summary: "Completeness 90% · Correctness 85% · Ready for handoff"
    });
    expect(paused?.status).toBe("paused_for_input");
    expect(paused?.sourceKind).toBe("step_confirmation_pending");
    expect(paused?.currentText).toContain("90%");
  });

  it("resumes a confirmation activity back to active", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    pauseForConfirmation(ctx, { stepRunId: "s1", summary: "x" });
    const resumed = resumeFromConfirmation(ctx, { stepRunId: "s1" });
    expect(resumed?.status).toBe("active");
    expect(resumed?.sourceKind).toBe("step_started");
  });

  it("pauses a live activity for provider recovery", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    const paused = pauseForProviderRecovery(ctx, {
      stepRunId: "s1",
      summary: "Claude Code is available again at 4:20am America/New_York.",
    });
    expect(paused?.sourceKind).toBe("provider_recovery_pending");
    expect(paused?.status).toBe("paused_for_input");
    expect(paused?.currentText).toContain("4:20am");
  });

  it("resumes a provider-recovery activity and rebinds the session", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    pauseForProviderRecovery(ctx, { stepRunId: "s1", summary: "waiting" });
    const resumed = resumeFromProviderRecovery(ctx, {
      stepRunId: "s1",
      agentSessionId: "sess2",
      summary: "Continuing with Codex…",
    });
    expect(resumed?.status).toBe("active");
    expect(resumed?.sourceKind).toBe("step_started");
    expect(resumed?.agentSessionId).toBe("sess2");
  });

  it("completeLive does not close a confirmation checkpoint", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    pauseForConfirmation(ctx, { stepRunId: "s1", summary: "score summary" });
    const result = completeLive(ctx, { stepRunId: "s1", finalSummary: "turn done", confidence: null });
    expect(result).toBeUndefined();
    const row = db.prepare("SELECT status, source_kind FROM activities WHERE step_run_id = 's1'").get() as { status: string; source_kind: string };
    expect(row.status).toBe("paused_for_input");
    expect(row.source_kind).toBe("step_confirmation_pending");
  });

  it("pauseForMarkDone persists a mark_done_pending row carrying the rec id", () => {
    const { ctx } = ctxFor(db);
    const a = pauseForMarkDone(ctx, {
      goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9",
    });
    expect(a.sourceKind).toBe("mark_done_pending");
    expect(a.status).toBe("paused_for_input");
    expect(a.recommendationId).toBe("rec-9");
    // idempotent re-park returns the same row
    const again = pauseForMarkDone(ctx, {
      goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9",
    });
    expect(again.id).toBe(a.id);
  });

  it("resolveMarkDoneActivity completes the parked mark-done row", () => {
    const { ctx } = ctxFor(db);
    pauseForMarkDone(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9" });
    const done = resolveMarkDoneActivity(ctx, { stepRunId: "s1" });
    expect(done?.status).toBe("completed");
    expect(getLiveForStepRun(db, "s1")).toBeUndefined();
  });

  it("records a completed orchestrator_reasoning activity attributed to the orch session", () => {
    const { ctx } = ctxFor(db);
    const a = recordOrchestratorReasoning(ctx, {
      goalId: "g1", workflowRunId: "r1", stepRunId: "s1", text: "routing because the spec exists",
    });
    expect(a?.sourceKind).toBe("orchestrator_reasoning");
    expect(a?.status).toBe("completed");
    expect(a?.agentSessionId).toBe("orchsess-g1");
    expect(a?.finalSummary).toBe("routing because the spec exists");
  });

  it("skips empty orchestrator reasoning", () => {
    const { ctx } = ctxFor(db);
    expect(recordOrchestratorReasoning(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", text: "  " })).toBeUndefined();
  });
});
