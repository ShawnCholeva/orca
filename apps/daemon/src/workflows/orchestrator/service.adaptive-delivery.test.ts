/**
 * End-to-end smoke test for the Adaptive Delivery template loop.
 *
 * Proves that the orca/adaptive-delivery graph specifically drives:
 *   - Verify gate rejection → backward route to a fresh Execution attempt
 *   - Verify gate approval → forward route to terminal Done
 *   - Terminal Done completion → mark_run_complete recommendation (human yield, no auto-complete)
 *
 * This file drives orca/adaptive-delivery end-to-end. It seeds runs at
 * key positions (execution, done) and asserts the gate routing and
 * run-complete recommendation behaviour specific to that template. As of v13
 * Execution flows straight into the worker-backed Verify gate (node id `review`).
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
import { DispatchEngine } from "./dispatch-engine.js";
import type { OperatorDescriptor } from "@orca/contracts";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import type { StepDispatchCapabilities } from "./dispatch-types.js";
import type { StepRunRow } from "./db-rows.js";
import { installBuiltInTemplates } from "../templates/usecases.js";
import type { EventBus } from "../../events.js";

const ADAPTIVE_ID = "orca/adaptive-delivery";
// Must track the orca/adaptive-delivery version in catalog.ts / usecases.ts.
const ADAPTIVE_VERSION = 1;

const AGENT_OPERATOR_ID = "agent:claude-code";

// Adapter IDs used by the AD template steps (claude-code with various models).
const AD_ADAPTER = "claude-code";
const AD_MODELS = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]);

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

function makeEngine(
  broker: Pick<OrchestrationTransportBroker, "propose">
): DispatchEngine {
  const agentDescriptor: OperatorDescriptor = {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: [],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
  return new DispatchEngine(
    broker,
    { async list() { return [agentDescriptor]; } },
    makeLauncher(),
    adStepDispatch(),
    async () => {},                   // workerSpawn (Verify gate is a worker gate)
    async () => "delivered" as const, // workerDeliver
    undefined
  );
}

// The worker gate's verdict text, as its Stop hook would deliver it.
function gateDecision(outcome: "approved" | "rejected", issueRefs: string[]): string {
  return `\`\`\`orca:gate-decision\n${JSON.stringify({
    reasoning: `judged ${outcome}`,
    outcome,
    reason: `${outcome} because reasons`,
    issueRefs,
    inputsConsidered: ["sourceStepOutput"],
  })}\n\`\`\``;
}

/**
 * Seed the AD template and a run positioned at the `execution` step (attempt 1)
 * with a step_output artifact (the gate-routing trigger into the Verify gate).
 * A rejection routes back to Execution, creating attempt 2.
 */
function seedAdaptiveRunAtExecution(db: Database.Database, bus: EventBus): void {
  installBuiltInTemplates({ db, bus }, ["orca/adaptive-delivery"]);

  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
  ).run(NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, current_node_id, current_node_kind, traversal_seq, blocked_reason, started_at, finished_at) VALUES ('run-fd', 'goal-fd', ?, ?, 'active', 'step-fd-execution', 'execution', 'step', 0, NULL, ?, NULL)"
  ).run(ADAPTIVE_ID, ADAPTIVE_VERSION, NOW);

  // Active execution step (attempt 1) — its step_output triggers gate routing.
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-fd-execution', 'goal-fd', 'run-fd', 'execution', 6, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-exec', 'agent:claude-code', NULL, 'claude-opus-4-7', ?)"
  ).run(NOW, NOW);

  // step_output on the active execution step — triggers gate routing into Verify.
  db.prepare(
    "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES ('art-fd-exec', 'goal-fd', 'run-fd', 'step-fd-execution', 'step_output', 'Execution', ?, 'orchestrator', NULL, NULL, NULL, ?)"
  ).run(
    JSON.stringify({
      summary: "Implementation complete",
      completed_requirements: ["req-1"],
      changes: [{ file: "src/x.ts", description: "impl", requirement_refs: ["req-1"] }],
      validation: [{ command: "pnpm test", result: "passed", evidence: "all green" }],
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
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('goal-fd', 'FD Goal', 'Feature goal', 'active', 1, ?, ?, NULL, 'orca/anthropic', 'claude-sonnet-4-6')"
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
  // Drive requestNextDecision until the run parks at the worker Verify gate;
  // return its surrogate step-run (step_template_id '__gate__:review').
  async function parkAtVerifyGate(
    db: Database.Database,
    engine: DispatchEngine,
    ctx: { bus: EventBus; idFactory: () => string }
  ): Promise<StepRunRow> {
    await engine.requestNextDecision(db, () => NOW, "run-fd", ctx);
    return db
      .prepare("SELECT * FROM workflow_step_runs WHERE workflow_run_id = 'run-fd' AND step_template_id = '__gate__:review'")
      .get() as StepRunRow;
  }

  it("rejected Verify gate routes backward to a fresh Execution attempt", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedAdaptiveRunAtExecution(db, bus);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-fd'").run();
    const engine = makeEngine(fakeGateBroker("approved")); // broker serves step proposals; the gate is worker-driven

    // Execution's output routes into the worker Verify gate; the worker rejects.
    const surrogate = await parkAtVerifyGate(db, engine, { bus, idFactory });
    await engine.completeGateWorker(db, () => NOW, surrogate, gateDecision("rejected", ["i1"]), { bus, idFactory });

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

  it("approved Verify gate routes to the terminal Done step", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedAdaptiveRunAtExecution(db, bus);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-fd'").run();
    const engine = makeEngine(fakeGateBroker("approved"));

    // Execution's output routes into the worker Verify gate; the worker approves.
    const surrogate = await parkAtVerifyGate(db, engine, { bus, idFactory });
    await engine.completeGateWorker(db, () => NOW, surrogate, gateDecision("approved", []), { bus, idFactory });

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
    const engine = makeEngine(fakeGateBroker("approved")); // broker irrelevant; no gate here

    await engine.requestNextDecision(db, () => NOW, "run-fd", { bus, idFactory });

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
