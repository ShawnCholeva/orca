import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, WorkflowGraph } from "@orca/contracts";
import type { WorkflowLaunchContext, WorkflowSessionLauncher } from "./session-launcher.js";
import { DispatchEngine } from "./dispatch-engine.js";
import { OrchestratorService } from "./service.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { recordGateDecision, nextTraversalSeq } from "../gates/usecases.js";
import type { StepRunRow } from "./db-rows.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  makeStep,
  fakeStepDispatch,
  type SkillStep,
} from "./skill-step-test-helpers.js";
import type {
  BrokerCompatibilityOptions,
  OrchestrationTransportBroker,
} from "../orchestration-transport/broker.js";

const AGENT_OPERATOR_ID = "agent:claude-code";

function agentOperatorDescriptor(): OperatorDescriptor {
  return {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: [],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
}

/** Scores the active step handoff-ready so the run advances into the gate. */
function fakeStepBroker(): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(_request: unknown, options?: BrokerCompatibilityOptions) {
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
    },
  };
}

function makeLauncher(launch = vi.fn(async () => ({ sessionId: "gate-sess-1" }))): WorkflowSessionLauncher {
  return { launch };
}

function makeWorkerEngine(args: {
  launcher: WorkflowSessionLauncher;
  workerSpawn?: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>;
  workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
}): DispatchEngine {
  return new DispatchEngine(
    fakeStepBroker(),
    { async list() { return [agentOperatorDescriptor()]; } },
    args.launcher,
    fakeStepDispatch(),
    args.workerSpawn,
    args.workerDeliver,
  );
}

function step(id: string, ordinal: number): SkillStep {
  return makeStep({
    id,
    ordinal,
    name: id,
    instructions: `Do ${id}.`,
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  });
}

/**
 * Graph: analysis -> execution -> validation -> gate(worker) -> done (terminal)
 *   gate rejected -> execution (backward loop)
 */
function workerGateGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
      { id: "execution", type: "step", name: "Execution", stepId: "execution" },
      { id: "validation", type: "step", name: "Validation", stepId: "validation" },
      {
        id: "gate",
        type: "gate",
        name: "Critique",
        evalSubstrate: "worker",
        instructions: "CHALLENGE THE APPROACH",
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
      { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
    ],
    edges: [
      { from: "analysis", to: "execution" },
      { from: "execution", to: "validation" },
      { from: "validation", to: "gate" },
      { from: "gate", to: "done", port: "approved" },
      { from: "gate", to: "execution", port: "rejected" },
    ],
    positions: {},
  } as WorkflowGraph;
}

/** Seed a run positioned at the active `validation` step holding a step_output artifact. */
function seedRunAtValidation(db: Database.Database): void {
  const steps = [step("analysis", 0), step("execution", 1), step("validation", 2), step("done", 3)];
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(workerGateGraph()), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-validation', 'validation', 'step', 0, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-validation', 'goal-1', 'run-1', 'validation', 2, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-validation', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-execution', 'goal-1', 'run-1', 'execution', 1, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-execution')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-val', 'goal-1', 'run-1', 'step-validation', 'step_output', 'Validation', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ result: "all good", _completion: {} }), NOW);
}

function surrogateRow(db: Database.Database): { id: string; status: string; selected_model_id: string | null } | undefined {
  return db
    .prepare("SELECT id, status, selected_model_id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = '__gate__:gate'")
    .get() as { id: string; status: string; selected_model_id: string | null } | undefined;
}

describe("dispatch-engine worker-backed gate — spawn (Task 4b)", () => {
  let db: Database.Database;
  let bus: import("../../events.js").EventBus;
  let idFactory: () => string;

  beforeEach(() => {
    const h = setupHarness();
    db = h.db;
    bus = h.bus;
    idFactory = h.idFactory;
  });

  afterEach(() => {
    resetWorkflowEventPreparedStatements();
    resetWorkflowStepProjectionPreparedStatements();
    closeDatabase();
    cleanupHarness();
    vi.restoreAllMocks();
  });

  it("spawns a gate worker bound to a surrogate step-run and parks the run awaiting it", async () => {
    seedRunAtValidation(db);
    const launch = vi.fn(async (_ctx: WorkflowLaunchContext) => ({ sessionId: "gate-sess-1" }));
    const workerSpawn = vi.fn(async (_input: { sessionId: string; goalId: string; adapterId: string }) => {});
    const workerDeliver = vi.fn(async (_sessionId: string, _text: string) => "delivered" as const);
    const engine = makeWorkerEngine({ launcher: makeLauncher(launch), workerSpawn, workerDeliver });

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // (a) A gate surrogate step-run exists, active, on the gate's strong model.
    const surrogate = surrogateRow(db);
    expect(surrogate).toBeDefined();
    expect(surrogate!.status).toBe("active");
    expect(surrogate!.selected_model_id).toBe("claude-haiku-4-5");

    // (b) A worker session was launched bound to the surrogate, carrying the
    // composed gate prompt (gate instructions + the decision output contract).
    expect(launch).toHaveBeenCalledTimes(1);
    const launchArg = launch.mock.calls[0]![0] as {
      workflowStepRunId: string;
      operatorId: string;
      objective: string;
    };
    expect(launchArg.workflowStepRunId).toBe(surrogate!.id);
    expect(launchArg.operatorId).toBe("agent:claude-code");
    expect(launchArg.objective).toContain("CHALLENGE THE APPROACH");
    expect(launchArg.objective).toContain("orca:gate-decision");

    // (c) The worker was spawned + delivered the objective.
    expect(workerSpawn).toHaveBeenCalledTimes(1);
    expect(workerSpawn.mock.calls[0]![0]).toMatchObject({ adapterId: "claude-code", goalId: "goal-1" });
    expect(workerDeliver).toHaveBeenCalledTimes(1);
    expect(workerDeliver.mock.calls[0]![1]).toContain("orca:gate-decision");

    // (d) The run is parked at the gate awaiting the async worker verdict: no
    // cursor step, no decision recorded yet, stash marks awaitingWorker + source.
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    expect(run!.currentStepRunId).toBeNull();
    expect(run!.currentNodeKind).toBe("gate");
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const stashRow = db
      .prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { pending_gate_route_json: string | null };
    const stash = JSON.parse(stashRow.pending_gate_route_json!);
    expect(stash.awaitingWorker).toBe(true);
    expect(stash.gateNodeId).toBe("gate");
    expect(stash.sourceStepRunId).toBe("step-validation");
  });

  it("escalates to a human gate park when the worker cannot receive its objective (delivery timeout)", async () => {
    seedRunAtValidation(db);
    const launch = vi.fn(async (_ctx: WorkflowLaunchContext) => ({ sessionId: "gate-sess-1" }));
    const engine = makeWorkerEngine({
      launcher: makeLauncher(launch),
      workerSpawn: vi.fn(async () => {}),
      workerDeliver: vi.fn(async () => "timeout" as const),
    });

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // The worker will never get its objective → don't leave it parked awaitingWorker
    // (which would hang). The surrogate is closed and the gate parks for a human.
    const surrogate = surrogateRow(db);
    expect(surrogate!.status).toBe("passed");
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    expect(run!.currentStepRunId).toBeNull();
    const stash = JSON.parse((db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id='run-1'").get() as { pending_gate_route_json: string }).pending_gate_route_json);
    expect(stash.awaitingHumanDecision).toBe(true);
    expect(stash.awaitingWorker).toBeUndefined();
  });

  it("degrades to a human gate park when no worker adapter/model is available", async () => {
    seedRunAtValidation(db);
    // A gate whose agentPreference cannot be satisfied by fakeStepDispatch
    // (only claude-code + claude-haiku-4-5 is supported).
    db.prepare("UPDATE workflow_templates SET graph_json = ? WHERE id = 'orca/engineering'").run(
      JSON.stringify({
        ...workerGateGraph(),
        nodes: workerGateGraph().nodes.map((n) =>
          n.id === "gate"
            ? { ...n, agentPreference: [{ adapterId: "claude-code", modelId: "no-such-model" }] }
            : n
        ),
      })
    );
    const launch = vi.fn(async (_ctx: WorkflowLaunchContext) => ({ sessionId: "gate-sess-1" }));
    const engine = makeWorkerEngine({ launcher: makeLauncher(launch), workerSpawn: vi.fn(async () => {}), workerDeliver: vi.fn(async () => "delivered" as const) });

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // No worker launched; the run parks for a human decision (awaitingHumanDecision).
    expect(launch).not.toHaveBeenCalled();
    expect(surrogateRow(db)).toBeUndefined();
    const stashRow = db
      .prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { pending_gate_route_json: string | null };
    const stash = JSON.parse(stashRow.pending_gate_route_json!);
    expect(stash.awaitingHumanDecision).toBe(true);
  });
});

function gateDecision(outcome: "approved" | "rejected", issueRefs: string[]): string {
  return `\`\`\`orca:gate-decision\n${JSON.stringify({
    reasoning: `judged ${outcome}`,
    outcome,
    reason: `${outcome} because reasons`,
    issueRefs,
    inputsConsidered: ["sourceStepOutput"],
  })}\n\`\`\``;
}

describe("dispatch-engine worker-backed gate — complete (Task 4c)", () => {
  let db: Database.Database;
  let bus: import("../../events.js").EventBus;
  let idFactory: () => string;

  beforeEach(() => {
    const h = setupHarness();
    db = h.db;
    bus = h.bus;
    idFactory = h.idFactory;
  });

  afterEach(() => {
    resetWorkflowEventPreparedStatements();
    resetWorkflowStepProjectionPreparedStatements();
    closeDatabase();
    cleanupHarness();
    vi.restoreAllMocks();
  });

  /** Drive requestNextDecision until the run parks at the worker gate; return the surrogate row. */
  async function parkAtGate(engine: DispatchEngine): Promise<StepRunRow> {
    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    return db
      .prepare("SELECT * FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = '__gate__:gate'")
      .get() as StepRunRow;
  }

  it("automated: a rejected worker verdict records the decision and routes to the rejected port", async () => {
    seedRunAtValidation(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const engine = makeWorkerEngine({
      launcher: makeLauncher(),
      workerSpawn: vi.fn(async () => {}),
      workerDeliver: vi.fn(async () => "delivered" as const),
    });
    const surrogate = await parkAtGate(engine);

    await engine.completeGateWorker(db, () => NOW, surrogate, gateDecision("rejected", ["lock", "purity"]), { bus, idFactory });

    // Decision recorded with the worker's issueRefs.
    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.outcome).toBe("rejected");
    expect(decisions[0]!.issueRefs).toEqual(["lock", "purity"]);
    // Routed backward to a fresh Execution attempt (the rejected port target).
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    expect(run!.currentNodeId).toBe("execution");
    const cur = db.prepare("SELECT step_template_id, status FROM workflow_step_runs WHERE id = ?").get(run!.currentStepRunId) as { step_template_id: string; status: string };
    expect(cur.step_template_id).toBe("execution");
    expect(cur.status).toBe("active");
    // Surrogate closed; stash cleared.
    const sur = db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?").get(surrogate.id) as { status: string };
    expect(sur.status).toBe("passed");
    const stashRow = db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string | null };
    expect(stashRow.pending_gate_route_json).toBeNull();
  });

  it("automated: a rejection repeating the prior issueRefs blocks the run (stagnation)", async () => {
    seedRunAtValidation(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const engine = makeWorkerEngine({
      launcher: makeLauncher(),
      workerSpawn: vi.fn(async () => {}),
      workerDeliver: vi.fn(async () => "delivered" as const),
    });
    const surrogate = await parkAtGate(engine);
    // Seed a prior rejection on this gate with the SAME issueRefs.
    recordGateDecision(db, () => NOW, {
      goalId: "goal-1", workflowRunId: "run-1", nodeId: "gate", traversalSeq: nextTraversalSeq(db, "run-1"),
      outcome: "rejected", reason: "first pass", reasoning: null, selectedEdgeTo: "execution",
      inputsConsidered: [], issueRefs: ["lock", "purity"], ledgerVersion: 0,
    });

    await engine.completeGateWorker(db, () => NOW, surrogate, gateDecision("rejected", ["lock", "purity"]), { bus, idFactory });

    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("blocked");
    expect(run!.blockedReason).toContain("not converging");
  });

  it("supervised: a worker verdict parks with a recommendation (no auto-route)", async () => {
    seedRunAtValidation(db); // goal defaults to human_review (supervised)
    const engine = makeWorkerEngine({
      launcher: makeLauncher(),
      workerSpawn: vi.fn(async () => {}),
      workerDeliver: vi.fn(async () => "delivered" as const),
    });
    const surrogate = await parkAtGate(engine);

    await engine.completeGateWorker(db, () => NOW, surrogate, gateDecision("rejected", ["lock", "purity"]), { bus, idFactory });

    // No auto-decision; the run parks for a human decision carrying the recommendation.
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    expect(run!.currentStepRunId).toBeNull();
    const stash = JSON.parse((db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string }).pending_gate_route_json);
    expect(stash.awaitingHumanDecision).toBe(true);
    expect(stash.recommendedOutcome).toBe("rejected");
    expect(stash.issueRefs).toEqual(["lock", "purity"]);
    expect(stash.reasoning).toBe("judged rejected");
    // The human can then act on it: decideGate routes to the rejected port.
    await engine.decideGate(db, () => NOW, "run-1", "rejected", { bus, idFactory });
    expect(getWorkflowRunById(db, "run-1")!.currentNodeId).toBe("execution");
  });

  it("the surrogate session's Stop hook routes through onAgentResponseDone to completeGateWorker", async () => {
    seedRunAtValidation(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const operators = { async list() { return [agentOperatorDescriptor()]; } };
    const engine = new DispatchEngine(
      fakeStepBroker(),
      operators,
      makeLauncher(),
      fakeStepDispatch(),
      vi.fn(async () => {}),
      vi.fn(async () => "delivered" as const),
    );
    const service = new OrchestratorService(engine, fakeStepBroker(), operators);

    const surrogate = await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory }).then(() =>
      db.prepare("SELECT * FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = '__gate__:gate'").get() as StepRunRow
    );
    // The real launcher would have inserted this; the stub does not, so link the
    // session to the surrogate ourselves (the Stop hook resolves by session id).
    db.prepare(
      "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1', '/tmp/ws-1', 'ws', '', ?, ?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('gate-sess-1', 'goal-1', 'ws-1', 'claude-code', 'Gate', 'running', ?, ?)"
    ).run(NOW, surrogate.id);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "gate-sess-1", adapterId: "claude-code", responseText: gateDecision("rejected", ["lock"]) },
      { bus, idFactory }
    );

    // The gate resolved: decision recorded and routed to the rejected port.
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(1);
    expect(getWorkflowRunById(db, "run-1")!.currentNodeId).toBe("execution");
  });

  it("a gate worker session that ends WITHOUT a decision escalates to a human gate park (no hang)", async () => {
    seedRunAtValidation(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const operators = { async list() { return [agentOperatorDescriptor()]; } };
    const engine = new DispatchEngine(
      fakeStepBroker(),
      operators,
      makeLauncher(),
      fakeStepDispatch(),
      vi.fn(async () => {}),
      vi.fn(async () => "delivered" as const),
    );
    const service = new OrchestratorService(engine, fakeStepBroker(), operators);
    const surrogate = await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory }).then(() =>
      db.prepare("SELECT * FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = '__gate__:gate'").get() as StepRunRow
    );
    db.prepare(
      "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1', '/tmp/ws-1', 'ws', '', ?, ?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('gate-sess-1', 'goal-1', 'ws-1', 'claude-code', 'Gate', 'exited', ?, ?)"
    ).run(NOW, surrogate.id);

    // The worker session ended (crash/exit) with no orca:gate-decision ever parsed.
    await service.onWorkflowSessionCompleted(db, () => NOW, { sessionId: "gate-sess-1", goalId: "goal-1" }, { bus, idFactory });

    // The gate did not hang: surrogate closed, run parked for a human decision.
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const surAfter = db.prepare("SELECT status FROM workflow_step_runs WHERE id=?").get(surrogate.id) as { status: string };
    expect(surAfter.status).toBe("passed");
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    const stash = JSON.parse((db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id='run-1'").get() as { pending_gate_route_json: string }).pending_gate_route_json);
    expect(stash.awaitingHumanDecision).toBe(true);
  });

  it("an unparseable worker response escalates to a human gate park", async () => {
    seedRunAtValidation(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const engine = makeWorkerEngine({
      launcher: makeLauncher(),
      workerSpawn: vi.fn(async () => {}),
      workerDeliver: vi.fn(async () => "delivered" as const),
    });
    const surrogate = await parkAtGate(engine);

    await engine.completeGateWorker(db, () => NOW, surrogate, "the worker rambled but emitted no decision block", { bus, idFactory });

    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const run = getWorkflowRunById(db, "run-1");
    expect(run!.status).toBe("active");
    expect(run!.currentStepRunId).toBeNull();
    const stash = JSON.parse((db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string }).pending_gate_route_json);
    expect(stash.awaitingHumanDecision).toBe(true);
    expect(stash.recommendedOutcome).toBeUndefined();
  });
});
