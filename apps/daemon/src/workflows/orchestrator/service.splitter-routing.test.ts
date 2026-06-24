import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor, OperatorSelection, WorkflowGraph } from "@orca/contracts";
import { OrchestratorService } from "./service.js";
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
import type { SelectorInput } from "../operators/selector.js";
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
    const service = makeService(fakeSplitBroker("go_a"));

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

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
    await service.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });

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
    const service = makeService(fakeSplitBroker("go_b"));

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

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

  it("undeclared branch: blocks the run with a clear reason, no decision recorded, no route taken", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedRunAtSource(db);
    // Broker keeps proposing an undeclared branch; validateProposal rejects it on
    // both attempts, so the run blocks.
    const service = makeService(fakeSplitBroker("go_nowhere"));

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const run = db
      .prepare("SELECT status, blocked_reason, current_node_kind FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; blocked_reason: string | null; current_node_kind: string };
    expect(run.status).toBe("blocked");
    expect(run.blocked_reason).toMatch(/splitter route evaluation failed/i);

    // No split decision recorded, no branch step run created.
    expect(listSplitDecisionsForRun(db, "run-1")).toHaveLength(0);
    const branchRuns = db
      .prepare(
        "SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id IN ('a', 'b')"
      )
      .all() as Array<{ id: string }>;
    expect(branchRuns).toHaveLength(0);
  });

  it("confirmSplit is idempotent: a second call after the stash is cleared is a no-op", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "supervised", NOW);
    seedRunAtSource(db);
    const service = makeService(fakeSplitBroker("go_a"));

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    await service.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });
    // Second confirm is a no-op (stash already cleared).
    await service.confirmSplit(db, () => NOW, "run-1", { bus, idFactory });

    const aRuns = db
      .prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id = 'run-1' AND step_template_id = 'a'")
      .all() as Array<{ id: string }>;
    expect(aRuns).toHaveLength(1);
    expect(listSplitDecisionsForRun(db, "run-1")).toHaveLength(1);
  });
});
