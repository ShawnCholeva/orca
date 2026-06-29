/**
 * Tests for the human-prompt gate in OrchestratorService's ask_user handling.
 *
 * Drives through the PUBLIC onUserMessage entry point by stubbing
 * orchestratorMediator to return an ask_user action.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OrchestratorAction, PendingQuestionItem } from "@orca/contracts";
import { DispatchEngine } from "./dispatch-engine.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  seedSkillWorkflow,
  fakeRegistry,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";
import { OrchestratorService } from "./service.js";

// A minimal PendingQuestionItem for test use.
const ITEM: PendingQuestionItem[] = [
  {
    header: "Which approach?",
    question: "Pick one.",
    multiSelect: false,
    options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
  },
];

function fakeMediator(action: OrchestratorAction): Pick<OrchestratorMediator, "invoke"> {
  return {
    invoke: vi.fn(async () => action),
  };
}

function noBroker(): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose() {
      return { status: "needs_human_review" as const, attemptId: "a1", reviewPayloadId: "r1" };
    },
  };
}

function makeLauncher(): WorkflowSessionLauncher {
  return { launch: vi.fn(async () => ({ sessionId: "sess-1" })) };
}

function makeEngine(): DispatchEngine {
  return new DispatchEngine(
    noBroker(),
    fakeRegistry(),
    makeLauncher(),
    fakeStepDispatch(),
    undefined,
    undefined,
  );
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("ask_user gate", () => {
  it("suppresses ask_user when a worker question is already open for the step run", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    // Set orchestrator provider/model so onUserMessage proceeds past the early-return.
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-sonnet-4-6' WHERE id = 'goal-1'"
    ).run();

    // Seed an open worker question for step-1.
    db.prepare(
      "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES ('mw', 'goal-1', 'orchestrator', 'message', 'b', 'c', ?, ?)"
    ).run(NOW, JSON.stringify({
      questionId: "qw",
      toolUseId: "tw",
      questions: ITEM,
      source: "worker",
      stepRunId: "step-1",
    }));

    const mediator = fakeMediator({
      kind: "ask_user",
      body: "pick",
      questions: ITEM,
    });

    const service = new OrchestratorService(
      makeEngine(),
      noBroker(),
      fakeRegistry(),
      undefined,
      fakeStepDispatch(),
      mediator,
    );

    await service.onUserMessage(db, () => NOW, { goalId: "goal-1", body: "help" }, { bus, idFactory });

    // No orchestrator-sourced question row should have been posted.
    const posted = db
      .prepare(
        "SELECT COUNT(*) AS c FROM orchestrator_messages WHERE json_extract(pending_question,'$.source')='orchestrator' AND json_extract(pending_question,'$.stepRunId')='step-1'"
      )
      .get() as { c: number };
    expect(posted.c).toBe(0);

    // An audit event for the suppression should exist.
    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE type='orchestrator.prompt.suppressed'")
      .get() as { c: number };
    expect(audit.c).toBe(1);
  });

  it("posts the orchestrator question (stamped) when no prompt is open", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    db.prepare(
      "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-sonnet-4-6' WHERE id = 'goal-1'"
    ).run();

    const mediator = fakeMediator({
      kind: "ask_user",
      body: "pick",
      questions: ITEM,
    });

    const service = new OrchestratorService(
      makeEngine(),
      noBroker(),
      fakeRegistry(),
      undefined,
      fakeStepDispatch(),
      mediator,
    );

    await service.onUserMessage(db, () => NOW, { goalId: "goal-1", body: "help" }, { bus, idFactory });

    const row = db
      .prepare(
        "SELECT pending_question FROM orchestrator_messages WHERE json_extract(pending_question,'$.source')='orchestrator'"
      )
      .get() as { pending_question: string } | undefined;
    expect(row).toBeDefined();
    const pq = JSON.parse(row!.pending_question);
    expect(pq.source).toBe("orchestrator");
    expect(pq.stepRunId).toBe("step-1");
  });
});
