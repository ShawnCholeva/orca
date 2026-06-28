import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, WorkflowGraph } from "@orca/contracts";
import { DispatchEngine } from "./dispatch-engine.js";
import { listSplitDecisionsForRun } from "../splitters/projection.js";
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
import type { WorkflowSessionLauncher } from "./session-launcher.js";

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
 * Broker that scores the active step (so the run advances to the splitter) and,
 * when the splitter is evaluated, returns a `proposed` SplitEvaluationProposal
 * selecting the configured branch. `selectedBranch` is configurable so a test
 * can drive an undeclared-branch path.
 */
function fakeSplitBroker(selectedBranch: string): Pick<OrchestrationTransportBroker, "propose"> {
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
      if (!validated.accepted) {
        // A rejected proposal surfaces as a non-"proposed" BrokerResult; the
        // service retries once and then blocks the run.
        return {
          status: "needs_human_review" as const,
          attemptId: "attempt-1",
          reviewPayloadId: "review-1",
        };
      }
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
 * Broker whose automated transports always fail (mirrors production, where no
 * LLM transport runner is wired into the broker). Any `evaluate_split` that
 * reaches this broker blocks the run — so a passing deterministic-routing test
 * proves the branch was chosen WITHOUT the broker.
 */
function unwiredBroker(): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose() {
      return { status: "needs_human_review" as const, attemptId: "a1", reviewPayloadId: "r1" };
    },
  };
}

function makeLauncher(launch = vi.fn(async () => ({ sessionId: "sess-1" }))): WorkflowSessionLauncher {
  return { launch };
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
 * Graph: s0 -> splitter 'route' (branches ["go_a","go_b"])
 *   route --go_a--> a (terminal-feeding) ; route --go_b--> b
 *   a -> done ; b -> done (terminal)
 */
function splitterGraph(): WorkflowGraph {
  return {
    nodes: [
      { id: "s0", type: "step", name: "Source", stepId: "s0" },
      {
        id: "route",
        type: "splitter",
        name: "Route",
        instructions: "Pick a branch.",
        branches: ["go_a", "go_b"],
      },
      { id: "a", type: "step", name: "A", stepId: "a" },
      { id: "b", type: "step", name: "B", stepId: "b" },
      { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
    ],
    edges: [
      { from: "s0", to: "route" },
      { from: "route", to: "a", port: "go_a" },
      { from: "route", to: "b", port: "go_b" },
      { from: "a", to: "done" },
      { from: "b", to: "done" },
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

/** Seed a run positioned at the active `s0` step holding a step_output artifact. */
function seedRunAtSource(db: Database.Database) {
  const steps = [step("s0", 0), step("a", 1), step("b", 2), step("done", 3)];
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(splitterGraph()), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-s0', 's0', 'step', 0, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-s0', 'goal-1', 'run-1', 's0', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-s0', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-s0', 'goal-1', 'run-1', 'step-s0', 'step_output', 'Source', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(JSON.stringify({ result: "source done", _completion: {} }), NOW);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService splitter routing", () => {
  it("supervised: parks at the splitter with a confirmation card, then confirmSplit routes to the chosen branch", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtSource(db);
    const engine = makeEngine(fakeSplitBroker("go_a"));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    // The run parks at the splitter awaiting a human Continue: cursor on the
    // splitter, no active step run, the deferred route stashed.
    const parked = db
      .prepare(
        "SELECT current_node_id, current_node_kind, current_step_run_id, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'"
      )
      .get() as {
      current_node_id: string;
      current_node_kind: string;
      current_step_run_id: string | null;
      pending_split_route_json: string | null;
    };
    expect(parked.current_node_kind).toBe("splitter");
    expect(parked.current_node_id).toBe("route");
    expect(parked.current_step_run_id).toBeNull();
    expect(JSON.parse(parked.pending_split_route_json!)).toMatchObject({
      splitterNodeId: "route",
      selectedBranch: "go_a",
      destNodeId: "a",
      destKind: "step",
      sourceStepRunId: "step-s0",
    });

    // The split decision is recorded.
    const decisions = listSplitDecisionsForRun(db, "run-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      nodeId: "route",
      selectedBranch: "go_a",
      selectedEdgeTo: "a",
    });

    // A paused_for_input confirmation activity exists for the source step run
    // (proves the supervised-card guarantee).
    const pausedActivity = db
      .prepare(
        "SELECT id, status, source_kind FROM activities WHERE step_run_id = 'step-s0' AND status = 'paused_for_input' LIMIT 1"
      )
      .get() as { id: string; status: string; source_kind: string } | undefined;
    expect(pausedActivity?.status).toBe("paused_for_input");
    expect(pausedActivity?.source_kind).toBe("step_confirmation_pending");

    // Continue: confirmSplit clears the stash and routes to step 'a'.
    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });

    const after = db
      .prepare("SELECT current_node_id, current_node_kind, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string; pending_split_route_json: string | null };
    expect(after.current_node_id).toBe("a");
    expect(after.current_node_kind).toBe("step");
    expect(after.pending_split_route_json).toBeNull();

    // A step run for branch 'a' was spawned.
    const aRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'a'")
      .all() as Array<{ id: string }>;
    expect(aRuns).toHaveLength(1);

    // The confirmation activity is resolved (no longer paused).
    const stillPaused = db
      .prepare(
        "SELECT id FROM activities WHERE step_run_id = 'step-s0' AND status = 'paused_for_input' LIMIT 1"
      )
      .get() as { id: string } | undefined;
    expect(stillPaused).toBeUndefined();
  });

  it("unsupervised: routes inline to the chosen branch immediately, no stash", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    const engine = makeEngine(fakeSplitBroker("go_b"));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const run = db
      .prepare("SELECT current_node_id, current_node_kind, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string; pending_split_route_json: string | null };
    expect(run.current_node_id).toBe("b");
    expect(run.current_node_kind).toBe("step");
    expect(run.pending_split_route_json).toBeNull();

    const bRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'b'")
      .all() as Array<{ id: string }>;
    expect(bRuns).toHaveLength(1);

    const decisions = listSplitDecisionsForRun(db, "run-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ selectedBranch: "go_b", selectedEdgeTo: "b" });
  });

  it("undecidable splitter: parks for a HUMAN routing choice (no block, no default)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    // No branchKey on the route + an unwired broker (as in production) → neither
    // deterministic routing nor the orchestrator can decide. The run must NOT
    // block or default: it parks awaiting a human routing choice.
    const engine = makeEngine(unwiredBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const run = db
      .prepare("SELECT status, current_node_kind, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; current_node_kind: string; pending_split_route_json: string | null };
    expect(run.status).toBe("active"); // parked, NOT blocked
    expect(run.current_node_kind).toBe("splitter");
    const stash = JSON.parse(run.pending_split_route_json!);
    expect(stash.needsHumanChoice).toBe(true);
    expect(stash.options.map((o: { branch: string }) => o.branch)).toEqual(["go_a", "go_b"]);
    expect(stash.options.map((o: { label: string }) => o.label)).toEqual(["A", "B"]); // labeled by dest step
    // No decision and no branch step run until the user picks.
    expect(listSplitDecisionsForRun(db, "run-1")).toHaveLength(0);
    expect(
      db.prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id='run-1' AND step_template_id IN ('a','b')").all()
    ).toHaveLength(0);
  });

  it("undecidable splitter: confirmSplit(branch) routes to the chosen branch and spawns its worker", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    const launch = vi.fn(async (_input: { workflowRunId: string }) => ({ sessionId: "sess-b" }));
    const engine = makeEngine(unwiredBroker(), makeLauncher(launch));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory }); // parks for choice
    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory }, "go_b");

    const run = db
      .prepare("SELECT current_node_id, current_node_kind, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_id: string; current_node_kind: string; pending_split_route_json: string | null };
    expect(run.current_node_id).toBe("b");
    expect(run.current_node_kind).toBe("step");
    expect(run.pending_split_route_json).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
    const decisions = listSplitDecisionsForRun(db, "run-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ selectedBranch: "go_b", selectedEdgeTo: "b" });
  });

  it("undecidable splitter: an invalid user branch is a no-op (stash retained, still parked)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    const engine = makeEngine(unwiredBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory }, "go_nowhere");

    const run = db
      .prepare("SELECT current_node_kind, pending_split_route_json FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_node_kind: string; pending_split_route_json: string | null };
    expect(run.current_node_kind).toBe("splitter"); // still parked
    expect(run.pending_split_route_json).not.toBeNull();
    expect(JSON.parse(run.pending_split_route_json!).needsHumanChoice).toBe(true);
    expect(listSplitDecisionsForRun(db, "run-1")).toHaveLength(0);
  });

  it("deterministic branchKey: routes from the source step's output without the broker", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
    // Route deterministically from the source step's `route_choice` output field.
    const graph = splitterGraph();
    const route = graph.nodes.find((n) => n.id === "route")!;
    (route as { branchKey?: string }).branchKey = "route_choice";
    db.prepare("UPDATE workflow_templates SET graph_json = ? WHERE id = 'orca/engineering'").run(
      JSON.stringify(graph)
    );
    db.prepare("UPDATE workflow_artifacts SET body = ? WHERE id = 'art-s0'").run(
      JSON.stringify({ result: "source done", route_choice: "go_b", _completion: {} })
    );
    // Broker always fails (as in production) — a successful route proves the
    // branch came from the deterministic output field, not an LLM call.
    const engine = makeEngine(unwiredBroker());

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const run = db
      .prepare("SELECT status, current_node_id, current_node_kind FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; current_node_id: string; current_node_kind: string };
    expect(run.status).toBe("active");
    expect(run.current_node_id).toBe("b");
    expect(run.current_node_kind).toBe("step");

    const decisions = listSplitDecisionsForRun(db, "run-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ selectedBranch: "go_b", selectedEdgeTo: "b" });

    const bRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'b'")
      .all() as Array<{ id: string }>;
    expect(bRuns).toHaveLength(1);
  });

  it("supervised: confirmSplit spawns the destination step's worker, not just an operator selection", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtSource(db);
    const launch = vi.fn(async (_input: { workflowRunId: string }) => ({ sessionId: "sess-a" }));
    const engine = makeEngine(fakeSplitBroker("go_a"), makeLauncher(launch));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(launch).not.toHaveBeenCalled(); // parked at the splitter awaiting Continue

    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });

    // Regression: confirmSplit previously called requestNextDecision, which only
    // SELECTS the operator on a fresh step and returns — so the worker was never
    // launched and the step hung "active" with no activity. It must spawn.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ workflowRunId: "run-1" });
  });

  it("confirmSplit is idempotent: a second call after the stash is cleared is a no-op", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtSource(db);
    const engine = makeEngine(fakeSplitBroker("go_a"));

    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });
    // Second confirm is a no-op (stash already cleared).
    await engine.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });

    const aRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'a'")
      .all() as Array<{ id: string }>;
    expect(aRuns).toHaveLength(1);
    expect(listSplitDecisionsForRun(db, "run-1")).toHaveLength(1);
  });
});
