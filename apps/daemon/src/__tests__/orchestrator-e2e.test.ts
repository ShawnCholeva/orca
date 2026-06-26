/**
 * Orchestrator-mediated workflow — SERVICE-LEVEL end-to-end happy path.
 *
 * A pure black-box HTTP e2e is not practical here:
 *   (a) the production orchestrator-LLM mediator is intentionally `undefined`
 *       (deferred across the sub-plans), so the real
 *       `/v1/agent-hooks/response-done` handler early-returns; and
 *   (b) the production launcher spawns real node-pty sessions, which are
 *       unsuitable for a unit test.
 *
 * Therefore this is a SERVICE-LEVEL e2e: a real `OrchestratorService` wired
 * against a real in-memory SQLite DB (real migrations + judgement + schema
 * validation + advanceToNextStep + artifacts + orchestrator_messages),
 * faking ONLY the boundary — a fake mediator (the LLM) and a spy launcher
 * (the PTY). This exercises the full orchestrator-mediated chain end-to-end
 * minus the deferred production LLM/PTY.
 *
 * Happy-path proven:
 *   first-step agent spawn
 *     → agent emits an intermediate response (paraphrase, no step-complete)
 *     → agent emits a valid `orca:step-complete` block
 *     → orchestrator approves
 *     → step advances to step 2 and a `step_output` artifact exists for step 1.
 */
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../db.js";
import { resetWorkflowEventPreparedStatements } from "../workflows/events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../workflows/steps/projection.js";
import { OrchestratorService } from "../workflows/orchestrator/service.js";
import { DispatchEngine } from "../workflows/orchestrator/dispatch-engine.js";
import { setSupervisionMode } from "../settings/store.js";
import {
  cleanupHarness,
  NOW,
  seedSkillWorkflow,
  setupHarness,
  makeStep,
  fakeStepDispatch,
  fakeRegistry,
} from "../workflows/orchestrator/skill-step-test-helpers.js";
import type { OrchestratorMediator } from "../orchestrator-llm/mediator.js";

const AGENT_OPERATOR_ID = "agent:claude-code";

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

/** Broker fake mirroring service.agent-step.test's fakeBrokerNoop. */
function fakeBrokerNoop(): Pick<
  import("../workflows/orchestration-transport/broker.js").OrchestrationTransportBroker,
  "propose"
> {
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

/** Insert a minimal workspace so the sessions FK is satisfied. */
function seedWorkspace(db: Database.Database) {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('ws-1', '/tmp/repo', 'main', '', NOW, NOW);
  db.prepare(
    `INSERT OR IGNORE INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run('goal-1', 'ws-1', NOW);
}

function stepOutputCount(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output'"
      )
      .get(stepRunId) as { c: number }
  ).c;
}

function orchestratorMessageCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM orchestrator_messages WHERE goal_id = 'goal-1'").get() as {
      c: number;
    }
  ).c;
}

describe("orchestrator-mediated workflow e2e (service-level happy path)", () => {
  it("first-step spawn → intermediate paraphrase (no advance) → valid step-complete + approve → advance to step 2 with step-1 output artifact", async () => {
    const { db, bus, idFactory } = setupHarness();

    // Two-step run: ordinal 0 ("plan", required schema key "problem"),
    // ordinal 1 ("build"). current step = step-1 (ordinal 0), unselected.
    seedSkillWorkflow(db, {
      steps: [
        makeStep({
          id: "plan",
          ordinal: 0,
          name: "Plan",
          instructions: "Plan the work and produce a problem statement.",
          outputSchema: [{ key: "problem", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        }),
        makeStep({
          id: "build",
          ordinal: 1,
          name: "Build",
          instructions: "Implement the plan.",
          outputSchema: [{ key: "result", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        }),
      ],
    });
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
    ).run();
    seedWorkspace(db);
    setSupervisionMode(db, "unsupervised", NOW);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    // ---- Boundary fakes: spy launcher (PTY) + fake mediator (LLM). ----
    const launches: any[] = [];
    const launcher = {
      launch: vi.fn(async (ctx: any) => {
        launches.push(ctx);
        return { sessionId: `sess-${ctx.workflowStepRunId}` };
      }),
    };

    // Mediator responses in invocation order:
    //   1) intermediate response → paraphrase (no advance)
    //   2) valid step-complete    → approve (advance)
    const mediatorResponses = [
      { kind: "paraphrase_agent_message", body: "The agent shared progress." },
      { kind: "approve_step_complete" },
    ] as const;
    let call = 0;
    const mediator = {
      invoke: vi.fn(async () => mediatorResponses[Math.min(call++, mediatorResponses.length - 1)]),
    };

    const workerDeliver = vi.fn(async () => "delivered" as const);

    const broker = fakeBrokerNoop();
    const engine = new DispatchEngine(
      broker,
      fakeRegistry(),
      launcher as any,
      fakeStepDispatch(),
      undefined,
      undefined,
      undefined
    );
    const service = new OrchestratorService(
      engine,
      broker,
      fakeRegistry(),
      undefined,
      fakeStepDispatch(),
      mediator as unknown as Pick<OrchestratorMediator, "invoke">,
      workerDeliver
    );

    // ===== 1. Start the workflow's first step (spawns step-1 agent). =====
    await service.startWorkflowFirstStep(db, () => NOW, "run-1", { bus, idFactory });

    expect(launcher.launch).toHaveBeenCalledOnce();
    expect(launches[0].operatorId).toBe(AGENT_OPERATOR_ID);
    expect(launches[0].workflowStepRunId).toBe("step-1");

    const step1Row = db
      .prepare("SELECT selected_operator_id, selected_model_id FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { selected_operator_id: string | null; selected_model_id: string | null };
    expect(step1Row.selected_operator_id).toBe(AGENT_OPERATOR_ID);
    expect(step1Row.selected_model_id).toBe("claude-haiku-4-5");

    // Link a running session to step-1 (the response-done path looks it up).
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-1', 'goal-1', 'ws-1', 'claude-code', 'Session', 'running', ?, 'step-1')"
    ).run(NOW);

    // ===== 2. Intermediate agent response (no step-complete block). =====
    await service.onAgentResponseDone(
      db,
      () => NOW,
      {
        sessionId: "sess-1",
        adapterId: "claude-code",
        responseText: "Working on it, here's my progress.",
      },
      { bus, idFactory }
    );

    // Mediator consulted (no deterministic step-complete block) → paraphrase posted.
    expect(mediator.invoke).toHaveBeenCalledTimes(1);
    expect(orchestratorMessageCount(db)).toBe(1);

    // No advance: step-1 still active, run still on step-1, no step_output yet.
    const afterIntermediate = db
      .prepare("SELECT status FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { status: string };
    expect(afterIntermediate.status).toBe("active");
    const runAfterIntermediate = db
      .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string };
    expect(runAfterIntermediate.current_step_run_id).toBe("step-1");
    expect(stepOutputCount(db, "step-1")).toBe(0);
    // No second launch yet.
    expect(launcher.launch).toHaveBeenCalledOnce();

    // ===== 3. Valid step-complete block matching step-1's schema (key "problem"). =====
    const responseText =
      "All planned.\n```orca:step-complete\n" +
      JSON.stringify({ problem: "we need to ship X" }) +
      "\n```";

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-1", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    // Schema validates → mediator returns approve_step_complete.
    expect(mediator.invoke).toHaveBeenCalledTimes(2);

    // step_output artifact exists for step-1.
    expect(stepOutputCount(db, "step-1")).toBe(1);

    // Run advanced: current step run is a NEW step run (ordinal 1, template "build").
    const runAfterApprove = db
      .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string };
    expect(runAfterApprove.current_step_run_id).not.toBe("step-1");

    const nextStep = db
      .prepare("SELECT step_template_id, ordinal FROM workflow_step_runs WHERE id = ?")
      .get(runAfterApprove.current_step_run_id) as { step_template_id: string; ordinal: number };
    expect(nextStep.step_template_id).toBe("build");
    expect(nextStep.ordinal).toBe(1);

    // The launcher was invoked again for the new (second) step's agent.
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    expect(launches[1].operatorId).toBe(AGENT_OPERATOR_ID);
    expect(launches[1].workflowStepRunId).toBe(runAfterApprove.current_step_run_id);
  });
});
