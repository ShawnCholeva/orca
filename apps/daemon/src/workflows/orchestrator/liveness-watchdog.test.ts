import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { resetPreparedStatements as resetSessionStmts } from "../../sessions/projection.js";
import { resetPreparedStatements as resetRuntimeStmts } from "../../sessions/runtime.js";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { OrchestratorService } from "./service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import {
  buildLivenessWatchdogDeps,
  livenessWatchdogTick,
} from "./liveness-watchdog.js";
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
    expect(msg?.body).toMatch(/manual intervention/i);
  });

  it("no-op when the worker is alive", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const isTmuxAlive = vi.fn(async () => true);

    const deps = buildLivenessWatchdogDeps(db, bus, { isTmuxAlive, now: () => NOW, graceMs: GRACE_MS });
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(isTmuxAlive).toHaveBeenCalledWith(sessionId);
    expect(sessionStatus(db, sessionId)).toBe("running");
    expect(crashRetries(db, stepRunId)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it("no-op when a step_output artifact already exists (even if tmux is dead)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db, { withStepOutput: true });

    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);
    const isTmuxAlive = vi.fn(async () => false);

    const deps = buildLivenessWatchdogDeps(db, bus, { isTmuxAlive, now: () => NOW, graceMs: GRACE_MS });
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

    const deps = buildLivenessWatchdogDeps(db, bus, { isTmuxAlive, now: () => NOW, graceMs: GRACE_MS });
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
    const deps = buildLivenessWatchdogDeps(db, bus, { isTmuxAlive: async () => false, now: () => NOW, graceMs: GRACE_MS });

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
