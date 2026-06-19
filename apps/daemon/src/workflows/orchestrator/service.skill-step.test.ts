import type Database from "better-sqlite3";
import type { OrchestrationRequest, StepSkillProposal } from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { resetWorkflowEventPreparedStatements } from "../events.js";
import { closeDatabase } from "../../db.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { SelectorInput } from "../operators/selector.js";
import { OrchestratorService } from "./service.js";
import {
  cleanupHarness,
  fakeBroker,
  fakeRegistry,
  fakeSelector,
  fakeStepDispatch,
  makeStep,
  NOW,
  seedSkillWorkflow,
  setupHarness,
} from "./skill-step-test-helpers.js";

function makeService(raw: StepSkillProposal, seen: SelectorInput[] = []): OrchestratorService {
  return new OrchestratorService(
    fakeSelector(seen),
    fakeBroker(raw),
    fakeRegistry(),
    undefined,
    undefined,
    fakeStepDispatch()
  );
}

function decisionCount(db: Database.Database, type?: string): number {
  if (type) {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM workflow_decisions WHERE decision_type = ?")
        .get(type) as { c: number }
    ).c;
  }
  return (
    db.prepare("SELECT COUNT(*) AS c FROM workflow_decisions").get() as { c: number }
  ).c;
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

const ASK: StepSkillProposal = { action: "ask", question: "What problem are we solving?" };

describe("OrchestratorService skill step", () => {
  it("deterministically selects the per-step agent then recommends launching it", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    const service = makeService(ASK);

    // (1) First decision: deterministic operator selection from agentPreference.
    const first = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(first.decision.decisionType).toBe("select_operator");
    expect(first.decision.selectedAction).toBe("select:claude-code:claude-haiku-4-5");
    expect(first.recommendationIds).toEqual([]);
    const stepRow = db
      .prepare(
        "SELECT selected_operator_id, selected_model_id FROM workflow_step_runs WHERE id = 'step-1'"
      )
      .get() as { selected_operator_id: string | null; selected_model_id: string | null };
    expect(stepRow.selected_operator_id).toBe("agent:claude-code");
    expect(stepRow.selected_model_id).toBe("claude-haiku-4-5");

    // (2) Second decision: routes into the agent branch. With the default launcher
    // (throws direct_launch_unsupported) and no linked session, it falls back to a
    // launch recommendation.
    const second = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(second.decision.decisionType).toBe("select_operator");
    expect(second.decision.selectedAction).toBe("launch:agent:claude-code");
    expect(second.recommendationIds).toHaveLength(1);
    const rec = db
      .prepare("SELECT type FROM recommendations WHERE id = ?")
      .get(second.recommendationIds[0]) as { type: string };
    expect(rec.type).toBe("launch_workflow_session");
  });

  it("does not create a new request_user_input decision when a question is unanswered", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    const service = makeService(ASK);

    // First call asks a question.
    const first = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(first.decision.decisionType).toBe("request_user_input");
    expect(decisionCount(db, "request_user_input")).toBe(1);

    // Second call: the question is still unanswered (no interview_turn) -> noop.
    const second = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(second.decision.decisionType).toBe("request_user_input");
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.recommendationIds).toEqual([]);
    expect(decisionCount(db, "request_user_input")).toBe(1);
  });

  it("completes an intermediate step and auto-advances to the next step", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      steps: [
        makeStep({ id: "plan", ordinal: 0, name: "Plan" }),
        makeStep({
          id: "research",
          ordinal: 1,
          name: "Research",
          instructions: "Research the problem.",
          outputSchema: [{ key: "findings", type: "string", required: true }],
        }),
      ],
      selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    const complete: StepSkillProposal = {
      action: "complete",
      output: { problem: "x" },
      completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "ok" },
    };
    // Research step asks (so we don't recurse into another completion).
    const service = new OrchestratorService(
      fakeSelector(),
      {
        async propose(req: { stepRunId: string | null }, opts) {
          const isFirst = req.stepRunId === "step-1";
          const raw = isFirst
            ? complete
            : ({ action: "ask", question: "Research question?" } as StepSkillProposal);
          const v = opts?.validateProposal ? await opts.validateProposal(raw) : { accepted: true as const };
          if (!v.accepted) {
            return { status: "needs_human_review", attemptId: "a", reviewPayloadId: "r" } as const;
          }
          return {
            status: "proposed",
            attemptId: "a",
            transport: "one_shot",
            parsed: Object.prototype.hasOwnProperty.call(v, "parsed") ? v.parsed : raw,
            rawTextLength: null,
            latencyMs: 1,
          } as const;
        },
      },
      fakeRegistry(),
      undefined,
      undefined,
      fakeStepDispatch()
    );

    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const stepOutputs = db
      .prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE type = 'step_output'")
      .get() as { c: number };
    expect(stepOutputs.c).toBe(1);

    const run = db
      .prepare(
        "SELECT current_step_run_id, status FROM workflow_runs WHERE id = 'run-1'"
      )
      .get() as { current_step_run_id: string; status: string };
    const currentStep = db
      .prepare("SELECT step_template_id FROM workflow_step_runs WHERE id = ?")
      .get(run.current_step_run_id) as { step_template_id: string };
    expect(currentStep.step_template_id).toBe("research");
    expect(run.status).toBe("active");
    const firstStep = db
      .prepare("SELECT status FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { status: string };
    expect(firstStep.status).toBe("passed");
  });

  it("recommends completing the run on the final step without changing run status", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      steps: [makeStep({ id: "plan", ordinal: 0, name: "Plan" })],
      selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    const complete: StepSkillProposal = {
      action: "complete",
      output: { problem: "final" },
      completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "done" },
    };
    const service = makeService(complete);

    const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    expect(result.decision.decisionType).toBe("mark_run_complete");
    expect(result.recommendationIds).toHaveLength(1);
    const rec = db
      .prepare("SELECT type FROM recommendations WHERE id = ?")
      .get(result.recommendationIds[0]) as { type: string };
    expect(rec.type).toBe("complete_workflow_run");
    const run = db
      .prepare("SELECT status FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string };
    expect(run.status).toBe("active");
  });

  it("blocks the run when the completion output fails schema validation", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      steps: [makeStep({ id: "plan", ordinal: 0, name: "Plan" })],
      selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    const invalid: StepSkillProposal = {
      action: "complete",
      output: { notProblem: "x" },
      completion: { confidence: "low", assumptions: [], openQuestions: [], whyComplete: "guess" },
    };
    const service = makeService(invalid);

    const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    expect(result.decision.decisionType).toBe("block_run");
    expect(result.decision.reason).toMatch(/schema/i);
    const run = db
      .prepare("SELECT status FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string };
    expect(run.status).toBe("blocked");
  });

  it("model step input includes workspaceContext when workspaces are attached", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db, {
      selectedOperatorId: "orca/anthropic:claude-sonnet-4-6",
      selectedProviderId: "orca/anthropic",
      selectedModelId: "claude-sonnet-4-6",
      operatorSelectedAt: NOW,
    });
    // Seed a workspace for the goal.
    db.prepare(
      `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ws1", "/r", "monorepo", '', NOW, NOW);
    db.prepare(
      `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
    ).run("goal-1", "ws1", NOW);

    // Spy broker captures the request payload.
    let capturedPayload: unknown;
    const spyBroker: Pick<import("../orchestration-transport/broker.js").OrchestrationTransportBroker, "propose"> = {
      async propose(req: OrchestrationRequest, opts) {
        capturedPayload = req.payload;
        // Delegate to fakeBroker logic for a valid ask response.
        const raw: StepSkillProposal = { action: "ask", question: "q?" };
        const v = opts?.validateProposal ? await opts.validateProposal(raw) : { accepted: true as const };
        if (!v.accepted) return { status: "needs_human_review" as const, attemptId: "a", reviewPayloadId: "r" };
        return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: raw, rawTextLength: null, latencyMs: 1 };
      },
    };

    const service = new OrchestratorService(
      fakeSelector(),
      spyBroker,
      fakeRegistry(),
      undefined,
      undefined,
      fakeStepDispatch()
    );
    await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

    const payload = capturedPayload as Record<string, unknown> | undefined;
    expect(payload?.workspaceContext).toBeDefined();
    const wc = payload?.workspaceContext as { workspaces: Array<{ id: string }> } | undefined;
    expect(wc?.workspaces[0]?.id).toBe("ws1");
  });
});
