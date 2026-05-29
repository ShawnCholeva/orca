import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { SessionOutputSnapshot } from "@orca/contracts";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { OrchestratorService } from "./service.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  makeStep,
  fakeSelector,
  fakeRegistry,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import type {
  BrokerCompatibilityOptions,
  BrokerResult,
} from "../orchestration-transport/broker.js";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const PROVIDER = "orca/anthropic" as const;
const MODEL = "claude-sonnet-4-6";

function emptySnapshot(sessionId: string): SessionOutputSnapshot {
  return {
    sessionId,
    firstByteOffset: 0,
    nextSeq: 0,
    totalBytesKept: 0,
    chunks: [],
  };
}

function snapshotWithText(sessionId: string, text: string): SessionOutputSnapshot {
  return {
    sessionId,
    firstByteOffset: 0,
    nextSeq: 1,
    totalBytesKept: Buffer.byteLength(text),
    chunks: [
      {
        seq: 0,
        byteOffset: 0,
        dataBase64: Buffer.from(text).toString("base64"),
      },
    ],
  };
}

function fakeOutputStore(snapshotFn?: (id: string) => SessionOutputSnapshot): SessionOutputStore {
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn((id: string) => snapshotFn ? snapshotFn(id) : emptySnapshot(id)),
  };
}

/** Broker that validates and always returns a valid synthesis output */
function fakeSynthesisBroker(
  output: Record<string, unknown>,
  opts: { failTimes?: number } = {}
): {
  broker: { propose: typeof _propose };
  callCount: () => number;
} {
  let calls = 0;
  const failTimes = opts.failTimes ?? 0;

  async function _propose(
    _req: unknown,
    options?: BrokerCompatibilityOptions
  ): Promise<BrokerResult> {
    calls++;
    if (calls <= failTimes) {
      return { status: "needs_human_review", attemptId: `attempt-${calls}`, reviewPayloadId: "r-1" };
    }
    const validated = options?.validateProposal
      ? await options.validateProposal({ output })
      : { accepted: true as const };
    if (!validated.accepted) {
      return { status: "needs_human_review", attemptId: `attempt-${calls}`, reviewPayloadId: "r-1" };
    }
    return {
      status: "proposed",
      attemptId: `attempt-${calls}`,
      transport: "one_shot",
      parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
        ? (validated as { parsed: unknown }).parsed
        : { output },
      rawTextLength: null,
      latencyMs: 1,
    };
  }

  return { broker: { propose: _propose }, callCount: () => calls };
}

/** Broker that always returns schema-invalid proposals */
function fakeAlwaysInvalidBroker(): { broker: { propose: typeof _propose } } {
  async function _propose(
    _req: unknown,
    options?: BrokerCompatibilityOptions
  ): Promise<BrokerResult> {
    const validated = options?.validateProposal
      ? await options.validateProposal({ output: {} /* missing required key */ })
      : { accepted: true as const };
    if (!validated.accepted) {
      return { status: "needs_human_review", attemptId: "attempt-1", reviewPayloadId: "r-1" };
    }
    return {
      status: "proposed",
      attemptId: "attempt-1",
      transport: "one_shot",
      parsed: { output: {} },
      rawTextLength: null,
      latencyMs: 1,
    };
  }
  return { broker: { propose: _propose } };
}

function makeService(
  broker: { propose: (req: unknown, opts?: BrokerCompatibilityOptions) => Promise<BrokerResult> },
  outputStore: SessionOutputStore,
  extra: { launcher?: WorkflowSessionLauncher } = {}
): OrchestratorService {
  return new OrchestratorService(
    fakeSelector(),
    broker as never,
    fakeRegistry(),
    extra.launcher,
    outputStore,
    extra.launcher ? fakeStepDispatch() : undefined
  );
}

/**
 * Seed a goal+template+run+step_run and a linked session.
 * The session is in `exited` status by default.
 */
function seedWorkflowWithSession(
  db: Database.Database,
  opts: {
    sessionStatus?: "exited" | "stopped" | "failed";
    failureReason?: string;
    workflowStepRunId?: string | null;
    stepRunStatus?: string;
    goalProvider?: string | null;
    goalModel?: string | null;
    crashRetries?: number;
    selectedOperatorId?: string | null;
    selectedModelId?: string | null;
  } = {}
): {
  sessionId: string;
  goalId: string;
  runId: string;
  stepRunId: string;
} {
  const sessionId = "sess-1";
  const goalId = "goal-1";
  const runId = "run-1";
  const stepRunId = "step-1";
  const sessionStatus = opts.sessionStatus ?? "exited";
  const workflowStepRunId =
    opts.workflowStepRunId === undefined ? stepRunId : opts.workflowStepRunId;
  const stepRunStatus = opts.stepRunStatus ?? "active";
  const provider = opts.goalProvider === undefined ? PROVIDER : opts.goalProvider;
  const model = opts.goalModel === undefined ? MODEL : opts.goalModel;
  const crashRetries = opts.crashRetries ?? 0;
  const selectedOperatorId = opts.selectedOperatorId ?? null;
  const selectedModelId = opts.selectedModelId ?? null;

  const step = makeStep({
    id: "plan",
    ordinal: 0,
    name: "Plan",
    instructions: "Plan the work.",
    outputSchema: [{ key: "problem", type: "string", required: true }],
  });

  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model)
     VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, ?, ?)`
  ).run(goalId, NOW, NOW, provider, model);

  db.prepare(
    `INSERT INTO workspaces (id, goal_id, name, path, workspace_type, git_probe, attached_at)
     VALUES ('ws-1', ?, 'main', '/tmp/repo', 'git', 'ok', ?)`
  ).run(goalId, NOW);

  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)`
  ).run(JSON.stringify([step]), NOW, NOW);

  db.prepare(
    `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at)
     VALUES (?, ?, 'orca/engineering', 1, 'active', ?, NULL, ?, NULL)`
  ).run(runId, goalId, stepRunId, NOW);

  db.prepare(
    `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at,
       fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at, crash_retries)
     VALUES (?, ?, ?, ?, 0, 1, ?, '[]', '[]', NULL, ?, NULL, 'fp-1', ?, NULL, ?, ?, ?)`
  ).run(
    stepRunId,
    goalId,
    runId,
    step.id,
    stepRunStatus,
    NOW,
    selectedOperatorId,
    selectedModelId,
    selectedOperatorId ? NOW : null,
    crashRetries
  );

  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, failure_reason, workflow_step_run_id)
     VALUES (?, ?, 'ws-1', 'claude-code', 'Session', ?, ?, ?, ?)`
  ).run(sessionId, goalId, sessionStatus, NOW, opts.failureReason ?? null, workflowStepRunId);

  return { sessionId, goalId, runId, stepRunId };
}

function artifactCount(db: Database.Database, type: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE type = ?")
      .get(type) as { c: number }
  ).c;
}

function getArtifact(db: Database.Database, type: string) {
  return db
    .prepare("SELECT * FROM workflow_artifacts WHERE type = ?")
    .get(type) as Record<string, unknown> | undefined;
}

function isRunBlocked(db: Database.Database, runId: string): boolean {
  const row = db
    .prepare("SELECT status FROM workflow_runs WHERE id = ?")
    .get(runId) as { status: string } | undefined;
  return row?.status === "blocked";
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService.onWorkflowSessionCompleted", () => {
  it("parse path: session tail contains valid orca-output block → artifact created with source=agent and linkedSessionId", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedWorkflowWithSession(db);

    // Build a tail that contains a valid orca-output block
    const orcaOutput = JSON.stringify({ problem: "The system is too slow." });
    const tailText = `\nSome output here\n\`\`\`orca-output\n${orcaOutput}\n\`\`\`\n`;

    const outputStore = fakeOutputStore((id) =>
      id === sessionId ? snapshotWithText(sessionId, tailText) : emptySnapshot(id)
    );
    const { broker } = fakeSynthesisBroker({ problem: "The system is too slow." });
    const service = makeService(broker, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(artifactCount(db, "step_output")).toBe(1);
    const artifact = getArtifact(db, "step_output")!;
    expect(artifact.source).toBe("agent");
    expect(artifact.linked_session_id).toBe(sessionId);
    expect(artifact.step_run_id).toBe(stepRunId);
    expect(artifact.workflow_run_id).toBe(runId);

    // With only one step, auto-advance should produce a mark_run_complete decision
    const decisions = db
      .prepare("SELECT decision_type FROM workflow_decisions ORDER BY rowid DESC LIMIT 1")
      .get() as { decision_type: string } | undefined;
    expect(decisions?.decision_type).toBe("mark_run_complete");
  });

  it("synthesize path: no orca-output block, broker returns valid output → artifact created with source=orchestrator", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedWorkflowWithSession(db);

    // Tail with no orca-output block
    const outputStore = fakeOutputStore((id) =>
      snapshotWithText(id, "Just plain output, no orca block.")
    );
    const { broker } = fakeSynthesisBroker({ problem: "Plain output synthesis." });
    const service = makeService(broker, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(artifactCount(db, "step_output")).toBe(1);
    const artifact = getArtifact(db, "step_output")!;
    expect(artifact.source).toBe("orchestrator");
    expect(artifact.linked_session_id).toBe(sessionId);
  });

  it("synthesize twice invalid: broker returns schema-invalid twice → run blocked, reason matches /schema/i", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId } = seedWorkflowWithSession(db);

    const outputStore = fakeOutputStore();
    const { broker } = fakeAlwaysInvalidBroker();
    const service = makeService(broker, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(isRunBlocked(db, runId)).toBe(true);
    const decision = db
      .prepare("SELECT reason FROM workflow_decisions WHERE decision_type = 'block_run' LIMIT 1")
      .get() as { reason: string } | undefined;
    expect(decision?.reason).toMatch(/schema/i);
    expect(artifactCount(db, "step_output")).toBe(0);
  });

  it("session.failed under crash cap → respawns same step, run NOT blocked, broker NOT called", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedWorkflowWithSession(db, {
      sessionStatus: "failed",
      failureReason: "oom killed",
      selectedOperatorId: "agent:claude-code",
      selectedModelId: "claude-haiku-4-5",
    });

    const brokerSpy = vi.fn();
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({
      sessionId: "respawn-1",
    }));
    const outputStore = fakeOutputStore();
    const service = makeService({ propose: brokerSpy }, outputStore, {
      launcher: { launch },
    });

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    // Respawned the same step.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(launch).mock.calls[0][0]).toMatchObject({
      workflowStepRunId: stepRunId,
    });

    // Run stays active; no block, no synthesis.
    expect(isRunBlocked(db, runId)).toBe(false);
    expect(brokerSpy).not.toHaveBeenCalled();
    expect(artifactCount(db, "step_output")).toBe(0);

    // crash_retries incremented to 1.
    const retries = (
      db
        .prepare("SELECT crash_retries AS c FROM workflow_step_runs WHERE id = ?")
        .get(stepRunId) as { c: number }
    ).c;
    expect(retries).toBe(1);
  });

  it("session.failed at crash cap → posts escalation message, no respawn", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, stepRunId } = seedWorkflowWithSession(db, {
      sessionStatus: "failed",
      failureReason: "oom killed",
      crashRetries: 2, // this failure → 3 = cap
      selectedOperatorId: "agent:claude-code",
      selectedModelId: "claude-haiku-4-5",
    });

    const brokerSpy = vi.fn();
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({
      sessionId: "respawn-1",
    }));
    const outputStore = fakeOutputStore();
    const service = makeService({ propose: brokerSpy }, outputStore, {
      launcher: { launch },
    });

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(launch).not.toHaveBeenCalled();
    expect(brokerSpy).not.toHaveBeenCalled();
    expect(artifactCount(db, "step_output")).toBe(0);

    // crash_retries hit the cap.
    const retries = (
      db
        .prepare("SELECT crash_retries AS c FROM workflow_step_runs WHERE id = ?")
        .get(stepRunId) as { c: number }
    ).c;
    expect(retries).toBe(3);

    // Escalation message posted to orchestrator chat.
    const msg = db
      .prepare(
        "SELECT body FROM orchestrator_messages WHERE goal_id = ? AND role = 'orchestrator' LIMIT 1"
      )
      .get(goalId) as { body: string } | undefined;
    expect(msg?.body).toMatch(/crashed 3 times/i);
    expect(msg?.body).toMatch(/manual intervention/i);
  });

  it("session.stopped: user-requested stop → run blocked, broker NOT called", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId } = seedWorkflowWithSession(db, {
      sessionStatus: "stopped",
      failureReason: "user stopped",
    });

    const brokerSpy = vi.fn();
    const outputStore = fakeOutputStore();
    const service = makeService({ propose: brokerSpy }, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(isRunBlocked(db, runId)).toBe(true);
    expect(brokerSpy).not.toHaveBeenCalled();
    expect(artifactCount(db, "step_output")).toBe(0);

    const decision = db
      .prepare("SELECT reason FROM workflow_decisions WHERE decision_type = 'block_run' LIMIT 1")
      .get() as { reason: string } | undefined;
    expect(decision?.reason).toMatch(/stopped/i);
  });

  it("non-workflow session: session with workflow_step_run_id = null → no-op, no artifact", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedWorkflowWithSession(db, {
      workflowStepRunId: null,
    });

    const brokerSpy = vi.fn();
    const outputStore = fakeOutputStore();
    const service = makeService({ propose: brokerSpy }, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    expect(artifactCount(db, "step_output")).toBe(0);
    expect(brokerSpy).not.toHaveBeenCalled();
  });

  it("already has step_output: idempotent → no new artifact, but still tries to advance", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedWorkflowWithSession(db);

    // Pre-create a step_output artifact
    db.prepare(
      `INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at)
       VALUES ('art-pre', ?, ?, ?, 'step_output', 'Plan', '{"problem":"pre-existing"}', 'agent', NULL, NULL, NULL, ?)`
    ).run(goalId, runId, stepRunId, NOW);

    const brokerSpy = vi.fn();
    const outputStore = fakeOutputStore();
    const service = makeService({ propose: brokerSpy }, outputStore);

    await service.onWorkflowSessionCompleted(
      db,
      () => NOW,
      { sessionId, goalId },
      { bus, idFactory }
    );

    // Still only one artifact
    expect(artifactCount(db, "step_output")).toBe(1);
    expect(brokerSpy).not.toHaveBeenCalled();

    // But advance was attempted — mark_run_complete decision should be recorded
    const decisions = db
      .prepare("SELECT decision_type FROM workflow_decisions ORDER BY rowid DESC LIMIT 1")
      .get() as { decision_type: string } | undefined;
    expect(decisions?.decision_type).toBe("mark_run_complete");
  });
});
