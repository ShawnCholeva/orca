import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { resetPreparedStatements as resetSessionStmts } from "../../sessions/projection.js";
import { isBookkeepingSessionEnd, resetPreparedStatements as resetRuntimeStmts } from "../../sessions/runtime.js";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { OrchestratorService } from "./service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { failSession } from "../../sessions/runtime.js";
import { CRASH_RETRY_CAP } from "./crash-retry.js";
import {
  buildLivenessWatchdogDeps,
  livenessWatchdogTick,
  type ProgressMark,
} from "./liveness-watchdog.js";
import { resolvePermissionPendingActivity } from "../../activities/store.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  makeStep,
  fakeRegistry,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";

const PROVIDER = "orca/anthropic" as const;
const MODEL = "claude-sonnet-4-6";
const GRACE_MS = 15_000;
// A session start well outside the grace window (60s before NOW).
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
 * routes session.failed → onWorkflowSessionCompleted.
 */
function makeServiceWithSubscriber(
  db: Database.Database,
  bus: EventBus,
  idFactory: () => string,
  launch: WorkflowSessionLauncher["launch"],
  workerTerminate?: (sessionId: string) => Promise<void>
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
    fakeStepDispatch(),
    undefined,
    undefined,
    workerTerminate
  );
  const completions: Promise<void>[] = [];
  bus.subscribe((event) => {
    if (event.type !== "session.failed" && event.type !== "session.exited") return;
    // Same guard as server.ts: a bookkeeping exit is a record, not a turn boundary.
    if (isBookkeepingSessionEnd(event.payload)) return;
    const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : null;
    const goalId = typeof event.payload.goalId === "string" ? event.payload.goalId : null;
    if (!sessionId || !goalId) return;
    completions.push(
      // These fixtures date every session before the real process start, so pin the
      // daemon generation explicitly: they mean "this worker started under THIS
      // daemon and genuinely crashed", which is what should spend the budget.
      // Without the pin they read as workers lost to a restart, which is exempt.
      service.onWorkflowSessionCompleted(db, () => NOW, { sessionId, goalId }, {
        bus, idFactory, daemonStartedAt: "2000-01-01T00:00:00.000Z",
      })
    );
  });
  return { completions };
}

function crashRetries(db: Database.Database, stepRunId: string): number {
  return (
    db.prepare("SELECT crash_retries AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as {
      c: number;
    }
  ).c;
}

function sessionStatus(db: Database.Database, sessionId: string): string {
  return (
    db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string }
  ).status;
}

const STALL_MS = 600_000;
// A tool call in flight earns the longer budget; well clear of STALL_MS so the
// two thresholds are distinguishable in the assertions below.
const TOOL_STALL_MS = STALL_MS * 4;
const T0 = Date.parse(NOW);

/** A tick clock: NOW + `offsetMs`, in the ISO form buildLivenessWatchdogDeps expects. */
function atOffset(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Seed the live activity row for a step run. */
function seedActivity(
  db: Database.Database,
  opts: { goalId: string; runId: string; stepRunId: string; status: string; sourceKind: string; updatedAt: string }
): void {
  db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
       status, current_text, final_summary, source_kind, work_category, confidence, pending_question,
       created_at, updated_at, completed_at)
     VALUES ('act-1', ?, ?, ?, NULL, 0, ?, 'working', NULL, ?, NULL, NULL, NULL, ?, ?, NULL)`
  ).run(opts.goalId, opts.runId, opts.stepRunId, opts.status, opts.sourceKind, NOW, opts.updatedAt);
}

/** An unanswered question parked on a chat message — the channel with no activity row. */
function seedOpenQuestion(
  db: Database.Database,
  opts: { goalId: string; stepRunId: string; source: "worker" | "orchestrator" }
): void {
  db.prepare(
    `INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question)
     VALUES ('om-q1', ?, 'orchestrator', 'message', 'A decision is needed.', NULL, ?, ?)`
  ).run(
    opts.goalId,
    NOW,
    JSON.stringify({
      questionId: "q-1",
      toolUseId: "tu-1",
      source: opts.source,
      stepRunId: opts.stepRunId,
      questions: [
        { header: "Approach", question: "Which way?", multiSelect: false, options: [{ label: "A", description: "a" }] },
      ],
    })
  );
}

function answerOpenQuestion(db: Database.Database): void {
  db.prepare(
    `UPDATE orchestrator_messages
        SET pending_question = json_set(pending_question, '$.answer', json('{"freeText":"A"}'))
      WHERE id = 'om-q1'`
  ).run();
}

/** A tool call on the live activity: `active` until its tool_result closes it. */
function seedToolStep(db: Database.Database, opts: { status: "active" | "done" }): void {
  db.prepare(
    `INSERT INTO activity_steps (id, activity_id, ordinal, text, category, status, diff, created_at, tool_use_id)
     VALUES ('astep-1', 'act-1', 0, 'Ran tests: pnpm build', 'testing', ?, NULL, ?, 'tool-1')`
  ).run(opts.status, NOW);
}

function setOutputSeq(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare("UPDATE sessions SET output_seq = ? WHERE id = ?").run(seq, sessionId);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  resetSessionStmts();
  resetRuntimeStmts();
  cleanupHarness();
});

describe("livenessWatchdogTick", () => {
  it("reaps a dead worker (no step_output, past grace) → session.failed → respawn under cap", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    // Session was marked failed with the watchdog reason.
    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as {
        r: string | null;
      }
    ).r;
    expect(reason).toBe("worker_exited_no_signal");

    // Flowed through crash-retry: counter incremented, step respawned under cap.
    expect(crashRetries(db, stepRunId)).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(launch).mock.calls[0][0]).toMatchObject({ workflowStepRunId: stepRunId });
  });

  it("at CRASH_RETRY_CAP → escalates to a human instead of spinning", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, stepRunId } = seedRunningWorkerStep(db, { crashRetries: 2 });

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    // Cap reached: no respawn, escalation posted to the orchestrator chat.
    expect(crashRetries(db, stepRunId)).toBe(3);
    expect(launch).not.toHaveBeenCalled();
    const msg = db
      .prepare(
        "SELECT body FROM orchestrator_messages WHERE goal_id = ? AND role = 'orchestrator' LIMIT 1"
      )
      .get(goalId) as { body: string } | undefined;
    expect(msg?.body).toMatch(/stopped the run here/i);
  });

  it("no-op when the worker is alive", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const isTmuxAlive = vi.fn(async () => true);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(isTmuxAlive).toHaveBeenCalledWith(sessionId);
    expect(sessionStatus(db, sessionId)).toBe("running");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it("closes a dead worker on a step parked at its confirmation card as exited — the card is the reader's, not a crash", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db, { withStepOutput: true });
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = '{}' WHERE id = ?").run(stepRunId);
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("exited");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect(completions).toHaveLength(0);
    const stash = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { pending_completion_json: string | null };
    expect(stash.pending_completion_json).toBe("{}");
  });

  it("closes a dead worker on a FINISHED step as exited — no failure, no crash retry, no respawn", async () => {
    // The run is parked on a human with a finished step as its cursor; the worker's
    // tmux is gone. Four such rows sat at `running` for days on one step, because
    // the step-output guard below never let the tick look at them.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db, { withStepOutput: true });
    db.prepare("UPDATE workflow_step_runs SET finished_at = ? WHERE id = ?").run(NOW, stepRunId);
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("exited");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    // Nothing drove the step: no orchestrator turn was requested off the close.
    expect(completions).toHaveLength(0);
    // Idempotent: a closed row is no longer `running`, so the next tick sees nothing.
    await livenessWatchdogTick(deps);
    expect(sessionStatus(db, sessionId)).toBe("exited");
  });

  it("no-op when a step_output artifact already exists (even if tmux is dead)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db, { withStepOutput: true });

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const isTmuxAlive = vi.fn(async () => false);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    // step_output present → never even probes tmux; session left untouched.
    expect(isTmuxAlive).not.toHaveBeenCalled();
    expect(sessionStatus(db, sessionId)).toBe("running");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it("no-op within the grace window (just-spawned, not-yet-alive worker)", async () => {
    const { db, bus, idFactory } = setupHarness();
    // started_at == NOW → zero elapsed, inside the grace window.
    const { sessionId, stepRunId } = seedRunningWorkerStep(db, { startedAt: NOW });

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const isTmuxAlive = vi.fn(async () => false);

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    // Grace short-circuits before any tmux probe.
    expect(isTmuxAlive).not.toHaveBeenCalled();
    expect(sessionStatus(db, sessionId)).toBe("running");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it("reaps a dead worker-GATE surrogate (parked awaitingWorker) → session.failed → human gate escalation", async () => {
    const { db, bus, idFactory } = setupHarness();

    // A run parked mid-eval at a worker gate: current_step_run_id NULL, a live
    // surrogate step-run, and a `running` session on it (started past grace).
    const graph = {
      nodes: [
        { id: "validation", type: "step", name: "V", stepId: "validation" },
        { id: "gate", type: "gate", name: "Critique", evalSubstrate: "worker", instructions: "x", agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
        { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
      ],
      edges: [ { from: "validation", to: "gate" }, { from: "gate", to: "done", port: "approved" }, { from: "gate", to: "validation", port: "rejected" } ],
      positions: {},
    };
    const steps = [
      makeStep({ id: "validation", ordinal: 0, name: "V", instructions: "v", outputSchema: [{ key: "result", type: "string", required: true }] }),
      makeStep({ id: "done", ordinal: 1, name: "Done", instructions: "d", outputSchema: [{ key: "result", type: "string", required: true }] }),
    ];
    db.prepare("INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1','Goal','desc','active',1,?,?,NULL,?,?)").run(NOW, NOW, PROVIDER, MODEL);
    db.prepare("INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1','/tmp/repo','main','',?,?)").run(NOW, NOW);
    db.prepare("INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES ('goal-1','ws-1',?)").run(NOW);
    db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering','Engineering','desc',1,1,1,?,'[]',?,?,?)").run(JSON.stringify(steps), JSON.stringify(graph), NOW, NOW);
    db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, pending_gate_route_json, blocked_reason, started_at, finished_at) VALUES ('run-1','goal-1','orca/engineering',1,'active',NULL,'gate','gate',?,NULL,?,NULL)").run(JSON.stringify({ awaitingWorker: true, gateNodeId: "gate", sourceStepRunId: "step-src", surrogateStepRunId: "sur-1" }), NOW);
    db.prepare("INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-src','goal-1','run-1','validation',0,1,'passed','[]','[]',NULL,?,?,'fp-src')").run(NOW, NOW);
    db.prepare("INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('sur-1','goal-1','run-1','__gate__:gate',-1,1,'active','[]','[]',NULL,?,NULL,'fp-sur')").run(NOW);
    db.prepare("INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, started_at, workflow_step_run_id) VALUES ('gate-sess-1','goal-1','ws-1','claude-code','Gate','running',?,?,?)").run(NOW, STARTED_PAST_GRACE, "sur-1");

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false,
      now: () => NOW,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress: new Map<string, ProgressMark>(),
    });

    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    // The dead gate worker was reaped and escalated (no step respawn — a gate is
    // not a step): surrogate closed, run parked for a human gate decision.
    expect(sessionStatus(db, "gate-sess-1")).toBe("failed");
    expect((db.prepare("SELECT status FROM workflow_step_runs WHERE id='sur-1'").get() as { status: string }).status).toBe("passed");
    const run = db.prepare("SELECT status, pending_gate_route_json FROM workflow_runs WHERE id='run-1'").get() as { status: string; pending_gate_route_json: string | null };
    expect(run.status).toBe("active");
    expect(JSON.parse(run.pending_gate_route_json!).awaitingHumanDecision).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("livenessWatchdogTick — stall sensor", () => {
  it("reaps a live-but-idle worker after the stall window (system's turn)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const workerTerminate = vi.fn(async () => {});
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch, workerTerminate);

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true,
      now: () => clock,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      toolStallMs: TOOL_STALL_MS,
      progress,
    });

    await livenessWatchdogTick(deps);          // baseline mark
    clock = atOffset(STALL_MS + 1);            // no output, no activity movement
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as { r: string }
    ).r;
    expect(reason).toBe("worker_stalled");
    expect(crashRetries(db, stepRunId)).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
    // The stalled worker's tmux process must be killed before a second worker is
    // spawned into the same workspace — otherwise both run concurrently on the
    // same step (Finding 1: stall reap orphans a live worker).
    expect(workerTerminate).toHaveBeenCalledWith(sessionId);
  });

  it("does not reap while output_seq keeps advancing", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    setOutputSeq(db, sessionId, 42);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 2);
    await livenessWatchdogTick(deps);          // only 1ms since the reset

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("does not reap while the step's activity keeps updating (hook progress)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "tool_use", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    db.prepare("UPDATE activities SET updated_at = ? WHERE id = 'act-1'").run(atOffset(1000));
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 2);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("never reaps while paused_for_input, however long the wait", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    seedActivity(db, { goalId, runId, stepRunId, status: "paused_for_input", sourceKind: "question_pending", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("gives a worker inside an unfinished tool call the longer budget", async () => {
    // A cold install, a big build, a slow fetch: no PTY output and no activity
    // update for as long as the tool runs, which is indistinguishable from a hang
    // unless you look at whether a tool is actually in flight. Reaping here kills
    // real work AND spends a rescue from the budget that ends in a blocked run.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "tool_use", updatedAt: NOW });
    seedToolStep(db, { status: "active" });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    // Well past the ordinary budget — and still working.
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("still reaps a tool that never returns, once its own budget runs out", async () => {
    // The in-flight flag buys time, it does not buy an exemption: a tool that
    // truly hangs has to reach a human eventually.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "tool_use", updatedAt: NOW });
    seedToolStep(db, { status: "active" });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(TOOL_STALL_MS + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
  });

  it("keeps the ordinary budget once the tool has returned", async () => {
    // A closed tool step means the agent, not the tool, owes the next move.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "tool_use", updatedAt: NOW });
    seedToolStep(db, { status: "done" });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
  });

  it("never reaps a worker idle behind an unanswered CHAT REPLY (no activity row at all)", async () => {
    // The failure this pins. `answer_user_directly` / `escalate_to_user` /
    // `paraphrase_agent_message` post a chat message and stop; they raise NO
    // activity row, and record the park only on workflow_step_runs.awaiting_user.
    // Reading the park half alone, this sensor saw an idle worker on what it
    // believed was Orca's turn: live, it reaped a worker three times over a run
    // whose header correctly read WAITING ON YOU, and blocked the run at the cap.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    db.prepare("UPDATE workflow_step_runs SET awaiting_user = 1 WHERE id = ?").run(stepRunId);

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
    expect(
      (db.prepare("SELECT stall_rescues AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { c: number }).c
    ).toBe(0);
  });

  it("re-arms the stall clock once the user answers and the chat-reply park clears", async () => {
    // The other side of the same coin: honouring the park must not disarm the
    // sensor permanently, or a worker that really does hang after the user
    // replies would sit there forever.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );
    db.prepare("UPDATE workflow_step_runs SET awaiting_user = 1 WHERE id = ?").run(stepRunId);

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);
    expect(sessionStatus(db, sessionId)).toBe("running");

    // User answers: the park clears and it is Orca's turn again.
    db.prepare("UPDATE workflow_step_runs SET awaiting_user = 0 WHERE id = ?").run(stepRunId);
    clock = atOffset(STALL_MS * 101);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 102 + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
  });

  it("never reaps while an ORCHESTRATOR question is open, even with awaiting_user cleared", async () => {
    // The third channel, and the one the other two miss. The mediator's own
    // ask_user opens NO activity row, and its awaiting_user flag is cleared by the
    // next action that posts no chat reply — the prompt gate suppressing a
    // duplicate ask does it, with no user involvement. The question is still on
    // screen and unanswered while both other halves read false.
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    db.prepare("UPDATE workflow_step_runs SET awaiting_user = 0 WHERE id = ?").run(stepRunId);
    seedOpenQuestion(db, { goalId, stepRunId, source: "orchestrator" });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("reaps again once that question is answered", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );
    db.prepare("UPDATE workflow_step_runs SET awaiting_user = 0 WHERE id = ?").run(stepRunId);
    seedOpenQuestion(db, { goalId, stepRunId, source: "orchestrator" });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);
    expect(sessionStatus(db, sessionId)).toBe("running");

    answerOpenQuestion(db);
    clock = atOffset(STALL_MS * 101);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 102 + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
  });

  it("never reaps a worker awaiting permission approval, despite its active status", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    // openActivity inserts status='active' for EVERY source kind — permission_pending
    // is never flipped to paused_for_input, so status alone is not enough.
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "permission_pending", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("re-arms the stall clock once a permission approval is resolved", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "permission_pending", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    // Still pending approval: suppressed, no reap.
    expect(sessionStatus(db, sessionId)).toBe("running");

    // The approval resolves (mirrors both server.ts call sites — user answer and
    // timeout — which both now call this on resolution).
    resolvePermissionPendingActivity({ db, bus, now: () => clock }, { stepRunId });

    clock = atOffset(STALL_MS + 2);
    await livenessWatchdogTick(deps);              // system turn again: re-baseline, no reap yet
    expect(sessionStatus(db, sessionId)).toBe("running");
    clock = atOffset(STALL_MS + 2 + STALL_MS + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as { r: string }
    ).r;
    expect(reason).toBe("worker_stalled");
  });

  it("forgets accumulated idle time when the turn passes to the user", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);                     // system turn, clock starts
    clock = atOffset(STALL_MS - 1000);
    seedActivity(db, { goalId, runId, stepRunId, status: "paused_for_input", sourceKind: "question_pending", updatedAt: NOW });
    await livenessWatchdogTick(deps);                     // user's turn → mark dropped
    expect(progress.has(stepRunId)).toBe(false);

    db.prepare("UPDATE activities SET status = 'completed', completed_at = ? WHERE id = 'act-1'").run(NOW);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);                     // system turn again: re-baseline, no reap
    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("still reaps a dead worker immediately, without waiting for the stall window", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false, now: () => NOW, graceMs: GRACE_MS,
      stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as { r: string }
    ).r;
    expect(reason).toBe("worker_exited_no_signal");
  });
});

function stallRescues(db: Database.Database, stepRunId: string): number {
  return (
    db.prepare("SELECT stall_rescues AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as {
      c: number;
    }
  ).c;
}

describe("stall recovery accounting", () => {
  it("counts a stall rescue separately from a crash retry and says so in the chat", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, toolStallMs: TOOL_STALL_MS, progress,
    });
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(stallRescues(db, stepRunId)).toBe(1);
    expect(crashRetries(db, stepRunId)).toBe(1);
    const body = (
      db.prepare(
        "SELECT body AS b FROM orchestrator_messages WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(goalId) as { b: string }
    ).b;
    expect(body).toContain("hasn't made progress");
    expect(body).toContain("2 of 3");
  });

  it("at the cap, blocks the step run and the workflow run instead of leaving it active", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db, {
      crashRetries: CRASH_RETRY_CAP - 1,
    });
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );
    // Observed on the BUS, not just persisted to the events table — a table-only
    // check would pass even if the cap path never reaches publishStaged, leaving
    // the WS stream (and the AgentActivity card) never told the step blocked.
    const busEvents: string[] = [];
    bus.subscribe((event) => busEvents.push(event.type));

    failSession(db, bus, sessionId, goalId, "worker_stalled", NOW);
    await Promise.all(completions);

    expect(busEvents).toContain("workflow.step.blocked");

    const stepRun = db
      .prepare("SELECT status, finished_at, blocked_reason FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string; finished_at: string | null; blocked_reason: string | null };
    expect(stepRun.status).toBe("blocked");
    expect(stepRun.finished_at).not.toBeNull();
    // Nothing was rescued at the cap — the worker was never restarted — so this
    // attempt must not add to stall_rescues; only the two actual restarts already
    // reflected in the seeded crash_retries counted toward the rescue budget.
    expect(stallRescues(db, stepRunId)).toBe(0);
    const run = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(runId) as { status: string };
    expect(run.status).toBe("blocked");

    // The workflow.run.blocked event must carry the injected clock, not the real
    // wall clock markWorkflowRunBlocked falls back to when `now` is omitted.
    const event = db
      .prepare(
        "SELECT created_at AS c FROM events WHERE type = 'workflow.run.blocked' AND goal_id = ?"
      )
      .get(goalId) as { c: string } | undefined;
    expect(event?.c).toBe(NOW);
  });
});
