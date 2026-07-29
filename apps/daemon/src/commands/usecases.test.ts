import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../db.js";
import { EventBus } from "../events.js";
import { resetWorkflowEventPreparedStatements } from "../workflows/events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../workflows/steps/projection.js";
import { resetPreparedStatements as resetSessionStmts } from "../sessions/projection.js";
import { resetPreparedStatements as resetRuntimeStmts } from "../sessions/runtime.js";
import type { SessionOutputStore } from "../sessions/output-store.js";
import { OrchestratorService } from "../workflows/orchestrator/service.js";
import { DispatchEngine } from "../workflows/orchestrator/dispatch-engine.js";
import type { WorkflowSessionLauncher } from "../workflows/orchestrator/session-launcher.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  makeStep,
  fakeRegistry,
  fakeStepDispatch,
} from "../workflows/orchestrator/skill-step-test-helpers.js";
import { runGoalCommand, UnknownCommandError } from "./usecases.js";

const PROVIDER = "orca/anthropic" as const;
const MODEL = "claude-sonnet-4-6";
// A session start well outside the liveness grace window (60s before NOW).
const STARTED_PAST_GRACE = "2025-12-31T23:59:00.000Z";

function fakeOutputStore(): SessionOutputStore {
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn((sessionId: string) => ({
      sessionId,
      firstByteOffset: 0,
      nextSeq: 0,
      totalBytesKept: 0,
      chunks: [],
    })),
  };
}

/**
 * Seed goal + template + active run (on a `step` node) + active step run + a
 * `running` worker session. Mirrors the real orchestrator step wiring.
 * Copied from liveness-watchdog.test.ts (file-private there) per the task brief.
 */
function seedRunningWorkerStep(
  db: Database.Database,
  opts: {
    startedAt?: string | null;
    crashRetries?: number;
    withStepOutput?: boolean;
  } = {}
): { sessionId: string; goalId: string; runId: string; stepRunId: string } {
  const sessionId = "sess-1";
  const goalId = "goal-1";
  const runId = "run-1";
  const stepRunId = "step-1";
  const startedAt = opts.startedAt === undefined ? STARTED_PAST_GRACE : opts.startedAt;

  const step = makeStep({
    id: "done",
    ordinal: 0,
    name: "Done",
    instructions: "Finish the work.",
    outputSchema: [{ key: "result", type: "string", required: true }],
  });

  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model)
     VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, ?, ?)`
  ).run(goalId, NOW, NOW, PROVIDER, MODEL);

  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("ws-1", "/tmp/repo", "main", "", NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, "ws-1", NOW);

  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)`
  ).run(JSON.stringify([step]), NOW, NOW);

  db.prepare(
    `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, blocked_reason, started_at, finished_at)
     VALUES (?, ?, 'orca/engineering', 1, 'active', ?, ?, 'step', NULL, ?, NULL)`
  ).run(runId, goalId, stepRunId, step.id, NOW);

  db.prepare(
    `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at,
       fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at, crash_retries)
     VALUES (?, ?, ?, ?, 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?, ?)`
  ).run(stepRunId, goalId, runId, step.id, NOW, NOW, opts.crashRetries ?? 0);

  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, started_at, workflow_step_run_id)
     VALUES (?, ?, 'ws-1', 'claude-code', 'Session', 'running', ?, ?, ?)`
  ).run(sessionId, goalId, NOW, startedAt, stepRunId);

  if (opts.withStepOutput) {
    db.prepare(
      `INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at)
       VALUES ('art-1', ?, ?, ?, 'step_output', 'Done', '{"result":"ok"}', 'agent', NULL, NULL, NULL, ?)`
    ).run(goalId, runId, stepRunId, NOW);
  }

  return { sessionId, goalId, runId, stepRunId };
}

/**
 * Wire the crash-retry-capable service exactly as the daemon does: a launcher
 * whose `launch` respawns the step agent, and the terminal-event subscriber that
 * routes session.failed → onWorkflowSessionCompleted. Copied from
 * liveness-watchdog.test.ts (file-private there) per the task brief.
 */
function makeServiceWithSubscriber(
  db: Database.Database,
  bus: EventBus,
  idFactory: () => string,
  launch: WorkflowSessionLauncher["launch"]
): { completions: Promise<void>[] } {
  const broker = { propose: vi.fn() };
  const launcher: WorkflowSessionLauncher = { launch };
  const engine = new DispatchEngine(
    broker as never,
    fakeRegistry(),
    launcher,
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined
  );
  const service = new OrchestratorService(
    engine,
    broker as never,
    fakeRegistry(),
    fakeOutputStore(),
    fakeStepDispatch()
  );
  const completions: Promise<void>[] = [];
  bus.subscribe((event) => {
    if (event.type !== "session.failed") return;
    const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : null;
    const goalId = typeof event.payload.goalId === "string" ? event.payload.goalId : null;
    if (!sessionId || !goalId) return;
    completions.push(
      service.onWorkflowSessionCompleted(db, () => NOW, { sessionId, goalId }, { bus, idFactory })
    );
  });
  return { completions };
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  resetSessionStmts();
  resetRuntimeStmts();
  cleanupHarness();
});

describe("runGoalCommand", () => {
  it("/stuck fails the live worker with the user's reason and restarts it", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const result = await runGoalCommand(
      { db, bus, now: () => NOW, idFactory },
      goalId,
      { command: "stuck", args: "it keeps re-reading the same files" }
    );

    expect(result.ok).toBe(true);
    const sess = db
      .prepare("SELECT status, failure_reason, failure_detail FROM sessions WHERE id = ?")
      .get(sessionId) as { status: string; failure_reason: string; failure_detail: string | null };
    expect(sess.status).toBe("failed");
    expect(sess.failure_reason).toBe("user_declared_stuck");
    expect(sess.failure_detail).toBe("it keeps re-reading the same files");
    expect(
      (db.prepare("SELECT stall_rescues AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { c: number }).c
    ).toBe(1);
  });

  it("/stuck records what the user said in the chat thread", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    await runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, {
      command: "stuck", args: "going in circles",
    });

    const bodies = db
      .prepare("SELECT body AS b FROM orchestrator_messages WHERE goal_id = ?")
      .all(goalId) as { b: string }[];
    expect(bodies.some((r) => r.b.includes("going in circles"))).toBe(true);
  });

  it("rejects an unknown command without touching the run", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId } = seedRunningWorkerStep(db);

    await expect(
      runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, { command: "nope" })
    ).rejects.toBeInstanceOf(UnknownCommandError);

    const sess = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(sess.status).toBe("running");
  });

  it("/stuck with no live worker is a clear no-op, not a crash", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId } = seedRunningWorkerStep(db);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(sessionId);

    const result = await runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, { command: "stuck" });
    expect(result.message).toContain("no agent running");
  });
});
