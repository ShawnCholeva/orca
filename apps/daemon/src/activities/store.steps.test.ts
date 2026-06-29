import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus } from "../events.js";
import {
  appendActivityStep,
  completeLive,
  expireConfirmation,
  expireLive,
  getLiveForStepRun,
  interruptLive,
  pauseForConfirmation,
  resumeFromConfirmation,
} from "./store.js";

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

const base = { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null };

describe("activity steps", () => {
  let c: ReturnType<typeof ctx>;
  beforeEach(() => { c = ctx(); });

  it("appends steps, flipping the prior active step to done", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "Edited verifier.ts", category: "editing", diff: null });
    const live = getLiveForStepRun(c.db, "s1")!;
    expect(live.steps.map((s) => s.status)).toEqual(["done", "active"]);
    expect(live.steps.map((s) => s.text)).toEqual(["Read verifier.ts", "Edited verifier.ts"]);
  });

  it("stores the diff JSON on the step", () => {
    appendActivityStep(c, {
      ...base, text: "Edited verifier.ts", category: "editing",
      diff: { filePath: "verifier.ts", additions: 1, deletions: 0,
        hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "x" }] }] },
    });
    expect(getLiveForStepRun(c.db, "s1")!.steps[0].diff?.additions).toBe(1);
  });

  it("completeLive marks the active step done and sets the summary", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    completeLive(c, { stepRunId: "s1", finalSummary: "Found the bug.", confidence: null });
    const row = c.db.prepare("SELECT status, final_summary FROM activities WHERE step_run_id='s1'").get() as any;
    expect(row.status).toBe("completed");
    expect(row.final_summary).toBe("Found the bug.");
    const stepStatus = c.db.prepare("SELECT status FROM activity_steps").get() as any;
    expect(stepStatus.status).toBe("done");
  });

  it("completeLive keeps the trailing step's checkmark and drops the duplicate summary", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "The exploration agent is running.", category: "other", diff: null });
    completeLive(c, { stepRunId: "s1", finalSummary: "The exploration agent is running.", confidence: null });
    // Every completed step keeps its done-state; the redundant copy is the
    // summary, which is dropped so the action is not rendered twice.
    const steps = c.db.prepare("SELECT text, status FROM activity_steps ORDER BY ordinal").all() as any[];
    expect(steps.map((s) => s.text)).toEqual(["Read verifier.ts", "The exploration agent is running."]);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    const row = c.db.prepare("SELECT final_summary FROM activities WHERE step_run_id='s1'").get() as any;
    expect(row.final_summary).toBeNull();
  });

  it("completeLive keeps a trailing step whose text differs from the summary", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    completeLive(c, { stepRunId: "s1", finalSummary: "Found the bug.", confidence: null });
    const texts = c.db.prepare("SELECT text FROM activity_steps ORDER BY ordinal").all() as any[];
    expect(texts.map((s) => s.text)).toEqual(["Read verifier.ts"]);
  });

  it("interruptLive completes the activity but leaves the cut step active", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "Editing file", category: "editing", diff: null });
    interruptLive(c, { stepRunId: "s1", finalSummary: "Interrupted — send a correction to resume." });
    const row = c.db.prepare("SELECT status, final_summary FROM activities WHERE step_run_id='s1'").get() as any;
    expect(row.status).toBe("completed");
    expect(row.final_summary).toBe("Interrupted — send a correction to resume.");
    // First step done, the in-progress step stays active (the interrupted signal).
    const statuses = c.db.prepare("SELECT status FROM activity_steps ORDER BY ordinal").all() as any[];
    expect(statuses.map((s) => s.status)).toEqual(["done", "active"]);
  });

  it("expireLive marks the active step done", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    expireLive(c, { stepRunId: "s1" });
    const row = c.db.prepare("SELECT status FROM activities WHERE step_run_id='s1'").get() as any;
    expect(row.status).toBe("expired");
    const stepStatus = c.db.prepare("SELECT status FROM activity_steps").get() as any;
    expect(stepStatus.status).toBe("done");
  });

  // Regression: pausing for confirmation must NOT destroy the worker's activity
  // thread. The steps-bearing turn is finalized as its own durable turn_completed
  // card; the confirmation gate is a SEPARATE step_confirmation_pending row.
  it("pauseForConfirmation finalizes the worker turn as a durable card and opens a separate confirmation row", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "Edited verifier.ts", category: "editing", diff: null });
    pauseForConfirmation(c, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "Completeness 90% — ready." });

    const worker = c.db.prepare("SELECT * FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as any;
    expect(worker).toBeTruthy();
    expect(worker.status).toBe("completed");
    const workerSteps = c.db.prepare("SELECT text FROM activity_steps WHERE activity_id=? ORDER BY ordinal").all(worker.id) as any[];
    expect(workerSteps.map((s) => s.text)).toContain("Read verifier.ts");

    const confirm = c.db.prepare("SELECT * FROM activities WHERE step_run_id='s1' AND source_kind='step_confirmation_pending'").get() as any;
    expect(confirm).toBeTruthy();
    expect(confirm.status).toBe("paused_for_input");
    expect(confirm.current_text).toBe("Completeness 90% — ready.");
    expect(confirm.id).not.toBe(worker.id);
    const confirmSteps = c.db.prepare("SELECT COUNT(*) AS n FROM activity_steps WHERE activity_id=?").get(confirm.id) as any;
    expect(confirmSteps.n).toBe(0);

    // The live row for the step is now the confirmation gate (highest ordinal, paused).
    expect(getLiveForStepRun(c.db, "s1")!.sourceKind).toBe("step_confirmation_pending");
  });

  it("expireConfirmation (continue) leaves the worker turn card intact", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    appendActivityStep(c, { ...base, text: "Edited verifier.ts", category: "editing", diff: null });
    pauseForConfirmation(c, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "Ready." });
    expireConfirmation(c, { stepRunId: "s1" });

    const confirm = c.db.prepare("SELECT status FROM activities WHERE step_run_id='s1' AND source_kind='step_confirmation_pending'").get() as any;
    expect(confirm.status).toBe("expired");
    const worker = c.db.prepare("SELECT status FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as any;
    expect(worker.status).toBe("completed");
    const workerSteps = c.db
      .prepare("SELECT COUNT(*) AS n FROM activity_steps st JOIN activities a ON a.id=st.activity_id WHERE a.source_kind='turn_completed'")
      .get() as any;
    expect(workerSteps.n).toBeGreaterThan(0);
  });

  it("resumeFromConfirmation (revise) reactivates the gate row and leaves the worker card", () => {
    appendActivityStep(c, { ...base, text: "Read verifier.ts", category: "reading", diff: null });
    pauseForConfirmation(c, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", summary: "Ready." });
    resumeFromConfirmation(c, { stepRunId: "s1" });

    const worker = c.db.prepare("SELECT status FROM activities WHERE step_run_id='s1' AND source_kind='turn_completed'").get() as any;
    expect(worker.status).toBe("completed");
    const live = getLiveForStepRun(c.db, "s1")!;
    expect(live.status).toBe("active");
    expect(live.sourceKind).toBe("step_started");
  });
});
