import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus } from "../events.js";
import { appendActivityStep, completeLive, expireLive, getLiveForStepRun, interruptLive } from "./store.js";

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
      category TEXT, status TEXT, diff TEXT, created_at TEXT);
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
});
