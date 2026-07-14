import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionOutputSnapshot } from "@orca/contracts";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import {
  cleanupHarness,
  setupHarness,
  makeStep,
  fakeRegistry,
  NOW,
} from "./skill-step-test-helpers.js";
import { OrchestratorService } from "./service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import {
  formatAnswerForAgentStdin,
  injectAnswerToSession,
  detectPendingAgentQuestion,
} from "./agent-interview.js";

describe("formatAnswerForAgentStdin", () => {
  it("appends a newline", () => {
    expect(formatAnswerForAgentStdin("yes")).toBe("yes\n");
  });
  it("strips control sequences and trims", () => {
    expect(formatAnswerForAgentStdin("  hithere  ")).toBe("hithere\n");
  });
});

describe("injectAnswerToSession", () => {
  it("writes the answer to the PTY handle when session exists", () => {
    const write = vi.fn();
    const r = injectAnswerToSession({ getHandle: () => ({ write }) }, "s", "yes");
    expect(r).toBe("injected");
    expect(write).toHaveBeenCalledWith(Buffer.from("yes\n", "utf8"));
  });
  it("returns 'no_session' when no handle", () => {
    expect(injectAnswerToSession({ getHandle: () => undefined }, "s", "yes")).toBe("no_session");
  });
});

describe("detectPendingAgentQuestion", () => {
  it("extracts the sentinel question", () => {
    expect(detectPendingAgentQuestion('foo\n[orca:ask] question="Region?"\nbar')).toBe("Region?");
  });
  it("returns null when absent", () => {
    expect(detectPendingAgentQuestion("nothing here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: onSessionOutputChunk (10b)
// ---------------------------------------------------------------------------

function snapshotWithText(sessionId: string, text: string): SessionOutputSnapshot {
  return {
    sessionId,
    firstByteOffset: 0,
    nextSeq: 1,
    totalBytesKept: Buffer.byteLength(text),
    chunks: [{ seq: 0, byteOffset: 0, dataBase64: Buffer.from(text).toString("base64") }],
  };
}

function fakeOutputStore(tail: string): SessionOutputStore {
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn((id: string) => snapshotWithText(id, tail)),
  };
}

function makeServiceWithStore(
  outputStore: SessionOutputStore,
  workerTerminate?: (sessionId: string) => Promise<void>,
): OrchestratorService {
  const fakeBroker = { async propose() { return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: {}, rawTextLength: null, latencyMs: 1 }; } };
  const engine = new DispatchEngine(
    fakeBroker,
    fakeRegistry(),
    { launch: async () => { throw new Error("direct_launch_unsupported"); } },
    undefined,
    undefined,
    undefined,
    undefined
  );
  return new OrchestratorService(
    engine,
    fakeBroker,
    fakeRegistry(),
    outputStore,
    undefined,
    undefined,
    undefined,
    workerTerminate,
  );
}

function seedAgentSessionWithSentinel(
  db: Database.Database,
  opts: { stepRunStatus?: string } = {}
): { sessionId: string; goalId: string; stepRunId: string; runId: string } {
  const sessionId = "sess-interview-1";
  const goalId = "goal-interview-1";
  const runId = "run-interview-1";
  const stepRunId = "step-interview-1";
  const stepRunStatus = opts.stepRunStatus ?? "active";

  const step = makeStep({
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Do the work.",
    outputSchema: [{ key: "result", type: "string", required: true }],
  });

  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run(goalId, NOW, NOW);

  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('ws-int-1', '/tmp/repo', 'main', '', NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, 'ws-int-1', NOW);

  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify([step]), NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'orca/engineering', 1, 'active', ?, NULL, ?, NULL)"
  ).run(runId, goalId, stepRunId, NOW);

  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES (?, ?, ?, ?, 0, 1, ?, '[]', '[]', NULL, ?, NULL, 'fp-1', NULL, NULL, NULL, NULL)"
  ).run(stepRunId, goalId, runId, step.id, stepRunStatus, NOW);

  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, ?, 'ws-int-1', 'claude-code', 'Session', 'running', ?, ?)"
  ).run(sessionId, goalId, NOW, stepRunId);

  return { sessionId, goalId, runId, stepRunId };
}

function countDecisions(db: Database.Database, decisionType: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM workflow_decisions WHERE decision_type = ?")
      .get(decisionType) as { c: number }
  ).c;
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService.onSessionOutputChunk", () => {
  it("sentinel in tail → emits request_user_input decision once (idempotent)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db);

    const outputStore = fakeOutputStore('[orca:ask] question="Region?"');
    const service = makeServiceWithStore(outputStore);
    const opts = { bus, idFactory };

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, opts);
    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, opts);

    expect(countDecisions(db, "request_user_input")).toBe(1);
  });

  it("no sentinel → no decision emitted", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db);

    const outputStore = fakeOutputStore("just some output");
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });

  const LIMIT_TAIL =
    "You've hit your session limit · resets 1:20am (America/Los_Angeles)\n" +
    "/upgrade to increase your usage limit.";

  function seedLimitActivity(
    db: Database.Database,
    ids: { goalId: string; runId: string; stepRunId: string; sessionId: string },
  ): void {
    db.prepare(
      `INSERT INTO activities
         (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
          status, current_text, final_summary, source_kind, work_category, confidence,
          pending_question, created_at, updated_at, completed_at)
       VALUES ('activity-limit', ?, ?, ?, ?, 0, 'active', 'Watching...', NULL,
               'step_started', NULL, NULL, NULL, ?, ?, NULL)`
    ).run(ids.goalId, ids.runId, ids.stepRunId, ids.sessionId, NOW, NOW);
  }

  it("Claude session limit pauses the activity for recovery without blocking/terminating", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedAgentSessionWithSentinel(db);
    seedLimitActivity(db, { goalId, runId, stepRunId, sessionId });
    const terminate = vi.fn(async () => {});
    const service = makeServiceWithStore(fakeOutputStore(LIMIT_TAIL), terminate);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(
      db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = ?").get(runId)
    ).toEqual({ status: "active", blocked_reason: null });
    expect(
      db.prepare("SELECT status, failure_reason FROM sessions WHERE id = ?").get(sessionId)
    ).toEqual({ status: "running", failure_reason: null });

    const recovery = JSON.parse(
      (db
        .prepare(
          "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?"
        )
        .get(stepRunId) as { recovery: string }).recovery
    );
    expect(recovery).toMatchObject({
      mode: "choose",
      currentSessionId: sessionId,
      currentAdapterId: "claude-code",
      resetTimeText: "1:20am (America/Los_Angeles)",
    });

    expect(
      db.prepare("SELECT status, source_kind FROM activities WHERE id = 'activity-limit'").get()
    ).toEqual({ status: "paused_for_input", source_kind: "provider_recovery_pending" });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("Claude session limit detection is idempotent (same checkpoint, one activity row)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, stepRunId } = seedAgentSessionWithSentinel(db);
    seedLimitActivity(db, { goalId, runId: "run-interview-1", stepRunId, sessionId });
    const service = makeServiceWithStore(fakeOutputStore(LIMIT_TAIL));

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });
    const firstId = (
      JSON.parse(
        (db
          .prepare(
            "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?"
          )
          .get(stepRunId) as { recovery: string }).recovery
      ) as { id: string }
    ).id;

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });
    const secondId = (
      JSON.parse(
        (db
          .prepare(
            "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?"
          )
          .get(stepRunId) as { recovery: string }).recovery
      ) as { id: string }
    ).id;

    expect(secondId).toBe(firstId);
    expect(
      (db
        .prepare(
          "SELECT COUNT(*) AS c FROM activities WHERE step_run_id = ? AND source_kind = 'provider_recovery_pending'"
        )
        .get(stepRunId) as { c: number }).c
    ).toBe(1);
  });

  it("unsupervised mode still creates the checkpoint without spawning another provider", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedAgentSessionWithSentinel(db);
    seedLimitActivity(db, { goalId, runId, stepRunId, sessionId });
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('supervision_mode', 'unsupervised', ?)"
    ).run(NOW);
    const spawn = vi.fn(async () => {});
    const fakeBroker2 = { async propose() { return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: {}, rawTextLength: null, latencyMs: 1 }; } };
    const engine2 = new DispatchEngine(
      fakeBroker2,
      fakeRegistry(),
      { launch: async () => { throw new Error("direct_launch_unsupported"); } },
      undefined,
      spawn,
      undefined,
      undefined
    );
    const service = new OrchestratorService(
      engine2,
      fakeBroker2,
      fakeRegistry(),
      fakeOutputStore(LIMIT_TAIL),
    );

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(
      db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(runId)
    ).toMatchObject({ status: "active" });
    expect(
      db.prepare("SELECT status, source_kind FROM activities WHERE id = 'activity-limit'").get()
    ).toEqual({ status: "paused_for_input", source_kind: "provider_recovery_pending" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("session not linked to a step run → no-op", async () => {
    const { db, bus, idFactory } = setupHarness();

    const goalId = "goal-noop-1";
    const sessionId = "sess-noop-1";
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'G', 'd', 'active', 1, ?, ?, NULL, NULL, NULL)"
    ).run(goalId, NOW, NOW);
    db.prepare(
      `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ws-noop-1', '/tmp', 'main', '', NOW, NOW);
    db.prepare(
      `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
    ).run(goalId, 'ws-noop-1', NOW);
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, ?, 'ws-noop-1', 'claude-code', 'S', 'running', ?, NULL)"
    ).run(sessionId, goalId, NOW);

    const outputStore = fakeOutputStore('[orca:ask] question="test?"');
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });

  it("step run not active → no-op", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db, { stepRunStatus: "passed" });

    const outputStore = fakeOutputStore('[orca:ask] question="Region?"');
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });
});
