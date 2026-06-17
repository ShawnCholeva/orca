import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type {
  OperatorDescriptor,
  OperatorSelection,
  SessionOutputSnapshot,
} from "@orca/contracts";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { OrchestratorService, type StepDispatchCapabilities } from "./service.js";
import {
  cleanupHarness,
  NOW,
  seedSkillWorkflow,
  setupHarness,
  makeStep,
  fakeStepDispatch,
  fakeSelector,
  fakeRegistry,
  MODEL_OPERATOR_ID,
} from "./skill-step-test-helpers.js";
import type { SelectorInput } from "../operators/selector.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import type { OrchestratorAction } from "@orca/contracts";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { setSupervisionMode } from "../../settings/store.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import type { ProviderRecoveryCheckpoint } from "@orca/contracts";
import {
  OrchestratorProviderRecoveryInvalidTransitionError,
  OrchestratorProviderRecoveryNotFoundError,
} from "./service.js";

const AGENT_OPERATOR_ID = "agent:claude-code";

function agentOperatorDescriptor(): OperatorDescriptor {
  return {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: ["repo_navigation", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
}

function fakeAgentSelector(): Pick<{ select: (db: Database.Database, now: () => string, input: SelectorInput) => Promise<{ selection: OperatorSelection; source: "fallback" | "llm" }> }, "select"> {
  const result: OperatorSelection = {
    operatorId: AGENT_OPERATOR_ID,
    operatorKind: "agent",
    reason: "agent selected for this step",
    requiredCapabilities: [],
    alternativesConsidered: [],
    confidence: 1,
    requiresUserApproval: false,
  };
  return {
    async select() {
      return { selection: result, source: "fallback" };
    },
  };
}

function fakeBrokerNoop(): Pick<import("../orchestration-transport/broker.js").OrchestrationTransportBroker, "propose"> {
  return {
    async propose(request: unknown, options?: import("../orchestration-transport/broker.js").BrokerCompatibilityOptions) {
      if ((request as { kind?: string }).kind === "score_step_result") {
        const proposal = {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.8,
            instructionAdherence: 0.85,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "Ready for next step.",
          handoffReady: true,
        };
        const validated = options?.validateProposal
          ? await options.validateProposal(proposal)
          : { accepted: true as const, parsed: proposal };
        return {
          status: "proposed" as const,
          attemptId: "attempt-1",
          transport: "one_shot" as const,
          parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
            ? (validated as { parsed: unknown }).parsed
            : proposal,
          rawTextLength: null,
          latencyMs: 1,
        };
      }
      return {
        status: "proposed" as const,
        attemptId: "attempt-1",
        transport: "one_shot" as const,
        parsed: {},
        rawTextLength: null,
        latencyMs: 1,
      };
    },
  };
}

function makeLauncher(launchFn = vi.fn(async () => ({ sessionId: "sess-1" }))): WorkflowSessionLauncher & { mock: typeof launchFn } {
  return { launch: launchFn, mock: launchFn };
}

function makeAgentService(
  launcher: WorkflowSessionLauncher,
  workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">
): OrchestratorService {
  return new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    undefined,
    fakeStepDispatch(),
    undefined,
    undefined, // workerSpawn
    workerDeliver
  );
}

function fakeMediator(action: OrchestratorAction): Pick<OrchestratorMediator, "invoke"> {
  return {
    async invoke() {
      return action;
    },
  };
}

/** A mediator that records whether it was invoked (to assert deterministic short-circuit) */
function spyMediator(action: OrchestratorAction): Pick<OrchestratorMediator, "invoke"> & { calls: number } {
  const spy = { calls: 0 } as { calls: number; invoke: OrchestratorMediator["invoke"] };
  spy.invoke = (async () => {
    spy.calls += 1;
    return action;
  }) as OrchestratorMediator["invoke"];
  return spy as Pick<OrchestratorMediator, "invoke"> & { calls: number };
}

function recordingMediator(action: OrchestratorAction): Pick<OrchestratorMediator, "invoke"> & { inputs: unknown[] } {
  const recorder = { inputs: [] as unknown[] } as {
    inputs: unknown[];
    invoke: OrchestratorMediator["invoke"];
  };
  recorder.invoke = (async (input) => {
    recorder.inputs.push(input);
    return action;
  }) as OrchestratorMediator["invoke"];
  return recorder;
}

function makeJudgeService(
  mediator: Pick<OrchestratorMediator, "invoke">,
  workerDeliver: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">
): OrchestratorService {
  return new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    makeLauncher(),
    undefined,
    fakeStepDispatch(),
    mediator,
    undefined, // workerSpawn
    workerDeliver
  );
}

/** Mark the active step run as agent-selected and link a session to it */
function seedAgentSession(db: Database.Database, opts: { reviseAttempts?: number } = {}) {
  db.prepare(
    "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
  ).run();
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id = 'agent:claude-code', selected_provider_id = NULL, selected_model_id = 'claude-haiku-4-5', operator_selected_at = ?, revise_attempts = ? WHERE id = 'step-1'"
  ).run(NOW, opts.reviseAttempts ?? 0);
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-judge', 'goal-1', 'ws-1', 'claude-code', 'Session', 'running', ?, 'step-1')"
  ).run(NOW);
}

function stepOutputCount(db: Database.Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE step_run_id = 'step-1' AND type = 'step_output'")
      .get() as { c: number }
  ).c;
}

function readPersistedStepResult(db: Database.Database, stepRunId: string) {
  const row = db
    .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { step_result_json: string | null };
  expect(row.step_result_json).toBeTruthy();
  return JSON.parse(row.step_result_json!);
}

function workerExitOutputStore(sessionId: string): SessionOutputStore {
  const text = '```orca-output\n{"problem":"Recovered output."}\n```';
  const snapshot: SessionOutputSnapshot = {
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
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn(() => snapshot),
  };
}

function seedWorkerExitRecovery(db: Database.Database): { sessionId: string } {
  seedSkillWorkflow(db);
  seedWorkspace(db);
  db.prepare(
    "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-sonnet-4-6' WHERE id = 'goal-1'"
  ).run();
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id = 'agent:claude-code', selected_model_id = 'claude-haiku-4-5', operator_selected_at = ? WHERE id = 'step-1'"
  ).run(NOW);
  const sessionId = "sess-worker-exit";
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, 'goal-1', 'ws-1', 'claude-code', 'Worker', 'exited', ?, 'step-1')"
  ).run(sessionId, NOW);
  return { sessionId };
}

function makeWorkerExitRecoveryService(
  sessionId: string,
  shadowAsk: ShadowAsk
): OrchestratorService {
  const shadowOnlyDispatch: StepDispatchCapabilities = {
    ...fakeStepDispatch(),
    resolveMode: (adapterId) => ({ adapterId, mode: "shadow_session", fallbacks: [] }),
  };
  return new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    makeLauncher(),
    workerExitOutputStore(sessionId),
    shadowOnlyDispatch,
    undefined,
    undefined,
    undefined,
    undefined,
    shadowAsk
  );
}

function orchestratorMessageCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM orchestrator_messages WHERE goal_id = 'goal-1'").get() as { c: number }
  ).c;
}

function lastOrchestratorMessageBody(db: Database.Database): string {
  return (
    db
      .prepare(
        "SELECT body FROM orchestrator_messages WHERE goal_id = 'goal-1' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get() as { body: string }
  ).body;
}

/** Seed a workflow with an agent-capable template step */
function setupAgentStepRun(db: Database.Database, opts: { guardrailsJson?: string } = {}) {
  const step = makeStep({
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Write the implementation.",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [
      { adapterId: "claude-code", modelId: "claude-haiku-4-5" },
      { adapterId: "codex", modelId: "gpt-5-codex" },
    ],
  });

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run("goal-1", NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, ?, ?, ?)"
  ).run(JSON.stringify([step]), opts.guardrailsJson ?? "[]", NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);

  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-1', 'goal-1', 'run-1', ?, ?, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1', NULL, NULL, NULL, NULL)"
  ).run(step.id, step.ordinal, NOW);
}

/** Insert a minimal workspace so sessions FK is satisfied */
function seedWorkspace(db: Database.Database) {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, goal_id, name, path, workspace_type, git_probe, attached_at) VALUES ('ws-1', 'goal-1', 'main', '/tmp/repo', 'git', 'ok', ?)"
  ).run(NOW);
}

function recommendationCount(db: Database.Database, type?: string): number {
  if (type) {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM recommendations WHERE type = ?")
        .get(type) as { c: number }
    ).c;
  }
  return (db.prepare("SELECT COUNT(*) AS c FROM recommendations").get() as { c: number }).c;
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService agent step", () => {
  it("scores worker-exit recovery through the shadow session and advances", async () => {
    const { db } = setupHarness();
    const { sessionId } = seedWorkerExitRecovery(db);
    const ask = vi.fn<ShadowAsk["ask"]>().mockResolvedValue({
      text: JSON.stringify({
        successScore: 0.73,
        quality: {
          outputCompleteness: 0.75,
          outputCorrectness: 0.7,
          instructionAdherence: 0.8,
          downstreamReadiness: 0.7,
          riskLevel: 0.25,
        },
        reason: "Recovered output is usable.",
        handoffReady: true,
      }),
    });
    const service = makeWorkerExitRecoveryService(sessionId, { ask });

    await service.onWorkflowSessionCompleted(db, () => NOW, {
      sessionId,
      goalId: "goal-1",
    });

    expect(ask).toHaveBeenCalledOnce();
    expect(readPersistedStepResult(db, "step-1")).toMatchObject({
      evaluationStatus: "scored",
      successScore: 0.73,
    });
    const run = db
      .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string };
    expect(run.current_step_run_id).not.toBe("step-1");
    expect(
      db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?").get(run.current_step_run_id)
    ).toMatchObject({ status: "active" });
  });

  it("advances worker-exit recovery when the shadow scoring turn rejects", async () => {
    const { db } = setupHarness();
    const { sessionId } = seedWorkerExitRecovery(db);
    const ask = vi.fn<ShadowAsk["ask"]>().mockRejectedValue(new Error("shadow unavailable"));
    const service = makeWorkerExitRecoveryService(sessionId, { ask });

    await service.onWorkflowSessionCompleted(db, () => NOW, {
      sessionId,
      goalId: "goal-1",
    });

    expect(readPersistedStepResult(db, "step-1")).toMatchObject({
      evaluationStatus: "failed",
      outcome: {
        handoffReady: false,
      },
    });
    const run = db
      .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string };
    expect(run.current_step_run_id).not.toBe("step-1");
    expect(
      db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?").get(run.current_step_run_id)
    ).toMatchObject({ status: "active" });
  });

  it("blocks a preselected direct model operator when its adapter is shadow-only", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      steps: [makeStep()],
      selectedOperatorId: MODEL_OPERATOR_ID,
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    const propose = vi.fn(fakeBrokerNoop().propose);
    const shadowOnlyDispatch: StepDispatchCapabilities = {
      ...fakeStepDispatch(),
      resolveMode: (adapterId) => ({ adapterId, mode: "shadow_session", fallbacks: [] }),
    };
    const service = new OrchestratorService(
      fakeSelector(),
      { propose },
      fakeRegistry(),
      makeLauncher(),
      undefined,
      shadowOnlyDispatch
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    expect(propose).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = 'run-1'").get()
    ).toMatchObject({
      status: "blocked",
      blocked_reason: expect.stringMatching(/shadow-only|direct model/i),
    });
  });

  it("scores and persists step_result after model step completion", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      steps: [
        makeStep({
          id: "plan",
          ordinal: 0,
          name: "Plan",
          instructions: "Plan the work.",
          outputSchema: [{ key: "problem", type: "string", required: true }],
        }),
      ],
      selectedOperatorId: MODEL_OPERATOR_ID,
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-sonnet-4-6' WHERE id = 'goal-1'"
    ).run();

    const propose = vi.fn(async (request: unknown, options?: import("../orchestration-transport/broker.js").BrokerCompatibilityOptions) => {
      if ((request as { kind?: string }).kind === "score_step_result") {
        const proposal = {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.8,
            instructionAdherence: 0.85,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "Ready for next step.",
          handoffReady: true,
        };
        const validated = options?.validateProposal
          ? await options.validateProposal(proposal)
          : { accepted: true as const, parsed: proposal };
        return {
          status: "proposed" as const,
          attemptId: "score-attempt",
          transport: "one_shot" as const,
          parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
            ? (validated as { parsed: unknown }).parsed
            : proposal,
          rawTextLength: null,
          latencyMs: 1,
        };
      }
      const raw = {
        action: "complete" as const,
        output: { problem: "solved" },
        completion: {
          confidence: "high" as const,
          assumptions: [],
          openQuestions: [],
          whyComplete: "Done.",
        },
      };
      const validated = options?.validateProposal
        ? await options.validateProposal(raw)
        : { accepted: true as const, parsed: raw };
      return {
        status: "proposed" as const,
        attemptId: "skill-attempt",
        transport: "one_shot" as const,
        parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
          ? (validated as { parsed: unknown }).parsed
          : raw,
        rawTextLength: null,
        latencyMs: 1,
      };
    });
    const service = new OrchestratorService(
      fakeSelector(),
      { propose },
      fakeRegistry(),
      makeLauncher()
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    expect(readPersistedStepResult(db, "step-1")).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "scored",
    });
  });

  it("selects agent operator, evaluates approval guardrail, emits launch_workflow_session recommendation, does NOT call launcher", async () => {
    const { db, bus, idFactory } = setupHarness();

    // Guardrail requires approval for launch_workflow_session
    const guardrails = JSON.stringify([
      {
        id: "g-1",
        kind: "approval_required",
        label: "Require approval to launch sessions",
        configJson: { actions: ["launch_workflow_session"] },
      },
    ]);
    setupAgentStepRun(db, { guardrailsJson: guardrails });

    const launchFn = vi.fn(async () => ({ sessionId: "sess-1" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    // First call: selects operator
    const first = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(first.decision.decisionType).toBe("select_operator");
    expect(first.recommendationIds).toHaveLength(0);

    // Second call: agent decision → recommendation emitted, launcher NOT called
    const second = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(second.recommendationIds).toHaveLength(1);

    const rec = db
      .prepare("SELECT type, proposed_action_json FROM recommendations WHERE id = ?")
      .get(second.recommendationIds[0]) as { type: string; proposed_action_json: string };
    expect(rec.type).toBe("launch_workflow_session");
    const action = JSON.parse(rec.proposed_action_json) as { kind: string; operatorId: string };
    expect(action.kind).toBe("launch_workflow_session");
    expect(action.operatorId).toBe(AGENT_OPERATOR_ID);

    expect(launchFn).not.toHaveBeenCalled();
  });

  it("is idempotent: subsequent calls with existing unaccepted launch recommendation return noop, no new recommendations", async () => {
    const { db, bus, idFactory } = setupHarness();

    const guardrails = JSON.stringify([
      {
        id: "g-1",
        kind: "approval_required",
        label: "Require approval to launch sessions",
        configJson: { actions: ["launch_workflow_session"] },
      },
    ]);
    setupAgentStepRun(db, { guardrailsJson: guardrails });

    const launcher = makeLauncher();
    const service = makeAgentService(launcher);

    // Advance past operator selection
    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // First agent decision call: creates the recommendation
    const first = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(first.recommendationIds).toHaveLength(1);
    expect(recommendationCount(db, "launch_workflow_session")).toBe(1);

    // Second agent decision call: recommendation already exists → noop, no new ones
    const second = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(second.recommendationIds).toHaveLength(0);
    // Still only one recommendation total
    expect(recommendationCount(db, "launch_workflow_session")).toBe(1);
  });

  it("direct-launch path: no approval guardrail → calls launcher, does NOT emit recommendation", async () => {
    const { db, bus, idFactory } = setupHarness();

    // No guardrails → direct launch
    setupAgentStepRun(db, { guardrailsJson: "[]" });

    const launchFn = vi.fn(async () => ({ sessionId: "sess-1" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    // First call: selects operator
    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // Second call: direct launch
    const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(result.recommendationIds).toHaveLength(0);
    expect(launchFn).toHaveBeenCalledOnce();
    expect(launchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: "goal-1",
        workflowRunId: "run-1",
        workflowStepRunId: "step-1",
        operatorId: AGENT_OPERATOR_ID,
        operatorKind: "agent",
      })
    );
    expect(recommendationCount(db, "launch_workflow_session")).toBe(0);
  });

  it("does not re-launch while a session linked to the step is still running", async () => {
    const { db, bus, idFactory } = setupHarness();

    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-1" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    // First call: selects operator
    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // Simulate a session linked to step-1 being in running state (before the agent decision fires)
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-linked', 'goal-1', 'ws-1', 'claude-code', 'Session', 'running', ?, 'step-1')"
    ).run(NOW);

    // Call again — should noop, NOT call launcher
    const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(result.recommendationIds).toHaveLength(0);
    expect(launchFn).not.toHaveBeenCalled();
  });
});

describe("OrchestratorService.onAgentResponseDone (judgement loop)", () => {
  it("persists a model-scored result when the orchestrator approves with scoring", async () => {
    const { db, bus, idFactory } = setupHarness();
    const events: Array<{ type: string; payload: unknown }> = [];
    bus.subscribe((event) => events.push(event));
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({
        kind: "approve_step_complete",
        scoring: {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.85,
            instructionAdherence: 0.9,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "Output complete.",
          handoffReady: true,
        },
      }),
      deliver
    );
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    const result = readPersistedStepResult(db, "step-1");
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.82);
    expect(result.quality.outputCorrectness).toBe(0.85);
    expect(result.outcome.reason).toBe("Output complete.");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM activities WHERE step_run_id = 'step-1' AND source_kind = 'step_result'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      events.filter(
        (event) =>
          event.type === "activity.changed" &&
          (event.payload as { stepRunId?: string }).stepRunId === "step-1"
      )
    ).toHaveLength(1);
  });

  it("ask_user posts a chat message carrying an interactive pending_question", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({
        kind: "ask_user",
        body: "Step 1 agent needs a decision before it can continue.",
        questions: [
          {
            header: "State",
            question: "Which did you mean by 'state'?",
            multiSelect: false,
            options: [
              { label: "Active / Archived", description: "Group by goal status." },
              { label: "Running / Idle", description: "Group by active workflow run." },
            ],
          },
        ],
      }),
      deliver
    );

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText: "I need a decision from the user." },
      { bus, idFactory }
    );

    const row = db
      .prepare(
        "SELECT body, pending_question FROM orchestrator_messages WHERE goal_id = 'goal-1' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get() as { body: string; pending_question: string | null };
    expect(row.body).toContain("needs a decision");
    expect(row.pending_question).toBeTruthy();
    const pq = JSON.parse(row.pending_question!);
    expect(pq.questions[0].options).toHaveLength(2);
    expect(pq.questionId).toBeTruthy();
    expect(pq.toolUseId).toBeTruthy();
    // The step agent was not told to advance — it stays paused on the decision.
    expect(deliver).not.toHaveBeenCalled();
  });

  it("supervised: holds at checkpoint — no result, stash set, activity paused", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "supervised", NOW);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({
        kind: "approve_step_complete",
        scoring: {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.85,
            instructionAdherence: 0.9,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "ok",
          handoffReady: true,
        },
      }),
      deliver
    );
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    const row = db
      .prepare(
        "SELECT step_result_json, pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'"
      )
      .get() as { step_result_json: string | null; pending_completion_json: string | null };
    expect(row.step_result_json).toBeNull();
    expect(row.pending_completion_json).not.toBeNull();
    const act = db
      .prepare(
        "SELECT status, source_kind FROM activities WHERE step_run_id = 'step-1' ORDER BY turn_ordinal DESC LIMIT 1"
      )
      .get() as { status: string; source_kind: string };
    expect(act.status).toBe("paused_for_input");
    expect(act.source_kind).toBe("step_confirmation_pending");
  });

  it("unsupervised: terminates and advances immediately (writes scored result, no stash)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({
        kind: "approve_step_complete",
        scoring: {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.85,
            instructionAdherence: 0.9,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "ok",
          handoffReady: true,
        },
      }),
      deliver
    );
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    const result = readPersistedStepResult(db, "step-1");
    expect(result.evaluationStatus).toBe("scored");
    const row = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { pending_completion_json: string | null };
    expect(row.pending_completion_json).toBeNull();
  });

  it("approve_step_complete: writes step_output artifact and recommends run completion", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), deliver);

    // Schema-valid step-complete block → mediator returns approve.
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    // step_output artifact written for the step
    expect(stepOutputCount(db)).toBe(1);
    // single terminal step → commitAdvanceOrComplete recommends completing the run
    expect(recommendationCount(db, "complete_workflow_run")).toBe(1);
    expect(readPersistedStepResult(db, "step-1")).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "failed",
      outcome: {
        reason: "step result evaluation failed: approval omitted scoring proposal",
      },
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("commits a ledger version from the step completion envelope", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const service = makeJudgeService(
      fakeMediator({ kind: "approve_step_complete" }),
      vi.fn(async () => "delivered" as const)
    );

    const envelope = {
      output: { result: "implemented" },
      ledger_updates: [
        {
          operation: "create",
          record_id: "local:a",
          record_type: "requirement",
          status: "open",
          evidence_refs: [],
          note: "must support X",
        },
      ],
    };
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify(envelope) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    // step_output stores only the validated business output (not the envelope).
    expect(stepOutputCount(db)).toBe(1);
    const body = (
      db
        .prepare("SELECT body FROM workflow_artifacts WHERE step_run_id = 'step-1' AND type = 'step_output' LIMIT 1")
        .get() as { body: string }
    ).body;
    expect(JSON.parse(body)).toEqual({ result: "implemented" });

    const ledger = latestCommittedLedger(db, "run-1");
    expect(ledger.version).toBeGreaterThanOrEqual(1);
    const req = ledger.records.find((r) => r.recordType === "requirement");
    expect(req).toBeTruthy();
    expect(req!.status).toBe("open");
    expect(req!.note).toBe("must support X");
  });

  it("revises the step when ledger_updates are invalid (unknown canonical record)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const deliver = vi.fn(async (_sid: string, _text: string) => "delivered" as const);
    const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), deliver);

    // Valid output, but an update targeting a canonical id that doesn't exist.
    const envelope = {
      output: { result: "implemented" },
      ledger_updates: [
        {
          operation: "update",
          record_id: "REQ-doesnotexist",
          record_type: "requirement",
          status: "satisfied",
          evidence_refs: [],
          note: "",
        },
      ],
    };
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify(envelope) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    // No step_output, no advance, no ledger version committed; step is revised.
    expect(stepOutputCount(db)).toBe(0);
    expect(latestCommittedLedger(db, "run-1").version).toBe(0);
    const row = db
      .prepare("SELECT revise_attempts, step_result_json FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { revise_attempts: number; step_result_json: string | null };
    expect(row.revise_attempts).toBe(1);
    expect(row.step_result_json).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![1]).toContain("ledger_updates");
  });

  it("still completes a legacy step that emits a bare output (no ledger_updates)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "unsupervised", NOW);

    const service = makeJudgeService(
      fakeMediator({ kind: "approve_step_complete" }),
      vi.fn(async () => "delivered" as const)
    );

    // Bare output (no envelope wrapper) — the legacy engineering template shape.
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(stepOutputCount(db)).toBe(1);
    const body = (
      db
        .prepare("SELECT body FROM workflow_artifacts WHERE step_run_id = 'step-1' AND type = 'step_output' LIMIT 1")
        .get() as { body: string }
    ).body;
    expect(JSON.parse(body)).toEqual({ result: "implemented" });
    // A ledger version is committed even with no updates (monotonic versioning).
    const ledger = latestCommittedLedger(db, "run-1");
    expect(ledger.version).toBe(1);
    expect(ledger.records).toHaveLength(0);
  });

  it("revise_step under cap: bumps revise_attempts to 1 and sends feedback to the agent", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db, { reviseAttempts: 0 });

    const deliver = vi.fn(async (_sid: string, _text: string) => "delivered" as const);
    // Mediator should NOT be consulted: schema-invalid block makes judgement return revise deterministically.
    const mediator = spyMediator({ kind: "approve_step_complete" });
    const service = makeJudgeService(mediator, deliver);

    // Schema-INVALID block (missing required `result`) → deterministic revise.
    const responseText =
      "Attempt.\n```orca:step-complete\n" + JSON.stringify({ wrong: "field" }) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(mediator.calls).toBe(0);
    const row = db
      .prepare("SELECT revise_attempts FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { revise_attempts: number };
    expect(row.revise_attempts).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [sessionId, text] = deliver.mock.calls[0]!;
    expect(sessionId).toBe("sess-judge");
    expect(text).toContain("schema validation");
    expect(stepOutputCount(db)).toBe(0);
  });

  it("revise_step at cap: posts an orchestrator escalation message and does NOT message the agent", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    // Pre-set to REVISE_CAP - 1 so the next attempt reaches the cap.
    seedAgentSession(db, { reviseAttempts: 2 });

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(spyMediator({ kind: "approve_step_complete" }), deliver);

    const responseText =
      "Attempt.\n```orca:step-complete\n" + JSON.stringify({ wrong: "field" }) + "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    const row = db
      .prepare("SELECT revise_attempts FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { revise_attempts: number };
    expect(row.revise_attempts).toBe(3);
    expect(orchestratorMessageCount(db)).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("OrchestratorService.onUserMessage (user_message trigger)", () => {
  it("forward_to_agent: relays the translated text into the live agent session", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({ kind: "forward_to_agent", translated: "please add tests" }),
      deliver
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "add tests" },
      { bus, idFactory }
    );

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("sess-judge", "please add tests");
    expect(orchestratorMessageCount(db)).toBe(0);
  });

  it("forward_to_agent with no live session: posts a 'no session' acknowledgment instead of silently dropping", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    // NOTE: no seedAgentSession() — current step has no live session.
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
    ).run();

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({ kind: "forward_to_agent", translated: "please add tests" }),
      deliver
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "add tests" },
      { bus, idFactory }
    );

    expect(deliver).not.toHaveBeenCalled();
    expect(orchestratorMessageCount(db)).toBe(1);
    expect(lastOrchestratorMessageBody(db)).toMatch(/no step agent session/i);
  });

  it("forward_to_agent: posts a visible error when delivery reports no running session", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const deliver = vi.fn(async () => "no_session" as const);
    const service = makeJudgeService(
      fakeMediator({ kind: "forward_to_agent", translated: "please add tests" }),
      deliver
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "add tests" },
      { bus, idFactory }
    );

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(orchestratorMessageCount(db)).toBe(1);
    expect(lastOrchestratorMessageBody(db)).toMatch(/step agent session is not running/i);
  });

  it("answer_user_directly: posts an orchestrator message and does NOT message the agent", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({ kind: "answer_user_directly", body: "sure" }),
      deliver
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "is this done?" },
      { bus, idFactory }
    );

    expect(orchestratorMessageCount(db)).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("invokes the mediator with the goal orchestrator model, not the step agent model", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/openai', orchestrator_model = 'gpt-5.4-mini' WHERE id = 'goal-1'"
    ).run();

    const mediator = recordingMediator({ kind: "answer_user_directly", body: "sure" });
    const service = makeJudgeService(mediator, vi.fn());

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "what model are you?" },
      { bus, idFactory }
    );

    expect(mediator.inputs[0]).toMatchObject({
      adapterId: "codex",
      modelId: "gpt-5.4-mini",
    });
  });
});

/** Seed a run whose current step (step-1, ordinal 0) is the FIRST step, unselected. */
function setupFirstStepRun(db: Database.Database) {
  const step = makeStep({
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Write the implementation.",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  });

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run("goal-1", NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify([step]), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-1', 'goal-1', 'run-1', ?, 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1', NULL, NULL, NULL, NULL)"
  ).run(step.id, NOW);
}

/**
 * Seed a 2-step run with step-1 active (ordinal 0) holding a valid step_output,
 * and step-2 (ordinal 1) already created (pending) so commitAdvanceOrComplete
 * advances currentStepRunId to it.
 */
function setupTwoStepRunWithOutput(db: Database.Database) {
  const step1 = makeStep({
    id: "plan",
    ordinal: 0,
    name: "Plan",
    instructions: "Plan the work.",
    outputSchema: [{ key: "plan", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  });
  const step2 = makeStep({
    id: "build",
    ordinal: 1,
    name: "Build",
    instructions: "Implement the plan.",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  });

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run("goal-1", NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify([step1, step2]), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  // step-1: active, selected, with step_output. step-2 is created by
  // advanceToNextStep (the usecase generates a fresh UUID for the next step run).
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-1', 'goal-1', 'run-1', ?, 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(step1.id, NOW, NOW);
  // step_output artifact on step-1
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-1', 'goal-1', 'run-1', 'step-1', 'step_output', 'Plan', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ plan: "do the thing", _completion: {} }), NOW);
}

describe("OrchestratorService.startWorkflowFirstStep / advanceToNextStep", () => {
  it("startWorkflowFirstStep persists selection + invokes launcher", async () => {
    const { db } = setupHarness();
    setupFirstStepRun(db);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-x" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    await service.startWorkflowFirstStep(db, () => NOW, "run-1");

    const row = db
      .prepare(
        "SELECT selected_operator_id, selected_model_id FROM workflow_step_runs WHERE id = 'step-1'"
      )
      .get() as { selected_operator_id: string | null; selected_model_id: string | null };
    expect(row.selected_operator_id).toBe("agent:claude-code");
    expect(row.selected_model_id).toBe("claude-haiku-4-5");

    expect(launchFn).toHaveBeenCalledOnce();
    expect(launchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "agent:claude-code",
        operatorKind: "agent",
        objective: expect.stringContaining("Write the implementation."),
      })
    );
    expect(launchFn).toHaveBeenCalledWith(
      expect.objectContaining({ objective: expect.stringContaining("orca:step-complete") })
    );
  });

  it("startWorkflowFirstStep delivers the composed objective to the launched session", async () => {
    const { db } = setupHarness();
    setupFirstStepRun(db);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-x" }));
    const deliver = vi.fn(async (_sid: string, _text: string) => "delivered" as const);
    const service = makeAgentService(makeLauncher(launchFn), deliver);

    await service.startWorkflowFirstStep(db, () => NOW, "run-1");

    expect(deliver).toHaveBeenCalledOnce();
    const [sessionId, prompt] = deliver.mock.calls[0]!;
    expect(sessionId).toBe("sess-x");
    expect(prompt).toContain("Write the implementation.");
    expect(prompt).toContain("orca:step-complete");
  });

  it("startWorkflowFirstStep contains launcher failures and posts a visible message", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupFirstStepRun(db);

    const launchFn = vi.fn(async () => {
      throw new Error("PTY spawn failed: spawn_failed");
    });
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    await expect(
      service.startWorkflowFirstStep(db, () => NOW, "run-1", { bus, idFactory })
    ).resolves.toBeUndefined();

    const row = db
      .prepare("SELECT body FROM orchestrator_messages WHERE goal_id = 'goal-1' AND role = 'orchestrator'")
      .get() as { body: string } | undefined;
    expect(launchFn).toHaveBeenCalledOnce();
    expect(row?.body).toMatch(/unable to start the step agent/i);
    expect(row?.body).toContain("spawn_failed");
  });

  it("startWorkflowFirstStep prefers Codex worker when the goal orchestrator is OpenAI", async () => {
    const { db } = setupHarness();
    setupFirstStepRun(db);
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/openai', orchestrator_model = 'gpt-5.4-mini' WHERE id = 'goal-1'"
    ).run();
    const row = db.prepare("SELECT steps_json FROM workflow_templates WHERE id = 'orca/engineering'").get() as { steps_json: string };
    const steps = JSON.parse(row.steps_json) as Array<{ id: string; agentPreference: Array<{ adapterId: string; modelId: string }> }>;
    steps[0]!.agentPreference = [
      { adapterId: "claude-code", modelId: "claude-haiku-4-5" },
      { adapterId: "codex", modelId: "gpt-5.4-mini" },
    ];
    db.prepare("UPDATE workflow_templates SET steps_json = ? WHERE id = 'orca/engineering'").run(JSON.stringify(steps));

    const launchFn = vi.fn(async () => ({ sessionId: "sess-codex" }));
    const stepDispatch: StepDispatchCapabilities = {
      isAdapterReady: async (adapterId) => adapterId === "claude-code" || adapterId === "codex",
      supportsModel: (adapterId, modelId) =>
        (adapterId === "claude-code" && modelId === "claude-haiku-4-5") ||
        (adapterId === "codex" && modelId === "gpt-5.4-mini"),
      resolveMode: (adapterId) => ({ adapterId, mode: "shadow_session", fallbacks: [] }),
    };
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(launchFn),
      undefined,
      stepDispatch
    );

    await service.startWorkflowFirstStep(db, () => NOW, "run-1");

    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "agent:codex" }));
    const selected = db
      .prepare("SELECT selected_operator_id, selected_model_id FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { selected_operator_id: string; selected_model_id: string };
    expect(selected).toMatchObject({
      selected_operator_id: "agent:codex",
      selected_model_id: "gpt-5.4-mini",
    });
  });

  it("advanceToNextStep spawns the next step's agent for an intermediate step", async () => {
    const { db } = setupHarness();
    setupTwoStepRunWithOutput(db);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-x" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    await service.advanceToNextStep(db, () => NOW, "run-1");

    const run = db
      .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string };
    expect(run.current_step_run_id).not.toBe("step-1");

    // the advanced step run is for the second template step ("build")
    const nextStep = db
      .prepare("SELECT step_template_id FROM workflow_step_runs WHERE id = ?")
      .get(run.current_step_run_id) as { step_template_id: string };
    expect(nextStep.step_template_id).toBe("build");

    expect(launchFn).toHaveBeenCalledOnce();
    expect(launchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "agent:claude-code",
        workflowStepRunId: run.current_step_run_id,
      })
    );
  });

  it("respawnStepAgent re-launches the active step's agent", async () => {
    const { db } = setupHarness();
    setupFirstStepRun(db);
    // Mark the active step as already operator-selected (as it would be after a
    // prior boot launched it).
    db.prepare(
      "UPDATE workflow_step_runs SET selected_operator_id = 'agent:claude-code', selected_provider_id = NULL, selected_model_id = 'claude-haiku-4-5', operator_selected_at = ? WHERE id = 'step-1'"
    ).run(NOW);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-respawn" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    await service.respawnStepAgent(db, () => NOW, "run-1", "step-1");

    expect(launchFn).toHaveBeenCalledOnce();
    expect(launchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: "run-1",
        workflowStepRunId: "step-1",
        operatorId: "agent:claude-code",
        operatorKind: "agent",
      })
    );
  });

  it("advanceToNextStep on the terminal step yields complete_workflow_run, no further spawn", async () => {
    const { db } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" }); // single terminal step (ordinal 0)
    // give the terminal step a step_output so commitAdvanceOrComplete completes
    db.prepare(
      "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-final', 'goal-1', 'run-1', 'step-1', 'step_output', 'Implement', ?, 'orchestrator', NULL, NULL, NULL, ?)"
    ).run(JSON.stringify({ result: "done", _completion: {} }), NOW);

    const launchFn = vi.fn(async () => ({ sessionId: "sess-x" }));
    const launcher = makeLauncher(launchFn);
    const service = makeAgentService(launcher);

    await service.advanceToNextStep(db, () => NOW, "run-1");

    expect(recommendationCount(db, "complete_workflow_run")).toBe(1);
    expect(launchFn).not.toHaveBeenCalled();
  });
});

describe("OrchestratorService.confirmStep", () => {
  it("continues a paused supervised step (writes result, clears stash)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "supervised", NOW);
    const deliver = vi.fn(async () => "delivered" as const);
    const service = makeJudgeService(
      fakeMediator({
        kind: "approve_step_complete",
        scoring: {
          successScore: 0.82,
          quality: {
            outputCompleteness: 0.8,
            outputCorrectness: 0.85,
            instructionAdherence: 0.9,
            downstreamReadiness: 0.8,
            riskLevel: 0.2,
          },
          reason: "ok",
          handoffReady: true,
        },
      }),
      deliver
    );
    const responseText =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );
    // step is now paused with a stash. Continue:
    await service.confirmStep(db, () => NOW, "run-1", { bus, idFactory });

    const result = readPersistedStepResult(db, "step-1");
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.82);
    const row = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { pending_completion_json: string | null };
    expect(row.pending_completion_json).toBeNull();
    const liveAfter = db
      .prepare("SELECT status, source_kind FROM activities WHERE step_run_id = 'step-1' AND status IN ('active','paused_for_input')")
      .get() as { status: string; source_kind: string } | undefined;
    expect(liveAfter).toBeUndefined();
  });

  it("is a no-op when there is no stash", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    const service = makeJudgeService(
      fakeMediator({ kind: "approve_step_complete" }),
      vi.fn(async () => "delivered" as const)
    );
    await service.confirmStep(db, () => NOW, "run-1", { bus, idFactory });
    const row = db
      .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { step_result_json: string | null };
    expect(row.step_result_json).toBeNull();
  });
});

describe("OrchestratorService.continueAllPausedSteps", () => {
  it("continueAllPausedSteps continues a step held at a checkpoint", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "supervised", NOW);

    const service = makeJudgeService(
      fakeMediator({ kind: "approve_step_complete", scoring: { successScore: 0.82, quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 }, reason: "ok", handoffReady: true } }),
      vi.fn(async () => "delivered" as const)
    );
    const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
    await service.onAgentResponseDone(db, () => NOW, { sessionId: "sess-judge", adapterId: "claude-code", responseText }, { bus, idFactory });

    // held with a stash
    const before = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
    expect(before.pending_completion_json).not.toBeNull();

    // switch effect: continue all paused
    await service.continueAllPausedSteps(db, () => NOW, { bus, idFactory });

    const result = readPersistedStepResult(db, "step-1");
    expect(result.evaluationStatus).toBe("scored");
    const after = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
    expect(after.pending_completion_json).toBeNull();
  });

  it("continueAllPausedSteps is a no-op when nothing is paused", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), vi.fn(async () => "delivered" as const));
    await service.continueAllPausedSteps(db, () => NOW, { bus, idFactory });
    const row = db.prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { step_result_json: string | null };
    expect(row.step_result_json).toBeNull();
  });
});

describe("OrchestratorService.onUserMessage (refine path)", () => {
  it("refining a paused supervised step records a signal, clears the stash, resumes the activity", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    setSupervisionMode(db, "supervised", NOW);

    // 1) Approve → step holds at the confirmation checkpoint.
    const approveService = makeJudgeService(
      fakeMediator({ kind: "approve_step_complete", scoring: { successScore: 0.82, quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 }, reason: "ok", handoffReady: true } }),
      vi.fn(async () => "delivered" as const)
    );
    const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
    await approveService.onAgentResponseDone(db, () => NOW, { sessionId: "sess-judge", adapterId: "claude-code", responseText }, { bus, idFactory });

    // sanity: paused with a stash
    const before = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
    expect(before.pending_completion_json).not.toBeNull();

    // 2) User refines → orchestrator forwards to the live worker.
    const deliver = vi.fn(async () => "delivered" as const);
    const refineService = makeJudgeService(
      fakeMediator({ kind: "forward_to_agent", translated: "add error handling" }),
      deliver
    );
    await refineService.onUserMessage(db, () => NOW, { goalId: "goal-1", body: "add error handling" }, { bus, idFactory });

    expect(deliver).toHaveBeenCalledWith("sess-judge", "add error handling");
    const after = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
    expect(after.pending_completion_json).toBeNull();
    const sig = db.prepare("SELECT COUNT(*) AS c FROM step_revision_signals WHERE step_run_id = 'step-1'").get() as { c: number };
    expect(sig.c).toBe(1);
    const act = db.prepare("SELECT status FROM activities WHERE step_run_id = 'step-1' AND status = 'active'").get() as { status: string } | undefined;
    expect(act?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Provider recovery actions (Task 5): wait / retry / refresh / switch
// ---------------------------------------------------------------------------

const TURN_STARTED_TAIL = "working on it… (esc to interrupt)";
const RECOVERY_LIMIT_TAIL =
  "You've hit your session limit · resets 1:20am (America/Los_Angeles)\n" +
  "/upgrade to increase your usage limit.";
// Codex emits its own usage-limit screen (not Claude's session-limit format), so
// the codex replacement-failure case must use a codex-parseable limit string.
const CODEX_LIMIT_TAIL = "You've hit your usage limit. purchase more credits to continue.";

/** A SessionOutputStore that serves a different snapshot per session id. */
function multiOutputStore(
  byId: Record<string, { tail: string; nextSeq: number }>
): SessionOutputStore {
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn((id: string): SessionOutputSnapshot => {
      const entry = byId[id] ?? { tail: "", nextSeq: 0 };
      const chunks = entry.tail
        ? [
            {
              seq: 0,
              byteOffset: 0,
              dataBase64: Buffer.from(entry.tail).toString("base64"),
            },
          ]
        : [];
      return {
        sessionId: id,
        firstByteOffset: 0,
        nextSeq: entry.nextSeq,
        totalBytesKept: Buffer.byteLength(entry.tail),
        chunks,
      };
    }),
  };
}

interface RecoveryServiceParts {
  deliver: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  service: OrchestratorService;
}

function makeRecoveryService(opts: {
  outputStore?: SessionOutputStore;
  launchSessionId?: string;
  operators?: OperatorDescriptor[];
  adapterReady?: (id: string) => boolean;
} = {}): RecoveryServiceParts {
  const deliver = vi.fn(async () => "delivered" as const);
  const wait = vi.fn(async () => {});
  const terminate = vi.fn(async () => {});
  const spawn = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ sessionId: opts.launchSessionId ?? "sess-replacement" }));
  const operators = opts.operators ?? [
    agentOperatorDescriptor(),
    {
      id: "agent:codex",
      kind: "agent" as const,
      displayName: "Codex",
      capabilities: [],
      ready: true,
      supportsRepoEditing: true,
      supportsTerminal: true,
    },
  ];
  const adapterReady = opts.adapterReady ?? ((id) => id === "claude-code" || id === "codex");
  const dispatch: StepDispatchCapabilities = {
    async isAdapterReady(id) {
      return adapterReady(id);
    },
    supportsModel(id, mid) {
      if (id === "claude-code" && mid === "claude-haiku-4-5") return true;
      if (id === "codex" && mid === "gpt-5-codex") return true;
      return false;
    },
    resolveMode(id) {
      return { adapterId: id, mode: "one_shot", fallbacks: ["shadow_session"] };
    },
  };
  const service = new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return operators; } },
    { launch },
    opts.outputStore ?? multiOutputStore({}),
    dispatch,
    undefined,
    spawn,
    deliver,
    terminate
  );
  return { deliver, wait, terminate, spawn, launch, service };
}

/** Build a recovery service whose workerWait is wired (last constructor arg). */
function makeRecoveryServiceWithWait(opts: {
  outputStore?: SessionOutputStore;
  launchSessionId?: string;
} = {}): RecoveryServiceParts {
  const deliver = vi.fn(async () => "delivered" as const);
  const wait = vi.fn(async () => {});
  const terminate = vi.fn(async () => {});
  const spawn = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ sessionId: opts.launchSessionId ?? "sess-replacement" }));
  const dispatch: StepDispatchCapabilities = {
    async isAdapterReady(id) {
      return id === "claude-code" || id === "codex";
    },
    supportsModel(id, mid) {
      if (id === "claude-code" && mid === "claude-haiku-4-5") return true;
      if (id === "codex" && mid === "gpt-5-codex") return true;
      return false;
    },
    resolveMode(id) {
      return { adapterId: id, mode: "one_shot", fallbacks: ["shadow_session"] };
    },
  };
  const service = new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    {
      async list() {
        return [
          agentOperatorDescriptor(),
          {
            id: "agent:codex",
            kind: "agent" as const,
            displayName: "Codex",
            capabilities: [],
            ready: true,
            supportsRepoEditing: true,
            supportsTerminal: true,
          },
        ];
      },
    },
    { launch },
    opts.outputStore ?? multiOutputStore({}),
    dispatch,
    undefined,
    spawn,
    deliver,
    terminate,
    undefined,
    undefined,
    wait
  );
  return { deliver, wait, terminate, spawn, launch, service };
}

/** Seed an agent step + linked session + a recovery checkpoint row. */
function seedRecoveryCheckpoint(
  db: Database.Database,
  patch: Partial<ProviderRecoveryCheckpoint> = {}
): ProviderRecoveryCheckpoint {
  setupAgentStepRun(db);
  seedWorkspace(db);
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-cur', 'goal-1', 'ws-1', 'claude-code', 'Session', 'running', ?, 'step-1')"
  ).run(NOW);
  db.prepare(
    "INSERT INTO agents (id, name, short_label, description, swatch, recommended, connected, sort_order, created_at, updated_at) VALUES ('claude-code', 'Claude Code', 'Claude', 'desc', '#000', 0, 1, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET connected = 1"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO agents (id, name, short_label, description, swatch, recommended, connected, sort_order, created_at, updated_at) VALUES ('codex', 'Codex', 'Codex', 'desc', '#111', 0, 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET connected = 1"
  ).run(NOW, NOW);
  const checkpoint: ProviderRecoveryCheckpoint = {
    id: "ckpt-1",
    mode: "choose",
    failureCode: "session_limit",
    message: "You've hit your session limit",
    currentSessionId: "sess-cur",
    currentAdapterId: "claude-code",
    currentProviderName: "Claude Code",
    resetTimeText: "1:20am (America/Los_Angeles)",
    resetAt: null,
    timezone: "America/Los_Angeles",
    detectedAt: NOW,
    retryOutputSeq: null,
    retryKind: "preserved_session",
    replacementSessionId: null,
    replacementOutputSeq: null,
    pendingGuidance: [],
    lastError: null,
    choices: [
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5-codex",
        enabled: true,
        reason: null,
      },
    ],
    ...patch,
  };
  db.prepare(
    "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = 'step-1'"
  ).run(JSON.stringify(checkpoint));
  return checkpoint;
}

function readCheckpoint(db: Database.Database): ProviderRecoveryCheckpoint | null {
  const row = db
    .prepare("SELECT pending_provider_recovery_json AS j FROM workflow_step_runs WHERE id = 'step-1'")
    .get() as { j: string | null };
  return row.j ? (JSON.parse(row.j) as ProviderRecoveryCheckpoint) : null;
}

function terminalSessionEventCount(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE type IN ('session.stopped', 'session.failed')"
      )
      .get() as { c: number }
  ).c;
}

describe("OrchestratorService provider recovery actions", () => {
  it("waitForProvider: choose→waiting, preserves session, calls worker wait", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const { service, wait } = makeRecoveryServiceWithWait();

    await service.waitForProvider(db, () => NOW, "run-1", "ckpt-1");

    expect(readCheckpoint(db)?.mode).toBe("waiting");
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = 'sess-cur'").get()
    ).toEqual({ status: "running" });
    expect(wait).toHaveBeenCalledWith("sess-cur", "claude-code");
  });

  it("waitForProvider rejected outside choose (waiting) with invalid-transition", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting" });
    const { service } = makeRecoveryServiceWithWait();

    await expect(
      service.waitForProvider(db, () => NOW, "run-1", "ckpt-1")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
  });

  it("retryProvider (preserved): stores output_seq, waiting→retrying, delivers Continue to same session", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting" });
    const { service, deliver } = makeRecoveryService({
      outputStore: multiOutputStore({ "sess-cur": { tail: "", nextSeq: 7 } }),
    });

    await service.retryProvider(db, () => NOW, "run-1", "ckpt-1");

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("retrying");
    expect(ck.retryOutputSeq).toBe(7);
    expect(deliver).toHaveBeenCalledWith("sess-cur", "Continue the previous step request.");
  });

  it("retryProvider rejected outside waiting (choose) with invalid-transition", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "choose" });
    const { service, deliver } = makeRecoveryService();

    await expect(
      service.retryProvider(db, () => NOW, "run-1", "ckpt-1")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retryProvider (fresh_session): launches replacement with handoff instead of claiming preserved", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting", retryKind: "fresh_session" });
    const { service, deliver, launch, spawn } = makeRecoveryService({
      outputStore: multiOutputStore({
        "sess-cur": { tail: "", nextSeq: 1 },
        "sess-replacement": { tail: "", nextSeq: 3 },
      }),
      launchSessionId: "sess-replacement",
    });

    await service.retryProvider(db, () => NOW, "run-1", "ckpt-1");

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("retrying");
    expect(ck.replacementSessionId).toBe("sess-replacement");
    expect(ck.replacementOutputSeq).toBe(3);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Handoff prompt (not "Continue the previous step request.") delivered to the new session.
    expect(deliver).toHaveBeenCalledWith(
      "sess-replacement",
      expect.stringContaining("Interrupted session handoff")
    );
  });

  it("preserved-session Retry before a known future resetAt is rejected without delivering", async () => {
    const { db } = setupHarness();
    const future = "2999-01-01T00:00:00.000Z";
    seedRecoveryCheckpoint(db, { mode: "waiting", resetAt: future });
    const { service, deliver } = makeRecoveryService({
      outputStore: multiOutputStore({ "sess-cur": { tail: "", nextSeq: 1 } }),
    });

    await expect(
      service.retryProvider(db, () => NOW, "run-1", "ckpt-1")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(deliver).not.toHaveBeenCalled();
    expect(readCheckpoint(db)?.mode).toBe("waiting");
  });

  it("unknown reset time stays manually retryable", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting", resetAt: null });
    const { service, deliver } = makeRecoveryService({
      outputStore: multiOutputStore({ "sess-cur": { tail: "", nextSeq: 2 } }),
    });

    await service.retryProvider(db, () => NOW, "run-1", "ckpt-1");

    expect(readCheckpoint(db)?.mode).toBe("retrying");
    expect(deliver).toHaveBeenCalledWith("sess-cur", "Continue the previous step request.");
  });

  it("user chat while pending → appended to pendingGuidance + Orca ack + NOT sent to worker", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting" });
    const deliver = vi.fn(async () => "delivered" as const);
    const mediator = spyMediator({ kind: "forward_to_agent", translated: "x" });
    // Goal needs orchestrator provider/model for onUserMessage to reach the guidance check.
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
    ).run();
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      multiOutputStore({}),
      fakeStepDispatch(),
      mediator,
      undefined,
      deliver
    );

    await service.onUserMessage(db, () => NOW, { goalId: "goal-1", body: "prefer pnpm" }, { bus, idFactory });

    expect(readCheckpoint(db)?.pendingGuidance).toEqual(["prefer pnpm"]);
    expect(mediator.calls).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(lastOrchestratorMessageBody(db)).toContain("Saved this guidance");
  });

  it("pendingGuidance retains newest 20 and bounds each item to 4000 chars", async () => {
    const { db, bus, idFactory } = setupHarness();
    const existing = Array.from({ length: 20 }, (_v, i) => `g${i}`);
    seedRecoveryCheckpoint(db, { mode: "waiting", pendingGuidance: existing });
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
    ).run();
    const mediator = spyMediator({ kind: "forward_to_agent", translated: "x" });
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      multiOutputStore({}),
      fakeStepDispatch(),
      mediator,
      undefined,
      vi.fn(async () => "delivered" as const)
    );

    const long = "z".repeat(5000);
    await service.onUserMessage(db, () => NOW, { goalId: "goal-1", body: long }, { bus, idFactory });

    const guidance = readCheckpoint(db)!.pendingGuidance;
    expect(guidance.length).toBe(20);
    expect(guidance[0]).toBe("g1"); // oldest dropped
    expect(guidance[19]!.length).toBe(4000);
  });

  it("turn-start after stored seq sends pending guidance then clears checkpoint + resumes", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "retrying",
      retryKind: "preserved_session",
      retryOutputSeq: 5,
      pendingGuidance: ["use the new API"],
    });
    db.prepare(
      `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal, status, current_text, final_summary, source_kind, work_category, confidence, pending_question, created_at, updated_at, completed_at) VALUES ('act-r', 'goal-1', 'run-1', 'step-1', 'sess-cur', 0, 'paused_for_input', 'Paused', NULL, 'provider_recovery_pending', NULL, NULL, NULL, ?, ?, NULL)`
    ).run(NOW, NOW);
    const deliver = vi.fn(async () => "delivered" as const);
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      multiOutputStore({ "sess-cur": { tail: TURN_STARTED_TAIL, nextSeq: 8 } }),
      fakeStepDispatch(),
      undefined,
      undefined,
      deliver
    );

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-cur", goalId: "goal-1" }, { bus, idFactory });

    expect(deliver).toHaveBeenCalledWith("sess-cur", "use the new API");
    expect(readCheckpoint(db)).toBeNull();
    expect(
      db.prepare("SELECT status FROM activities WHERE id = 'act-r'").get()
    ).toMatchObject({ status: "active" });
  });

  it("turn-start but guidance delivery fails → back to waiting w/ lastError, checkpoint kept", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "retrying",
      retryKind: "preserved_session",
      retryOutputSeq: 5,
      pendingGuidance: ["use the new API"],
    });
    db.prepare(
      `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal, status, current_text, final_summary, source_kind, work_category, confidence, pending_question, created_at, updated_at, completed_at) VALUES ('act-r', 'goal-1', 'run-1', 'step-1', 'sess-cur', 0, 'paused_for_input', 'Paused', NULL, 'provider_recovery_pending', NULL, NULL, NULL, ?, ?, NULL)`
    ).run(NOW, NOW);
    const deliver = vi.fn(async () => "no_session" as const);
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      multiOutputStore({ "sess-cur": { tail: TURN_STARTED_TAIL, nextSeq: 8 } }),
      fakeStepDispatch(),
      undefined,
      undefined,
      deliver
    );

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-cur", goalId: "goal-1" }, { bus, idFactory });

    const ck = readCheckpoint(db);
    expect(ck).not.toBeNull();
    expect(ck!.mode).toBe("waiting");
    expect(ck!.lastError).toBeTruthy();
    expect(ck!.retryOutputSeq).toBeNull();
    expect(ck!.pendingGuidance).toEqual(["use the new API"]);
  });

  it("same limit while retrying → back to waiting w/ refreshed reset", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "retrying",
      retryKind: "preserved_session",
      retryOutputSeq: 2,
      resetAt: null,
    });
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      multiOutputStore({ "sess-cur": { tail: RECOVERY_LIMIT_TAIL, nextSeq: 5 } }),
      fakeStepDispatch(),
      undefined,
      undefined,
      vi.fn(async () => "delivered" as const)
    );

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-cur", goalId: "goal-1" }, { bus, idFactory });

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("waiting");
    expect(ck.retryOutputSeq).toBeNull();
    expect(ck.resetTimeText).toContain("1:20am");
  });

  it("old turn-start text before retryOutputSeq does not clear a new retry checkpoint", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "retrying",
      retryKind: "preserved_session",
      retryOutputSeq: 10,
    });
    const service = new OrchestratorService(
      fakeAgentSelector(),
      fakeBrokerNoop(),
      { async list() { return [agentOperatorDescriptor()]; } },
      makeLauncher(),
      // nextSeq (8) <= retryOutputSeq (10): stale output, must be ignored.
      multiOutputStore({ "sess-cur": { tail: TURN_STARTED_TAIL, nextSeq: 8 } }),
      fakeStepDispatch(),
      undefined,
      undefined,
      vi.fn(async () => "delivered" as const)
    );

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-cur", goalId: "goal-1" }, { bus, idFactory });

    expect(readCheckpoint(db)?.mode).toBe("retrying");
  });

  it("refreshProviderRecovery rebuilds choices preserving id+mode", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { mode: "waiting", choices: [] });
    const { service } = makeRecoveryService();

    await service.refreshProviderRecovery(db, () => NOW, "run-1", "ckpt-1");

    const ck = readCheckpoint(db)!;
    expect(ck.id).toBe("ckpt-1");
    expect(ck.mode).toBe("waiting");
    expect(ck.choices.some((c) => c.adapterId === "codex" && c.enabled)).toBe(true);
  });

  it("switchProvider rejects a stale (unknown) checkpoint id", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const { service, launch } = makeRecoveryService();

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-WRONG", "codex")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryNotFoundError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("switchProvider rejects the current adapter", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const { service, launch } = makeRecoveryService();

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "claude-code")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("switchProvider rejects a disabled / unavailable choice", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, {
      choices: [
        { adapterId: "codex", displayName: "Codex", modelId: "gpt-5-codex", enabled: false, reason: "provider unavailable" },
      ],
    });
    const { service, launch } = makeRecoveryService();

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "codex")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("switchProvider rejects an id not present in choices", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const { service, launch } = makeRecoveryService();

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "opencode")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("switchProvider rejects when the chosen adapter is no longer ready at switch time", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const { service, launch, spawn } = makeRecoveryService({
      adapterReady: (id) => id === "claude-code",
    });

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "codex")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryInvalidTransitionError);
    expect(launch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    // Checkpoint is untouched (still in choose mode).
    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("choose");
    expect(ck.replacementSessionId).toBeNull();
  });

  it("loadProviderRecoveryContext maps a malformed persisted checkpoint to NotFound (not an unmapped error)", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    db.prepare(
      "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = 'step-1'"
    ).run('{"not":"a valid checkpoint"}');
    const { service, launch } = makeRecoveryService();

    await expect(
      service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "codex")
    ).rejects.toBeInstanceOf(OrchestratorProviderRecoveryNotFoundError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("successful switch: launches replacement w/ handoff incl. guidance, sets switching + replacementOutputSeq, keeps old session", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db, { pendingGuidance: ["prefer pnpm"] });
    const { service, launch, spawn, deliver, terminate } = makeRecoveryService({
      outputStore: multiOutputStore({
        "sess-cur": { tail: "prior work", nextSeq: 1 },
        "sess-replacement": { tail: "", nextSeq: 4 },
      }),
      launchSessionId: "sess-replacement",
    });

    await service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "codex");

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("switching");
    expect(ck.replacementSessionId).toBe("sess-replacement");
    expect(ck.replacementOutputSeq).toBe(4);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({ sessionId: "sess-replacement", goalId: "goal-1", adapterId: "codex" });
    expect(deliver).toHaveBeenCalledWith(
      "sess-replacement",
      expect.stringContaining("prefer pnpm")
    );
    // Old session not yet retired here (only in the switching output branch).
    expect(terminate).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = 'sess-cur'").get()
    ).toEqual({ status: "running" });
  });

  it("switch startup progress: commits selection only after started output, clears recovery, resumes, terminates old session, no terminal events", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "switching",
      replacementSessionId: "sess-replacement",
      replacementOutputSeq: 4,
    });
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-replacement', 'goal-1', 'ws-1', 'codex', 'New', 'running', ?, 'step-1')"
    ).run(NOW);
    db.prepare(
      `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal, status, current_text, final_summary, source_kind, work_category, confidence, pending_question, created_at, updated_at, completed_at) VALUES ('act-s', 'goal-1', 'run-1', 'step-1', 'sess-cur', 0, 'paused_for_input', 'Paused', NULL, 'provider_recovery_pending', NULL, NULL, NULL, ?, ?, NULL)`
    ).run(NOW, NOW);
    const { service, terminate } = makeRecoveryService({
      outputStore: multiOutputStore({ "sess-replacement": { tail: TURN_STARTED_TAIL, nextSeq: 7 } }),
    });

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-replacement", goalId: "goal-1" }, { bus, idFactory });

    expect(readCheckpoint(db)).toBeNull();
    expect(
      db.prepare("SELECT selected_operator_id FROM workflow_step_runs WHERE id = 'step-1'").get()
    ).toMatchObject({ selected_operator_id: "agent:codex" });
    expect(
      db.prepare("SELECT status FROM activities WHERE id = 'act-s'").get()
    ).toMatchObject({ status: "active" });
    expect(
      db.prepare("SELECT status, failure_reason FROM sessions WHERE id = 'sess-cur'").get()
    ).toEqual({ status: "stopped", failure_reason: "provider_switched" });
    expect(terminate).toHaveBeenCalledWith("sess-cur");
    expect(terminalSessionEventCount(db)).toBe(0);
  });

  it("failed switch startup keeps the old session and resets checkpoint to choose, no terminal events", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedRecoveryCheckpoint(db, {
      mode: "switching",
      replacementSessionId: "sess-replacement",
      replacementOutputSeq: 4,
    });
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-replacement', 'goal-1', 'ws-1', 'codex', 'New', 'running', ?, 'step-1')"
    ).run(NOW);
    const { service, terminate } = makeRecoveryService({
      outputStore: multiOutputStore({ "sess-replacement": { tail: CODEX_LIMIT_TAIL, nextSeq: 7 } }),
    });

    await service.onSessionOutputChunk(db, () => NOW, { sessionId: "sess-replacement", goalId: "goal-1" }, { bus, idFactory });

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("choose");
    expect(ck.replacementSessionId).toBeNull();
    expect(ck.lastError).toBeTruthy();
    // Old session preserved.
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = 'sess-cur'").get()
    ).toEqual({ status: "running" });
    // Failed replacement gets terminal DB status but no published session.failed event.
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = 'sess-replacement'").get()
    ).toEqual({ status: "failed" });
    expect(terminate).toHaveBeenCalledWith("sess-replacement");
    expect(terminalSessionEventCount(db)).toBe(0);
  });

  it("failed switch launch keeps old session + checkpoint in choose", async () => {
    const { db } = setupHarness();
    seedRecoveryCheckpoint(db);
    const parts = makeRecoveryService();
    parts.launch.mockRejectedValueOnce(new Error("spawn boom"));

    await service_expectThrow(parts.service, db);

    const ck = readCheckpoint(db)!;
    expect(ck.mode).toBe("choose");
    expect(ck.lastError).toContain("boom");
    expect(
      db.prepare("SELECT status FROM sessions WHERE id = 'sess-cur'").get()
    ).toEqual({ status: "running" });
  });
});

async function service_expectThrow(service: OrchestratorService, db: Database.Database): Promise<void> {
  await expect(
    service.switchProvider(db, () => NOW, "run-1", "ckpt-1", "codex")
  ).rejects.toThrow();
}
