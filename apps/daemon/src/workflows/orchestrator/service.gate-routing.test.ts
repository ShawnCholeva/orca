import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, OperatorSelection, WorkflowGraph } from "@orca/contracts";
import type { WorkflowLaunchContext, WorkflowSessionLauncher } from "./session-launcher.js";
import { OrchestratorService } from "./service.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { setSupervisionMode } from "../../settings/store.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  makeStep,
  fakeStepDispatch,
  type SkillStep,
} from "./skill-step-test-helpers.js";
import type { SelectorInput } from "../operators/selector.js";
import type {
  BrokerCompatibilityOptions,
  OrchestrationTransportBroker,
} from "../orchestration-transport/broker.js";
import { commitLedgerVersion } from "../ledger/usecases.js";
import { latestCommittedLedger } from "../ledger/projection.js";

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

function fakeAgentSelector(): Pick<
  {
    select: (
      db: Database.Database,
      now: () => string,
      input: SelectorInput
    ) => Promise<{ selection: OperatorSelection; source: "fallback" | "llm" }>;
  },
  "select"
> {
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

/**
 * Broker that returns a gate proposal for evaluate_gate requests and a benign
 * step-scoring proposal otherwise, so the run can reach the gate.
 */
function fakeGateBroker(gate: {
  outcome: "approved" | "rejected";
  reason: string;
  inputsConsidered: string[];
  issueRefs?: string[];
}): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(request: unknown, options?: BrokerCompatibilityOptions) {
      const kind = (request as { kind?: string }).kind;
      const proposal =
        kind === "evaluate_gate"
          ? {
              outcome: gate.outcome,
              reason: gate.reason,
              inputsConsidered: gate.inputsConsidered,
              ...(gate.issueRefs ? { issueRefs: gate.issueRefs } : {}),
            }
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

function makeLauncher(launch = vi.fn(async () => ({ sessionId: "sess-1" }))): WorkflowSessionLauncher {
  return { launch };
}

function makeService(
  broker: Pick<OrchestrationTransportBroker, "propose">,
  launcher: WorkflowSessionLauncher = makeLauncher()
): OrchestratorService {
  return new OrchestratorService(
    fakeAgentSelector(),
    broker,
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    undefined,
    fakeStepDispatch()
  );
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
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
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
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
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
  it("routes through a gate and approves to the terminal step", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const service = makeService(
      fakeGateBroker({ outcome: "approved", reason: "validation passed", inputsConsidered: ["validation"] })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "gate",
      outcome: "approved",
      selectedEdgeTo: "done",
      traversalSeq: 1,
    });
    // Cursor moved to the terminal `done` step.
    const run = db
      .prepare("SELECT current_node_id, current_node_kind FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string };
    expect(run.current_node_id).toBe("done");
    expect(run.current_node_kind).toBe("step");
  });

  it("emits a mark_run_complete recommendation when the terminal step finishes, without completing the run", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtTerminalDoneStep(db);
    const service = makeService(
      fakeGateBroker({ outcome: "approved", reason: "n/a", inputsConsidered: [] })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

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
    const service = makeService(
      fakeGateBroker({
        outcome: "rejected",
        reason: "bug",
        inputsConsidered: ["validation"],
        issueRefs: ["i1"],
      })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

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
      issueRefs: ["i1"],
    });
  });

  it("includes the latest downstream step output and the rejecting gate reason on a revisit", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtValidation(db);
    const launch = vi.fn(async (_ctx: WorkflowLaunchContext) => ({ sessionId: "sess-1" }));
    const service = makeService(
      fakeGateBroker({
        outcome: "rejected",
        reason: "bug in parser",
        inputsConsidered: ["validation"],
        issueRefs: ["i1"],
      }),
      makeLauncher(launch)
    );

    await service.advanceToNextStep(db, () => NOW, "run-1", { bus, idFactory });

    // The fresh Execution attempt's agent was launched with a composed objective.
    expect(launch).toHaveBeenCalledTimes(1);
    const objective = launch.mock.calls[0]![0].objective;

    // Prior-artifact selection includes the DOWNSTREAM validation output (higher
    // ordinal) — the recency-based collector no longer filters it out.
    expect(objective).toMatch(/prior step: validation/);
    expect(objective).toMatch(/all good/);

    // The rejecting gate reason + issue refs are surfaced as repair context.
    expect(objective).toMatch(/Repair context/);
    expect(objective).toMatch(/bug in parser/);
    expect(objective).toMatch(/i1/);
  });

  it("supervised: records the gate decision but pauses before routing to the destination", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtValidation(db);
    const service = makeService(
      fakeGateBroker({ outcome: "approved", reason: "validation passed", inputsConsidered: ["validation"] })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // Decision is recorded with the resolved destination edge.
    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "gate",
      outcome: "approved",
      selectedEdgeTo: "done",
      traversalSeq: 1,
    });

    // Cursor stays parked on the gate; destination step is NOT routed/spawned.
    const run = db
      .prepare(
        "SELECT current_node_id, current_node_kind, current_step_run_id, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'"
      )
      .get() as {
      current_node_id: string;
      current_node_kind: string;
      current_step_run_id: string | null;
      pending_gate_route_json: string | null;
    };
    expect(run.current_node_id).toBe("gate");
    expect(run.current_node_kind).toBe("gate");
    expect(run.current_step_run_id).toBeNull();

    // Route stash is set for the Continue path.
    expect(run.pending_gate_route_json).not.toBeNull();
    const stash = JSON.parse(run.pending_gate_route_json!) as {
      gateNodeId: string;
      outcome: string;
      destNodeId: string;
      traversalSeq: number;
    };
    expect(stash).toMatchObject({
      gateNodeId: "gate",
      outcome: "approved",
      destNodeId: "done",
      traversalSeq: 1,
    });

    // No destination step_run row exists yet.
    const doneRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'done'")
      .all();
    expect(doneRuns).toHaveLength(0);

    // A paused confirmation activity is parked on the source step.
    const activity = db
      .prepare(
        "SELECT status, source_kind FROM activities WHERE step_run_id = 'step-validation' AND status = 'paused_for_input' LIMIT 1"
      )
      .get() as { status: string; source_kind: string } | undefined;
    expect(activity?.source_kind).toBe("step_confirmation_pending");
  });

  it("supervised: confirmGate consumes the stash and routes to the destination, idempotently", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtValidation(db);
    const service = makeService(
      fakeGateBroker({ outcome: "approved", reason: "validation passed", inputsConsidered: ["validation"] })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    // Continue.
    await service.confirmGate(db, () => NOW, "run-1", { bus, idFactory });

    // Cursor advanced to the terminal `done` step; stash cleared.
    const run = db
      .prepare("SELECT current_node_id, current_node_kind, pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string; pending_gate_route_json: string | null };
    expect(run.current_node_id).toBe("done");
    expect(run.current_node_kind).toBe("step");
    expect(run.pending_gate_route_json).toBeNull();

    const doneRuns = db
      .prepare("SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'done'")
      .all() as Array<{ attempt: number }>;
    expect(doneRuns).toHaveLength(1);

    // Double-Continue is a no-op: no second destination attempt.
    await service.confirmGate(db, () => NOW, "run-1", { bus, idFactory });
    const doneRunsAfter = db
      .prepare("SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'done'")
      .all() as Array<{ attempt: number }>;
    expect(doneRunsAfter).toHaveLength(1);
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

    const service = makeService(
      fakeGateBroker({ outcome: "approved", reason: "validation passed", inputsConsidered: ["validation"] })
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)?.ledgerVersion).toBe(committedVersion);
  });
});
