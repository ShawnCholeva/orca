/**
 * End-to-end smoke test for the Adaptive Delivery template loop.
 *
 * Proves that the orca/adaptive-delivery graph specifically drives:
 *   - Release Readiness gate rejection → backward route to a fresh Execution attempt
 *   - Release Readiness gate approval → forward route to terminal Done
 *   - Terminal Done completion → mark_run_complete recommendation (human yield, no auto-complete)
 *
 * This file drives orca/adaptive-delivery end-to-end. It seeds runs at
 * key positions (validate_build, done) and asserts the gate routing and
 * run-complete recommendation behaviour specific to that template.
 */

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { setSupervisionMode } from "../../settings/store.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
} from "./skill-step-test-helpers.js";
import type {
  BrokerCompatibilityOptions,
  OrchestrationTransportBroker,
} from "../orchestration-transport/broker.js";
import { OrchestratorService } from "./service.js";
import type { OperatorDescriptor, OperatorSelection } from "@orca/contracts";
import type { SelectorInput } from "../operators/selector.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import type { StepDispatchCapabilities } from "./service.js";
import { installBuiltInTemplates } from "../templates/usecases.js";
import type { EventBus } from "../../events.js";

const ADAPTIVE_ID = "orca/adaptive-delivery";
// Must track the orca/adaptive-delivery version in catalog.ts / usecases.ts.
const ADAPTIVE_VERSION = 1;

const AGENT_OPERATOR_ID = "agent:claude-code";

// Adapter IDs used by the AD template steps (claude-code with various models).
const AD_ADAPTER = "claude-code";
const AD_MODELS = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]);

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
    reason: "agent selected",
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

function fakeGateBroker(outcome: "approved" | "rejected"): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(request: unknown, options?: BrokerCompatibilityOptions) {
      const kind = (request as { kind?: string }).kind;
      const proposal =
        kind === "evaluate_gate"
          ? {
              outcome,
              reason: outcome === "approved" ? "validation passed" : "bug found",
              inputsConsidered: ["validation"],
              ...(outcome === "rejected" ? { issueRefs: ["i1"] } : {}),
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

/** Supports all model IDs used by the AD template (sonnet, opus, haiku). */
function adStepDispatch(): StepDispatchCapabilities {
  return {
    async isAdapterReady(adapterId) {
      return adapterId === AD_ADAPTER;
    },
    supportsModel(adapterId, modelId) {
      return adapterId === AD_ADAPTER && AD_MODELS.has(modelId);
    },
    resolveMode(adapterId) {
      return { adapterId, mode: "one_shot", fallbacks: ["shadow_session"] };
    },
  };
}

function makeLauncher(): WorkflowSessionLauncher {
  return { launch: async () => ({ sessionId: "sess-fd" }) };
}

function makeService(
  broker: Pick<OrchestrationTransportBroker, "propose">
): OrchestratorService {
  const agentDescriptor: OperatorDescriptor = {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: [],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
  return new OrchestratorService(
    fakeAgentSelector(),
    broker,
    { async list() { return [agentDescriptor]; } },
    makeLauncher(),
    undefined,
    adStepDispatch()
  );
}

/**
 * Seed the AD template and a run positioned at the `validate_build` step with a
 * step_output artifact (the gate-routing trigger). A prior execution attempt
 * (attempt 1) exists so a rejection routes to attempt 2.
 */
function seedAdaptiveRunAtValidation(db: Database.Database, bus: EventBus): void {
  installBuiltInTemplates({ db, bus }, ["orca/adaptive-delivery"]);

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-fd', 'goal-fd', ?, ?, 'active', 'step-fd-validate_build', 'validate_build', 'step', 0, NULL, ?, NULL)"
  ).run(ADAPTIVE_ID, ADAPTIVE_VERSION, NOW);

  // Active validate_build step.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-fd-validate_build', 'goal-fd', 'run-fd', 'validate_build', 7, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-val', 'agent:claude-code', NULL, 'claude-opus-4-7', ?)"
  ).run(NOW, NOW);

  // Prior execution attempt (attempt 1, passed) so rejection creates attempt 2.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-fd-execution', 'goal-fd', 'run-fd', 'execution', 6, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-exec')"
  ).run(NOW, NOW);

  // step_output on the active validate_build step — triggers gate routing.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-fd-val', 'goal-fd', 'run-fd', 'step-fd-validate_build', 'step_output', 'Validate Build', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(
    JSON.stringify({
      summary: "Validation complete",
      verdict: "passed",
      requirement_results: [{ requirement_ref: "req-1", result: "passed", evidence: "tests pass" }],
      checks: [{ command: "pnpm test", result: "passed", evidence: "all green" }],
      handoff: "Ready for gate",
    }),
    NOW
  );
}

/**
 * Seed the AD template and a run positioned at the terminal `done` step with a
 * step_output artifact, to test the mark_run_complete path.
 */
function seedAdaptiveRunAtDone(db: Database.Database, bus: EventBus): void {
  installBuiltInTemplates({ db, bus }, ["orca/adaptive-delivery"]);

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-fd', 'goal-fd', ?, ?, 'active', 'step-fd-done', 'done', 'step', 0, NULL, ?, NULL)"
  ).run(ADAPTIVE_ID, ADAPTIVE_VERSION, NOW);

  // Active terminal done step.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-fd-done', 'goal-fd', 'run-fd', 'done', 8, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-done', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
  ).run(NOW, NOW);

  // step_output on the terminal done step — triggers mark_run_complete.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-fd-done', 'goal-fd', 'run-fd', 'step-fd-done', 'step_output', 'Done', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(
    JSON.stringify({
      summary: "Feature delivered",
      delivered_requirements: ["req-1"],
      validation_evidence: ["all tests pass"],
      handoff: "Done",
    }),
    NOW
  );
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService — adaptive delivery loop", () => {
  it("rejected Release Readiness gate routes backward to a fresh Execution attempt", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedAdaptiveRunAtValidation(db, bus);
    const service = makeService(fakeGateBroker("rejected"));

    // Reaching the gate parks for a human decision; the user rejects.
    await service.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });
    await service.decideGate(db, () => NOW, "run-fd", "rejected", { bus, idFactory });

    // Gate decision recorded with rejected outcome routing to execution.
    const decisions = listGateDecisionsForRun(db, "run-fd");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "review",
      outcome: "rejected",
      selectedEdgeTo: "execution",
    });

    // A second execution attempt (attempt 2) was inserted.
    const execRuns = db
      .prepare(
        "SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'run-fd' AND step_template_id = 'execution' ORDER BY attempt"
      )
      .all() as Array<{ attempt: number }>;
    expect(execRuns.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("approved Release Readiness gate routes to the terminal Done step", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedAdaptiveRunAtValidation(db, bus);
    const service = makeService(fakeGateBroker("approved"));

    // Reaching the gate parks for a human decision; the user approves.
    await service.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });
    await service.decideGate(db, () => NOW, "run-fd", "approved", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-fd");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "review",
      outcome: "approved",
      selectedEdgeTo: "done",
    });

    const run = db
      .prepare("SELECT current_node_id, current_node_kind FROM workflow_runs WHERE id = 'run-fd'")
      .get() as { current_node_id: string; current_node_kind: string };
    expect(run.current_node_id).toBe("done");
    expect(run.current_node_kind).toBe("step");
  });

  it("completing terminal Done yields mark_run_complete (human yield) without auto-completing the run", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedAdaptiveRunAtDone(db, bus);
    const service = makeService(fakeGateBroker("approved")); // broker irrelevant; no gate here

    await service.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });

    // A complete_workflow_run recommendation exists.
    const rec = db
      .prepare(
        "SELECT type FROM recommendations WHERE goal_id = ? ORDER BY rowid DESC LIMIT 1"
      )
      .get("goal-fd") as { type: string } | undefined;
    expect(rec?.type).toBe("complete_workflow_run");

    // The run is still active — no auto-complete.
    const runAfter = db
      .prepare("SELECT status, current_node_id FROM workflow_runs WHERE id = 'run-fd'")
      .get() as { status: string; current_node_id: string };
    expect(runAfter.status).toBe("active");
    expect(runAfter.current_node_id).toBe("done");
  });
});
