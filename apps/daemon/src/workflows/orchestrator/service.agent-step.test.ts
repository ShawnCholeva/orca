import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, OperatorSelection } from "@orca/contracts";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { OrchestratorService } from "./service.js";
import {
  cleanupHarness,
  NOW,
  seedSkillWorkflow,
  setupHarness,
  makeStep,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";
import type { SelectorInput } from "../operators/selector.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import type { OrchestratorAction } from "@orca/contracts";

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
    async propose() {
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

function makeAgentService(launcher: WorkflowSessionLauncher): OrchestratorService {
  return new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    undefined,
    fakeStepDispatch()
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

function makeJudgeService(
  mediator: Pick<OrchestratorMediator, "invoke">,
  agentInput: (sessionId: string, text: string) => void | Promise<void>
): OrchestratorService {
  return new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    makeLauncher(),
    undefined,
    fakeStepDispatch(),
    mediator,
    agentInput
  );
}

/** Mark the active step run as agent-selected and link a session to it */
function seedAgentSession(db: Database.Database, opts: { reviseAttempts?: number } = {}) {
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

function orchestratorMessageCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM orchestrator_messages WHERE goal_id = 'goal-1'").get() as { c: number }
  ).c;
}

/** Seed a workflow with an agent-capable template step */
function setupAgentStepRun(db: Database.Database, opts: { guardrailsJson?: string } = {}) {
  const step = makeStep({
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Write the implementation.",
    outputSchema: [{ key: "result", type: "string", required: true }],
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
  it("approve_step_complete: writes step_output artifact and recommends run completion", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const agentInput = vi.fn();
    const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), agentInput);

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
    expect(agentInput).not.toHaveBeenCalled();
  });

  it("revise_step under cap: bumps revise_attempts to 1 and sends feedback to the agent", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db, { reviseAttempts: 0 });

    const agentInput = vi.fn();
    // Mediator should NOT be consulted: schema-invalid block makes judgement return revise deterministically.
    const mediator = spyMediator({ kind: "approve_step_complete" });
    const service = makeJudgeService(mediator, agentInput);

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
    expect(agentInput).toHaveBeenCalledTimes(1);
    const [sessionId, text] = agentInput.mock.calls[0]!;
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

    const agentInput = vi.fn();
    const service = makeJudgeService(spyMediator({ kind: "approve_step_complete" }), agentInput);

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
    expect(agentInput).not.toHaveBeenCalled();
  });
});

describe("OrchestratorService.onUserMessage (user_message trigger)", () => {
  it("forward_to_agent: relays the translated text into the live agent session", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const agentInput = vi.fn();
    const service = makeJudgeService(
      fakeMediator({ kind: "forward_to_agent", translated: "please add tests" }),
      agentInput
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "add tests" },
      { bus, idFactory }
    );

    expect(agentInput).toHaveBeenCalledTimes(1);
    const [sessionId, text] = agentInput.mock.calls[0]!;
    expect(sessionId).toBe("sess-judge");
    expect(text).toContain("please add tests");
  });

  it("answer_user_directly: posts an orchestrator message and does NOT message the agent", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);

    const agentInput = vi.fn();
    const service = makeJudgeService(
      fakeMediator({ kind: "answer_user_directly", body: "sure" }),
      agentInput
    );

    await service.onUserMessage(
      db,
      () => NOW,
      { goalId: "goal-1", body: "is this done?" },
      { bus, idFactory }
    );

    expect(orchestratorMessageCount(db)).toBe(1);
    expect(agentInput).not.toHaveBeenCalled();
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
