import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, WorkflowGraph } from "@orca/contracts";
import type { WorkflowLaunchContext, WorkflowSessionLauncher } from "./session-launcher.js";
import { DispatchEngine } from "./dispatch-engine.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { recordGateDecision, nextTraversalSeq } from "../gates/usecases.js";
import { listSplitDecisionsForRun } from "../splitters/projection.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { setSupervisionMode } from "../../settings/store.js";
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
import { commitLedgerVersion } from "../ledger/usecases.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { latestRejectingGate } from "./repair-context.js";
import { GATE_REJECT_CAP } from "./gate-evaluation.js";

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


/**
 * Broker that scores the active step AND evaluates a splitter if the run reaches
 * one. Used for the gate→splitter routing test where the gate's approved edge
 * points at a splitter node.
 */
function fakeStepAndSplitBroker(selectedBranch: string): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(request: unknown, options?: BrokerCompatibilityOptions) {
      const kind = (request as { kind?: string } | undefined)?.kind;
      const proposal =
        kind === "evaluate_split"
          ? { selectedBranch, reason: `Picked ${selectedBranch}.`, inputsConsidered: [] }
          : {
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

/**
 * Broker that returns a benign step-scoring proposal so the active step can be
 * scored and the run can advance to the gate. Gates are NOT evaluated by the
 * broker anymore — they park for a human decideGate call — so the evaluate_gate
 * branch is gone.
 */
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

function makeLauncher(launch = vi.fn(async () => ({ sessionId: "sess-1" }))): WorkflowSessionLauncher {
  return { launch };
}

function fakeGateAsk(proposal: {
  outcome: "approved" | "rejected";
  reason: string;
  issueRefs?: string[];
  inputsConsidered?: string[];
}): ShadowAsk {
  return {
    async ask() {
      return {
        text: JSON.stringify({
          reasoning: `gate evaluated to ${proposal.outcome} on the source step output`,
          outcome: proposal.outcome,
          reason: proposal.reason,
          issueRefs: proposal.issueRefs ?? [],
          inputsConsidered: proposal.inputsConsidered ?? ["sourceStepOutput"],
        }),
      };
    },
  };
}

function makeEngineWithAsk(
  broker: Pick<OrchestrationTransportBroker, "propose">,
  shadowAsk: ShadowAsk | undefined,
  launcher: WorkflowSessionLauncher = makeLauncher()
): DispatchEngine {
  return new DispatchEngine(
    broker,
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined,
    shadowAsk
  );
}

function makeEngine(
  broker: Pick<OrchestrationTransportBroker, "propose">,
  launcher: WorkflowSessionLauncher = makeLauncher()
): DispatchEngine {
  return new DispatchEngine(
    broker,
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined
  );
}

/**
 * Graph: analysis -> validation -> gate
 *   gate: approved -> splitter 'route' (branches ["go_a","go_b"])
 *     route --go_a--> branch_a (terminal) ; route --go_b--> branch_b (terminal)
 *   rejected -> analysis
 */
function gateSplitterGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
      { id: "validation", type: "step", name: "Validation", stepId: "validation" },
      { id: "gate", type: "gate", name: "Review Gate", instructions: "Approve to route." },
      {
        id: "route",
        type: "splitter",
        name: "Route",
        instructions: "Pick a branch.",
        branches: ["go_a", "go_b"],
      },
      { id: "branch_a", type: "step", name: "Branch A", stepId: "branch_a", terminal: true },
      { id: "branch_b", type: "step", name: "Branch B", stepId: "branch_b", terminal: true },
    ],
    edges: [
      { from: "analysis", to: "validation" },
      { from: "validation", to: "gate" },
      { from: "gate", to: "route", port: "approved" },
      { from: "gate", to: "analysis", port: "rejected" },
      { from: "route", to: "branch_a", port: "go_a" },
      { from: "route", to: "branch_b", port: "go_b" },
    ],
    positions: {},
  };
}

/** Seed a run positioned at the active `validation` step with a step_output artifact (gate→splitter graph). */
function seedRunAtValidationForSplitter(db: Database.Database) {
  const steps = [
    step("analysis", 0),
    step("validation", 1),
    step("branch_a", 2),
    step("branch_b", 3),
  ];
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(gateSplitterGraph()), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-validation', 'validation', 'step', 0, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-validation', 'goal-1', 'run-1', 'validation', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-validation', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-val', 'goal-1', 'run-1', 'step-validation', 'step_output', 'Validation', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ result: "all good", _completion: {} }), NOW);
}

/**
 * Graph: analysis -> execution -> validation -> gate
 *   gate: approved -> done (terminal), rejected -> execution
 */
function gateGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
      { id: "execution", type: "step", name: "Execution", stepId: "execution" },
      { id: "validation", type: "step", name: "Validation", stepId: "validation" },
      { id: "gate", type: "gate", name: "Review Gate", instructions: "Approve if validation passed." },
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
  };
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

/** Seed a run positioned at the `validation` step holding a step_output artifact. */
function seedRunAtValidation(db: Database.Database) {
  const steps = [step("analysis", 0), step("execution", 1), step("validation", 2), step("done", 3)];
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(gateGraph()), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-validation', 'validation', 'step', 0, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-validation', 'goal-1', 'run-1', 'validation', 2, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-validation', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);
  // A prior execution attempt (attempt 1) so revisit numbering starts at 2.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-execution', 'goal-1', 'run-1', 'execution', 1, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-execution')"
  ).run(NOW, NOW);
  // step_output artifact on the active validation step.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-val', 'goal-1', 'run-1', 'step-validation', 'step_output', 'Validation', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ result: "all good", _completion: {} }), NOW);
}

/** Seed a run positioned at the terminal `done` step holding a step_output artifact. */
function seedRunAtTerminalDoneStep(db: Database.Database) {
  const steps = [step("analysis", 0), step("execution", 1), step("validation", 2), step("done", 3)];
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(gateGraph()), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-done', 'done', 'step', 0, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-done', 'goal-1', 'run-1', 'done', 3, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-done', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);
  // step_output artifact on the active terminal step → branch (1) routes to commitAdvanceOrComplete.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-done', 'goal-1', 'run-1', 'step-done', 'step_output', 'Done', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ result: "complete", _completion: {} }), NOW);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService gate routing", () => {
  it("parks at the gate awaiting a human decision (no auto-eval), then approves to the terminal step", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // Reaching the gate parks the run for a human decision — no LLM was called,
    // no gate decision recorded yet, cursor parked on the gate.
    const parked = db
      .prepare(
        "SELECT current_node_id, current_node_kind, current_step_run_id, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'"
      )
      .get() as {
      current_node_id: string;
      current_node_kind: string;
      current_step_run_id: string | null;
      pending_gate_route_json: string | null;
    };
    expect(parked.current_node_id).toBe("gate");
    expect(parked.current_node_kind).toBe("gate");
    expect(parked.current_step_run_id).toBeNull();
    expect(JSON.parse(parked.pending_gate_route_json!)).toMatchObject({
      awaitingHumanDecision: true,
      gateNodeId: "gate",
      sourceStepRunId: "step-validation",
    });
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);

    // A paused gate-decision activity is parked on the source step (persisted so
    // the chat can rebuild the Approve/Reject card after a daemon restart).
    const activity = db
      .prepare(
        "SELECT source_kind FROM activities WHERE step_run_id = 'step-validation' AND status = 'paused_for_input' LIMIT 1"
      )
      .get() as { source_kind: string } | undefined;
    expect(activity?.source_kind).toBe("gate_decision_pending");

    // User approves → decision recorded, cursor routed to the terminal step.
    await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "gate",
      outcome: "approved",
      selectedEdgeTo: "done",
      traversalSeq: 1,
    });
    const run = db
      .prepare("SELECT current_node_id, current_node_kind, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string; pending_gate_route_json: string | null };
    expect(run.current_node_id).toBe("done");
    expect(run.current_node_kind).toBe("step");
    expect(run.pending_gate_route_json).toBeNull();

    // The decision persists as a completed gate_decision activity card so it
    // remains in the chat thread (and survives a daemon restart).
    const decisionCard = db
      .prepare(
        "SELECT status, source_kind, final_summary FROM activities WHERE step_run_id = 'step-validation' AND source_kind = 'gate_decision' LIMIT 1"
      )
      .get() as { status: string; source_kind: string; final_summary: string } | undefined;
    expect(decisionCard?.status).toBe("completed");
    expect(decisionCard?.final_summary).toMatch(/Approved/i);
  });

  it("decideGate is idempotent: a second submit does not double-route", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    const first = await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory });
    // Second submit is a no-op (stash already cleared) — and SAYS so.
    const second = await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory });

    expect(first).toEqual({ applied: true });
    expect(second).toEqual({ applied: false, reason: "no_pending_gate" });
    const doneRuns = db
      .prepare("SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'done'")
      .all() as Array<{ attempt: number }>;
    expect(doneRuns).toHaveLength(1);
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(1);
  });

  it("decideGate reports the truth instead of ok on every silent no-op branch", async () => {
    // Live race (2026-07-07 e2e): a decide POSTed while the L5 gate evaluation
    // was still in flight returned ok:true yet did nothing — the caller had no
    // signal to retry. Approvals must be auditable state transitions.
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const engine = makeEngine(fakeStepBroker());

    expect(await engine.decideGate(db, () => NOW, "missing-run", "approved", { bus, idFactory }))
      .toEqual({ applied: false, reason: "run_not_found" });

    // No stash yet (gate not reached) → no pending gate.
    expect(await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory }))
      .toEqual({ applied: false, reason: "no_pending_gate" });

    // Simulate the in-flight L5 evaluation stash (not a human park).
    db.prepare("UPDATE workflow_runs SET pending_gate_route_json = ? WHERE id = 'run-1'").run(
      JSON.stringify({ awaitingHumanDecision: false, gateNodeId: "gate", sourceStepRunId: "step-validation" })
    );
    expect(await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory }))
      .toEqual({ applied: false, reason: "gate_evaluation_in_flight" });
  });

  it("confirmGate does not auto-route a human-gated park", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtValidation(db);
    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    // Continue must NOT resolve a human gate — only decideGate can.
    await engine.confirmGate(db, () => NOW, "run-1", { bus, idFactory });

    const run = db
      .prepare("SELECT current_node_kind, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_kind: string; pending_gate_route_json: string | null };
    expect(run.current_node_kind).toBe("gate");
    expect(run.pending_gate_route_json).not.toBeNull();
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
  });

  it("emits a mark_run_complete recommendation when the terminal step finishes, without completing the run", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtTerminalDoneStep(db);
    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const rec = db
      .prepare(
        "SELECT type FROM recommendations WHERE goal_id = ? ORDER BY rowid DESC LIMIT 1"
      )
      .get("goal-1") as { type: string } | undefined;
    expect(rec?.type).toBe("complete_workflow_run");

    const runAfter = db
      .prepare("SELECT status, current_node_id, current_node_kind FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; current_node_id: string | null; current_node_kind: string | null };
    // Not completed until the user approves the recommendation; cursor still parked on the terminal step.
    expect(runAfter.status).toBe("active");
    expect(runAfter.current_node_id).toBe("done");
    expect(runAfter.current_node_kind).toBe("step");
  });

  it("routes a rejected gate backward to a fresh Execution attempt", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await engine.decideGate(db, () => NOW, "run-1", "rejected", { bus, idFactory });

    const execRuns = db
      .prepare(
        "SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = ? AND step_template_id = 'execution' ORDER BY attempt"
      )
      .all("run-1") as Array<{ attempt: number }>;
    expect(execRuns.map((r) => r.attempt)).toEqual([1, 2]);

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({
      outcome: "rejected",
      selectedEdgeTo: "execution",
    });
  });

  it("surfaces the prior step output and the user's rejection reason on a backward revisit", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const launch = vi.fn(async (_ctx: WorkflowLaunchContext) => ({ sessionId: "sess-1" }));
    const engine = makeEngine(fakeStepBroker(), makeLauncher(launch));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await engine.decideGate(db, () => NOW, "run-1", "rejected", {
      bus,
      idFactory,
      reason: "bug in parser",
    });

    // The fresh Execution attempt's agent was launched with a composed objective.
    expect(launch).toHaveBeenCalledTimes(1);
    const objective = launch.mock.calls[0]![0].objective;

    // Prior-artifact selection includes the DOWNSTREAM validation output.
    expect(objective).toMatch(/prior step: validation/);
    expect(objective).toMatch(/all good/);

    // The user's rejection reason is surfaced as repair context.
    expect(objective).toMatch(/Repair context/);
    expect(objective).toMatch(/bug in parser/);
  });

  it("records the current committed ledger_version on the gate decision", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);

    // Commit two ledger versions before the gate is evaluated so the run's
    // ledger_version is 2 (a non-zero value a hardcoded 0 would not match).
    commitLedgerVersion(db, () => NOW, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      sourceStepRunId: "step-validation",
      traversalSeq: 0,
      updates: [
        {
          operation: "create",
          record_type: "requirement",
          record_id: "req-local-1",
          status: "open",
          note: "Initial requirement",
          evidence_refs: [],
          related_record_ids: [],
        },
      ],
    });
    commitLedgerVersion(db, () => NOW, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      sourceStepRunId: "step-validation",
      traversalSeq: 0,
      updates: [
        {
          operation: "create",
          record_type: "finding",
          record_id: "fnd-local-1",
          status: "open",
          note: "A finding",
          evidence_refs: [],
          related_record_ids: [],
        },
      ],
    });

    const committedVersion = latestCommittedLedger(db, "run-1").version;
    expect(committedVersion).toBe(2);

    const engine = makeEngine(fakeStepBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)?.ledgerVersion).toBe(committedVersion);
  });

  it("gate→splitter: decideGate approved routes through the splitter to the chosen branch step", async () => {
    const { db, bus, idFactory } = setupHarness();
    // Unsupervised: the splitter evaluates inline (no confirmSplit needed).
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidationForSplitter(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const engine = makeEngine(fakeStepAndSplitBroker("go_a"));

    // Advance the run to the gate (scores validation step, parks at gate).
    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const parked = db
      .prepare(
        "SELECT current_node_id, current_node_kind, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'"
      )
      .get() as { current_node_id: string; current_node_kind: string; pending_gate_route_json: string | null };
    expect(parked.current_node_id).toBe("gate");
    expect(parked.current_node_kind).toBe("gate");
    expect(parked.pending_gate_route_json).not.toBeNull();

    // User approves → gate routes to splitter → splitter evaluates inline → branch_a step inserted.
    await engine.decideGate(db, () => NOW, "run-1", "approved", { bus, idFactory });

    const after = db
      .prepare("SELECT status, current_node_id, current_node_kind, blocked_reason FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; current_node_id: string; current_node_kind: string; blocked_reason: string | null };
    // Run must NOT be blocked.
    expect(after.status).not.toBe("blocked");
    expect(after.blocked_reason).toBeNull();
    // Cursor landed on branch_a.
    expect(after.current_node_id).toBe("branch_a");
    expect(after.current_node_kind).toBe("step");

    // A step run for branch_a was created.
    const branchARuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'branch_a'")
      .all() as Array<{ id: string }>;
    expect(branchARuns).toHaveLength(1);

    // A gate decision was recorded pointing at the splitter node.
    const gateDecisions = listGateDecisionsForRun(db, "run-1");
    expect(gateDecisions).toHaveLength(1);
    expect(gateDecisions[0]).toMatchObject({ nodeId: "gate", outcome: "approved", selectedEdgeTo: "route" });

    // A split decision was recorded for the splitter choosing branch_a.
    const splitDecisions = listSplitDecisionsForRun(db, "run-1");
    expect(splitDecisions).toHaveLength(1);
    expect(splitDecisions[0]).toMatchObject({ nodeId: "route", selectedBranch: "go_a", selectedEdgeTo: "branch_a" });
  });

  it("L5 automated: gate auto-approves into an unsupervised splitter and launches the branch step exactly once", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidationForSplitter(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    // A real workspace so the launcher can record a `sessions` row per call, which
    // makes commitAgentStepDecision's "running session linked?" no-op guard behave
    // as it does in production (the fake launcher in makeLauncher() does not
    // persist a session row, so that guard never fires and a benign, separately
    // guarded recursion path would otherwise inflate the launch count).
    db.prepare(
      "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1', '/tmp/ws-1', 'ws-1', '', ?, ?)"
    ).run(NOW, NOW);
    let sessionSeq = 0;
    const launch = vi.fn(async (ctx: WorkflowLaunchContext) => {
      const sessionId = `sess-${++sessionSeq}`;
      db.prepare(
        "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, ?, 'ws-1', 'claude-code', 'Session', 'running', ?, ?)"
      ).run(sessionId, ctx.goalId, NOW, ctx.workflowStepRunId);
      return { sessionId };
    });
    const engine = makeEngineWithAsk(
      fakeStepAndSplitBroker("go_a"),
      fakeGateAsk({ outcome: "approved", reason: "ok" }),
      makeLauncher(launch)
    );

    // Advance the run: scores validation, parks at the gate, auto-evaluates it
    // (approved), routes into the splitter, which evaluates inline (unsupervised)
    // and routes to branch_a — launching its agent. Must NOT also be launched a
    // second time by the gate's own inline-route tail.
    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const after = getWorkflowRunById(db, "run-1")!;
    expect(after.status).toBe("active");
    expect(after.currentNodeId).toBe("branch_a");

    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("OrchestratorService automated gate evaluation (L5)", () => {
  let db: Database.Database;
  let bus: ReturnType<typeof setupHarness>["bus"];
  let idFactory: ReturnType<typeof setupHarness>["idFactory"];

  beforeEach(() => {
    ({ db, bus, idFactory } = setupHarness());
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
  });

  /** Drives the run so the validation step completes and the cursor reaches the gate. */
  async function advanceRunToGate(engine: DispatchEngine): Promise<void> {
    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
  }

  it("approves and routes forward without a human decision", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const engine = makeEngineWithAsk(fakeStepBroker(), fakeGateAsk({ outcome: "approved", reason: "Meets the goal." }));
    await advanceRunToGate(engine);

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({ nodeId: "gate", outcome: "approved" });
    const run = getWorkflowRunById(db, "run-1")!;
    expect(run.status).toBe("active"); // routed forward, not parked awaiting a human
    expect(db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get())
      .toMatchObject({ pending_gate_route_json: null });
  });

  it("rejects, records the enumerated issueRefs, and routes back to the closing step", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const engine = makeEngineWithAsk(
      fakeStepBroker(),
      fakeGateAsk({ outcome: "rejected", reason: "Missing tests.", issueRefs: ["missing-tests", "no-error-handling"] })
    );
    await advanceRunToGate(engine);

    const decision = listGateDecisionsForRun(db, "run-1").at(-1)!;
    expect(decision.outcome).toBe("rejected");
    expect(decision.issueRefs).toEqual(["missing-tests", "no-error-handling"]);
    expect(latestRejectingGate(db, "run-1")).toEqual({
      reason: "Missing tests.",
      issueRefs: ["missing-tests", "no-error-handling"],
    });
  });

  it("falls back to a human park when the evaluator returns null", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const brokenAsk: ShadowAsk = { async ask() { throw new Error("shadow down"); } };
    const engine = makeEngineWithAsk(fakeStepBroker(), brokenAsk);
    // evaluateGate logs one [gate-eval] observability line before returning null;
    // silence it for pristine output and assert the fallback was surfaced.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await advanceRunToGate(engine);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[gate-eval]"));
    warnSpy.mockRestore();

    // No automated decision recorded; the run is parked awaiting a human decideGate.
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const stash = db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string | null };
    expect(JSON.parse(stash.pending_gate_route_json!)).toMatchObject({ awaitingHumanDecision: true });
  });

  it("L4 human_review still parks for a human decideGate (no auto-eval)", async () => {
    // operating_mode left at default (human_review); shadowAsk present but must NOT be consulted.
    const asked = { n: 0 };
    const spyAsk: ShadowAsk = { async ask() { asked.n += 1; return { text: "{}" }; } };
    const engine = makeEngineWithAsk(fakeStepBroker(), spyAsk);
    await advanceRunToGate(engine);

    expect(asked.n).toBe(0);
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const stash = db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string | null };
    expect(JSON.parse(stash.pending_gate_route_json!)).toMatchObject({ awaitingHumanDecision: true });
  });

  it("blocks the run after GATE_REJECT_CAP rejections (honest termination)", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    // Pre-seed GATE_REJECT_CAP - 1 prior rejections on this gate so the next reject trips the cap.
    for (let i = 0; i < GATE_REJECT_CAP - 1; i++) {
      recordGateDecision(db, () => NOW, {
        goalId: "goal-1", workflowRunId: "run-1", nodeId: "gate",
        traversalSeq: nextTraversalSeq(db, "run-1"), outcome: "rejected",
        reason: `prior reject ${i}`, reasoning: null, selectedEdgeTo: "execution",
        inputsConsidered: [], issueRefs: [`old-${i}`], ledgerVersion: 0,
      });
    }
    const engine = makeEngineWithAsk(
      fakeStepBroker(),
      fakeGateAsk({ outcome: "rejected", reason: "Still failing.", issueRefs: ["missing-tests"] }),
    );
    await advanceRunToGate(engine);

    const run = getWorkflowRunById(db, "run-1")!;
    expect(run.status).toBe("blocked");
    // The last recorded gate decision is still the pre-seeded set — the tripping reject does NOT re-route.
    const rejects = listGateDecisionsForRun(db, "run-1").filter((d) => d.outcome === "rejected");
    expect(rejects).toHaveLength(GATE_REJECT_CAP - 1);
  });

  it("blocks early on stagnation (identical unresolved issues recur) before the cap", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    // ONE prior rejection (well under GATE_REJECT_CAP=3) with the SAME issue set the evaluator repeats.
    recordGateDecision(db, () => NOW, {
      goalId: "goal-1", workflowRunId: "run-1", nodeId: "gate",
      traversalSeq: nextTraversalSeq(db, "run-1"), outcome: "rejected",
      reason: "first pass", reasoning: null, selectedEdgeTo: "execution",
      inputsConsidered: [], issueRefs: ["missing-tests"], ledgerVersion: 0,
    });
    const engine = makeEngineWithAsk(
      fakeStepBroker(),
      fakeGateAsk({ outcome: "rejected", reason: "Same problem.", issueRefs: ["missing-tests"] }),
    );
    await advanceRunToGate(engine);

    // Stagnation (same unresolved issue) trips the block even though the cap is not reached.
    expect(getWorkflowRunById(db, "run-1")!.status).toBe("blocked");
    expect(listGateDecisionsForRun(db, "run-1").filter((d) => d.outcome === "rejected")).toHaveLength(1);
  });
});
