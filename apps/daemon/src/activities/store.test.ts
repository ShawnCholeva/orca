import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import {
  appendActivityStep,
  completeLive,
  expireLive,
  expireLiveForRun,
  expireLiveOnStoppedRuns,
  getLiveForStepRun,
  getPausedForGoal,
  openOrUpdateLive,
  pauseForConfirmation,
  pauseForInput,
  pauseForMarkDone,
  pauseForProviderRecovery,
  recordOrchestratorReasoning,
  resolveMarkDoneActivity,
  resolvePermissionPendingActivity,
  resumeFromConfirmation,
  resumeFromProviderRecovery,
  type ActivityStoreCtx
} from "./store.js";

function ctxFor(db: Database.Database) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
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
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
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

  it("carries sourceKind on the activity.changed payload", () => {
    // Subscribers need WHY the activity changed, not just that it did — the
    // difference between "Orca is waiting on you", which a user learns to ignore,
    // and "Orca needs your OK on a step", which they act on.
    const { ctx, events } = ctxFor(db);
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_confirmation_pending",
      currentText: "Waiting on you",
      workCategory: null
    });

    const changed = events.filter((e) => e.type === "activity.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].payload).toMatchObject({ sourceKind: "step_confirmation_pending" });
  });

  it("reports the sourceKind the activity had AT the event, not whatever the row says later", () => {
    // appendActivityStep overwrites source_kind to 'tool_use' on the mutable row,
    // so a subscriber that joined back to `activities` would read the wrong cause
    // for an earlier event. This is why it has to ride the append-only payload:
    // deriving it at read time is already lossy, not theoretically lossy.
    const { ctx, events } = ctxFor(db);
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "step_confirmation_pending",
      currentText: "Waiting on you",
      workCategory: null
    });
    const parkEvent = events.filter((e) => e.type === "activity.changed").at(-1)!;

    appendActivityStep(ctx, { ...base, text: "Reading a file", category: "reading", diff: null });

    const rowNow = db
      .prepare("SELECT source_kind AS k FROM activities WHERE step_run_id = ?")
      .get(base.stepRunId) as { k: string };
    expect(rowNow.k).toBe("tool_use"); // the row moved on
    expect(parkEvent.payload).toMatchObject({ sourceKind: "step_confirmation_pending" }); // the event did not
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

  it("keeps a completed tool-call step's checkmark even when its text matches the turn summary (O1)", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    appendActivityStep(ctx, { ...base, text: "Read ORCA.md", category: "reading", diff: null });
    appendActivityStep(ctx, { ...base, text: "Read config.ts", category: "reading", diff: null });

    // The turn's derived summary coincides with the last tool call's text.
    completeLive(ctx, { stepRunId: "s1", finalSummary: "Read config.ts", confidence: null });

    const steps = db
      .prepare(
        "SELECT text, status FROM activity_steps WHERE activity_id=(SELECT id FROM activities WHERE step_run_id='s1') ORDER BY ordinal"
      )
      .all() as Array<{ text: string; status: string }>;
    // Both tool-call steps survive as done — the last one keeps its checkmark.
    expect(steps.map((s) => s.text)).toEqual(["Read ORCA.md", "Read config.ts"]);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    // The redundant summary is dropped so the action is not rendered twice.
    const a = db.prepare("SELECT final_summary FROM activities WHERE step_run_id='s1'").get() as { final_summary: string | null };
    expect(a.final_summary).toBeNull();
  });

  it("is idempotent on tool_use_id: a redelivered tool call appends no second step", () => {
    const { ctx, events } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    const before = events.length;
    const first = appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null, toolUseId: "tu-1" });
    const again = appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null, toolUseId: "tu-1" });

    expect(first.steps.length).toBe(1);
    expect(again.steps.length).toBe(1); // no duplicate row
    expect(again.id).toBe(first.id);
    // The no-op redelivery publishes no activity.changed event (nothing changed).
    expect(events.length - before).toBe(1);
  });

  it("a tool_use redelivered AFTER the turn completes does not spawn a new activity", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null, toolUseId: "tu-1" });
    completeLive(ctx, { stepRunId: "s1", finalSummary: "done", confidence: null });

    // Spool re-POSTs the same tool call after the activity is no longer live.
    appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null, toolUseId: "tu-1" });

    const rows = db.prepare("SELECT COUNT(*) AS c FROM activities WHERE step_run_id='s1'").get() as { c: number };
    const steps = db.prepare("SELECT COUNT(*) AS c FROM activity_steps").get() as { c: number };
    expect(rows.c).toBe(1); // no second activity lazily created
    expect(steps.c).toBe(1); // no duplicate step
  });

  it("still appends every step when no tool_use_id is provided (back-compat)", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null });
    const out = appendActivityStep(ctx, { ...base, text: "Read x.ts", category: "reading", diff: null });
    expect(out.steps.length).toBe(2);
  });

  it("keeps a distinct turn summary as the recap when it differs from the last step", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    appendActivityStep(ctx, { ...base, text: "Read config.ts", category: "reading", diff: null });

    completeLive(ctx, { stepRunId: "s1", finalSummary: "Confirmed the default is 5000ms.", confidence: null });

    const steps = db
      .prepare(
        "SELECT text, status FROM activity_steps WHERE activity_id=(SELECT id FROM activities WHERE step_run_id='s1') ORDER BY ordinal"
      )
      .all() as Array<{ text: string; status: string }>;
    // The tool-call step survives with its checkmark…
    expect(steps).toEqual([{ text: "Read config.ts", status: "done" }]);
    // …and a non-duplicate summary is preserved as the recap.
    const a = db.prepare("SELECT final_summary FROM activities WHERE step_run_id='s1'").get() as { final_summary: string | null };
    expect(a.final_summary).toBe("Confirmed the default is 5000ms.");
  });

  it("parks for confirmation even when a stale paused_for_input activity is still live (reconcile robustness)", () => {
    const { ctx } = ctxFor(db);
    // A worker left a live permission/question activity (paused_for_input) when the
    // daemon restarted — e.g. a pending permission that never resolved.
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "Watching...", workCategory: null });
    db.prepare("UPDATE activities SET status='paused_for_input', source_kind='tool_use' WHERE step_run_id='s1'").run();

    // Reconcile re-parks the held step for confirmation; it must not collide with
    // the one-live-per-step unique index over the stale activity.
    expect(() =>
      pauseForConfirmation(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "Review and Continue" })
    ).not.toThrow();

    // The step now has exactly one live activity — the confirmation gate.
    const live = getLiveForStepRun(db, "s1");
    expect(live?.sourceKind).toBe("step_confirmation_pending");
    const liveCount = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE step_run_id='s1' AND status IN ('active','paused_for_input')")
      .get() as { n: number };
    expect(liveCount.n).toBe(1);
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

  it("pauses for confirmation as a separate row, finalizing the worker turn", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    const paused = pauseForConfirmation(ctx, {
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1",
      summary: "Completeness 90% · Correctness 85% · Ready for handoff"
    });
    expect(paused.status).toBe("paused_for_input");
    expect(paused.sourceKind).toBe("step_confirmation_pending");
    expect(paused.currentText).toContain("90%");
    // The worker turn is finalized as its own durable card, not overwritten.
    const worker = db.prepare("SELECT status, source_kind FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as { status: string; source_kind: string };
    expect(worker.status).toBe("completed");
  });

  it("resumes a confirmation activity back to active", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    pauseForConfirmation(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "x" });
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

  it("resolvePermissionPendingActivity clears a permission_pending activity back to active/step_started", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    openOrUpdateLive(ctx, {
      ...base,
      sourceKind: "permission_pending",
      currentText: "The agent wants to run Bash — awaiting your approval.",
      workCategory: null
    });
    const resolved = resolvePermissionPendingActivity(ctx, { stepRunId: "s1" });
    expect(resolved?.status).toBe("active");
    expect(resolved?.sourceKind).toBe("step_started");
  });

  it("resolvePermissionPendingActivity is a no-op when the live activity isn't permission_pending", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    const resolved = resolvePermissionPendingActivity(ctx, { stepRunId: "s1" });
    expect(resolved).toBeUndefined();
  });

  it("completeLive does not close a confirmation checkpoint", () => {
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "step_started", currentText: "working", workCategory: null });
    pauseForConfirmation(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "score summary" });
    const result = completeLive(ctx, { stepRunId: "s1", finalSummary: "turn done", confidence: null });
    expect(result).toBeUndefined();
    const confirm = db.prepare("SELECT status, source_kind FROM activities WHERE step_run_id='s1' AND source_kind='step_confirmation_pending'").get() as { status: string; source_kind: string };
    expect(confirm.status).toBe("paused_for_input");
    expect(confirm.source_kind).toBe("step_confirmation_pending");
    // The worker turn was finalized at pause time and stays a durable card.
    const worker = db.prepare("SELECT status FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as { status: string };
    expect(worker.status).toBe("completed");
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

  it("pauseForMarkDone finalizes a live worker turn instead of colliding on the live index", () => {
    // Live failure (2026-07-07, grounding e2e run #2): the terminal step's
    // worker tool_use activity was still live when the unsupervised commit
    // parked mark-done — the insert hit idx_activities_one_live_per_step,
    // the whole stop-hook transaction threw, and the run stranded silently.
    // (Run #1 dodged it: an escalation had already finalized the live turn.)
    const { ctx } = ctxFor(db);
    openOrUpdateLive(ctx, { ...base, sourceKind: "tool_use", currentText: "Committing release notes", workCategory: null });
    const a = pauseForMarkDone(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-9" });
    expect(a.sourceKind).toBe("mark_done_pending");
    // The worker turn survives as a durable completed card, not an overwrite.
    const worker = db.prepare("SELECT status FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as { status: string };
    expect(worker.status).toBe("completed");
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

  describe("a run that has stopped keeps no live card", () => {
    function seedRun(id: string, status: string) {
      db.prepare(
        `INSERT OR IGNORE INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
         VALUES ('tpl', 'T', '', 1, 0, 0, '[]', '[]', '2026-06-05', '2026-06-05')`
      ).run();
      // One goal per run: a goal holds at most one non-terminal run.
      db.prepare(
        `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
         VALUES (?, 't', '', 'active', 1, '2026-06-05', '2026-06-05', null)`
      ).run(`goal-${id}`);
      db.prepare(
        `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at)
         VALUES (?, ?, 'tpl', 1, ?, '2026-06-05')`
      ).run(id, `goal-${id}`, status);
    }

    it("expireLiveForRun expires every live row of the run and announces each", () => {
      const { ctx, events } = ctxFor(db);
      // A Continue/Revise card on one step and a worker mid-turn on another —
      // the two shapes found orphaned on blocked runs (three cards, one tool_use).
      pauseForConfirmation(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "Done?" });
      openOrUpdateLive(ctx, { ...base, stepRunId: "s2", sourceKind: "tool_use", currentText: "Reading…", workCategory: "reading" });
      // A live card on ANOTHER run must be left alone.
      openOrUpdateLive(ctx, { ...base, workflowRunId: "r2", stepRunId: "s3", sourceKind: "tool_use", currentText: "…", workCategory: null });
      events.length = 0;

      const expired = expireLiveForRun(ctx, { workflowRunId: "r1" });

      expect(expired.map((a) => a.status)).toEqual(["expired", "expired"]);
      expect(getLiveForStepRun(db, "s1")).toBeUndefined();
      expect(getLiveForStepRun(db, "s2")).toBeUndefined();
      expect(getLiveForStepRun(db, "s3")?.status).toBe("active");
      // One activity.changed per row, so the chat drops the controls at once.
      expect(events.filter((e) => e.type === "activity.changed")).toHaveLength(2);
      expect(expireLiveForRun(ctx, { workflowRunId: "r1" })).toEqual([]);
    });

    it("expireLiveOnStoppedRuns sweeps only runs that are no longer moving", () => {
      const { ctx } = ctxFor(db);
      seedRun("r-blocked", "blocked");
      seedRun("r-done", "completed");
      seedRun("r-live", "active");
      seedRun("r-paused", "paused");
      for (const [run, step] of [["r-blocked", "s1"], ["r-done", "s2"], ["r-live", "s3"], ["r-paused", "s4"]] as const) {
        pauseForConfirmation(ctx, { goalId: `goal-${run}`, workflowRunId: run, stepRunId: step, summary: "Done?" });
      }

      expect(expireLiveOnStoppedRuns(ctx)).toBe(2);

      expect(getLiveForStepRun(db, "s1")).toBeUndefined();
      expect(getLiveForStepRun(db, "s2")).toBeUndefined();
      // A run that can still act on its card keeps it: active, and paused (resumable, worker alive).
      expect(getLiveForStepRun(db, "s3")?.status).toBe("paused_for_input");
      expect(getLiveForStepRun(db, "s4")?.status).toBe("paused_for_input");
    });
  });
});
