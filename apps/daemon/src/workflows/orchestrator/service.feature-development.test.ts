/**
 * End-to-end smoke test for the Feature Development template loop.
 *
 * Proves that the orca/feature-development graph specifically drives:
 *   - Gate rejection → backward route to a fresh Execution attempt
 *   - Gate approval → forward route to terminal Done
 *   - Terminal Done completion → mark_run_complete recommendation (human yield, no auto-complete)
 *
 * The harness is the same as service.gate-routing.test.ts. The only delta is:
 *   - installBuiltInTemplates used to install orca/feature-development
 *   - fakeStepDispatch supports the FD model IDs (sonnet/opus/haiku)
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

const FEATURE_DEV_ID = "orca/feature-development";
// Must track the orca/feature-development version in catalog.ts / usecases.ts.
const FEATURE_DEV_VERSION = 1;

const AGENT_OPERATOR_ID = "agent:claude-code";

// Adapter IDs used by the FD template steps (claude-code with various models).
const FD_ADAPTER = "claude-code";
const FD_MODELS = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]);

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

/** Supports all model IDs used by the FD template (sonnet, opus, haiku). */
function fdStepDispatch(): StepDispatchCapabilities {
  return {
    async isAdapterReady(adapterId) {
      return adapterId === FD_ADAPTER;
    },
    supportsModel(adapterId, modelId) {
      return adapterId === FD_ADAPTER && FD_MODELS.has(modelId);
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
    fdStepDispatch()
  );
}

/**
 * Seed the FD template and a run positioned at the `validation` step with a
 * step_output artifact (the gate-routing trigger). A prior execution attempt
 * (attempt 1) exists so a rejection routes to attempt 2.
 */
function seedFDRunAtValidation(db: Database.Database, bus: EventBus): void {
  installBuiltInTemplates({ db, bus }, ["orca/feature-development"]);

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-fd', 'goal-fd', ?, ?, 'active', 'step-fd-validation', 'validation', 'step', 0, NULL, ?, NULL)"
  ).run(FEATURE_DEV_ID, FEATURE_DEV_VERSION, NOW);

  // Active validation step.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-fd-validation', 'goal-fd', 'run-fd', 'validation', 2, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-val', 'agent:claude-code', NULL, 'claude-opus-4-7', ?)"
  ).run(NOW, NOW);

  // Prior execution attempt (attempt 1, passed) so rejection creates attempt 2.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-fd-execution', 'goal-fd', 'run-fd', 'execution', 1, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-exec')"
  ).run(NOW, NOW);

  // step_output on the active validation step — triggers gate routing.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-fd-val', 'goal-fd', 'run-fd', 'step-fd-validation', 'step_output', 'Validation', ?, 'orchestrator', NULL, NULL, NULL, ?)"
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
 * Seed the FD template and a run positioned at the terminal `done` step with a
 * step_output artifact, to test the mark_run_complete path.
 */
function seedFDRunAtDone(db: Database.Database, bus: EventBus): void {
  installBuiltInTemplates({ db, bus }, ["orca/feature-development"]);

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-fd', 'goal-fd', ?, ?, 'active', 'step-fd-done', 'done', 'step', 0, NULL, ?, NULL)"
  ).run(FEATURE_DEV_ID, FEATURE_DEV_VERSION, NOW);

  // Active terminal done step.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-fd-done', 'goal-fd', 'run-fd', 'done', 3, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-done', 'agent:claude-code', NULL, 'claude-haiku-4-5', ?)"
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

describe("OrchestratorService — feature development loop", () => {
  it("rejected Release Readiness gate routes backward to a fresh Execution attempt", async () => {
    const { db, bus, idFactory } = setupHarness();
    setSupervisionMode(db, "unsupervised", NOW);
    seedFDRunAtValidation(db, bus);
    const service = makeService(fakeGateBroker("rejected"));

    await service.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });

    // Gate decision recorded with rejected outcome routing to execution.
    const decisions = listGateDecisionsForRun(db, "run-fd");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "gate",
      outcome: "rejected",
      selectedEdgeTo: "execution",
      issueRefs: ["i1"],
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
    seedFDRunAtValidation(db, bus);
    const service = makeService(fakeGateBroker("approved"));

    await service.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });

    const decisions = listGateDecisionsForRun(db, "run-fd");
    expect(decisions.at(-1)).toMatchObject({
      nodeId: "gate",
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
    seedFDRunAtDone(db, bus);
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
