/**
 * Free text arriving while a worker question is open is AMBIGUOUS: it may be the
 * user's answer, or a question *about* the question. Today the desktop composer
 * consumed it as the answer unconditionally, so "Can you explain these options
 * more?" was delivered to the parked worker as its decision (with "Do not call
 * AskUserQuestion again"), and the user got a re-ask instead of an explanation.
 *
 * These tests drive the mediator-side resolution through the PUBLIC onUserMessage
 * entry point: the mediator must SEE the open question, and its verdict decides
 * whether the question is consumed or left open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OrchestratorAction, PendingQuestionItem } from "@orca/contracts";
import { DispatchEngine } from "./dispatch-engine.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import type { MediatorInvokeInput } from "../../orchestrator-llm/mediator.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  seedSkillWorkflow,
  fakeRegistry,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";
import { OrchestratorService } from "./service.js";

const ITEM: PendingQuestionItem[] = [
  {
    header: "Enforcement",
    question: "How should the architecture section be enforced?",
    multiSelect: false,
    options: [
      { label: "LLM judge vs rubric", description: "A written rubric the judge scores the diff against." },
      { label: "Architecture is context, not a gate", description: "Injected so agents conform; never blocks a step." },
    ],
  },
];

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

function makeEngine(workerDeliver?: (sessionId: string, text: string) => Promise<"delivered">): DispatchEngine {
  return new DispatchEngine(
    noBroker(),
    fakeRegistry(),
    makeLauncher(),
    fakeStepDispatch(),
    undefined,
    workerDeliver,
  );
}

/** Seed an open (unanswered) worker question for step-1, plus a live worker session. */
function seedOpenWorkerQuestion(db: import("better-sqlite3").Database): void {
  db.prepare(
    "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-sonnet-4-6' WHERE id = 'goal-1'"
  ).run();
  db.prepare(
    "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1', '/tmp/ws', 'w', '', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, workflow_step_run_id, created_at) VALUES ('session-1', 'goal-1', 'ws-1', 'claude-code', 't', 'running', 'step-1', ?)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES ('mw', 'goal-1', 'orchestrator', 'message', 'I need your call.', 'c', ?, ?)"
  ).run(
    NOW,
    JSON.stringify({
      questionId: "qw",
      toolUseId: "tw",
      questions: ITEM,
      source: "worker",
      stepRunId: "step-1",
    }),
  );
  db.prepare(
    "UPDATE workflow_step_runs SET pending_worker_question_id = 'qw' WHERE id = 'step-1'"
  ).run();
}

function readQuestionAnswer(db: import("better-sqlite3").Database): unknown {
  const row = db
    .prepare("SELECT pending_question FROM orchestrator_messages WHERE id = 'mw'")
    .get() as { pending_question: string };
  return (JSON.parse(row.pending_question) as { answer?: unknown }).answer ?? null;
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("free text while a worker question is open", () => {
  it("shows the mediator the open question so it can tell an answer from a question about it", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    seedOpenWorkerQuestion(db);

    const invoke = vi.fn(async (_input: MediatorInvokeInput): Promise<OrchestratorAction> => ({
      kind: "answer_user_directly",
      body: "Here is what each option means.",
    }));
    const service = new OrchestratorService(
      makeEngine(), noBroker(), fakeRegistry(), undefined, fakeStepDispatch(), { invoke },
    );

    await service.onUserMessage(
      db, () => NOW, { goalId: "goal-1", body: "Can you explain these options more?" }, { bus, idFactory },
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].triggerPayload.openWorkerQuestion).toEqual({
      questionId: "qw",
      questions: ITEM,
    });
  });

  it("leaves the question open when the mediator reads the text as a request to explain", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    seedOpenWorkerQuestion(db);

    const workerDeliver = vi.fn(async (_sessionId: string, _text: string) => "delivered" as const);
    const service = new OrchestratorService(
      makeEngine(workerDeliver), noBroker(), fakeRegistry(), undefined, fakeStepDispatch(),
      { invoke: async () => ({ kind: "answer_user_directly", body: "Here is what each option means." }) },
      workerDeliver,
    );

    await service.onUserMessage(
      db, () => NOW, { goalId: "goal-1", body: "Can you explain these options more?" }, { bus, idFactory },
    );
    await flush();
    await flush();

    // The decision is still the user's to make: card unanswered, worker still parked.
    expect(readQuestionAnswer(db)).toBeNull();
    const step = db
      .prepare("SELECT pending_worker_question_id FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { pending_worker_question_id: string | null };
    expect(step.pending_worker_question_id).toBe("qw");
    expect(workerDeliver).not.toHaveBeenCalled();

    // ...and the explanation reached the chat.
    const reply = db
      .prepare(
        "SELECT body FROM orchestrator_messages WHERE role = 'orchestrator' AND id != 'mw' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { body: string } | undefined;
    expect(reply?.body).toBe("Here is what each option means.");
  });

  it("consumes the question and delivers to the parked worker when the mediator reads the text as the answer", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    seedOpenWorkerQuestion(db);

    const workerDeliver = vi.fn(async (_sessionId: string, _text: string) => "delivered" as const);
    const service = new OrchestratorService(
      makeEngine(workerDeliver), noBroker(), fakeRegistry(), undefined, fakeStepDispatch(),
      { invoke: async () => ({ kind: "answer_open_question", answerText: "Go with the rubric." }) },
      workerDeliver,
    );

    await service.onUserMessage(
      db, () => NOW, { goalId: "goal-1", body: "Go with the rubric." }, { bus, idFactory },
    );
    await flush();
    await flush();

    expect(readQuestionAnswer(db)).toEqual({ viaChat: true });
    const step = db
      .prepare("SELECT pending_worker_question_id FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { pending_worker_question_id: string | null };
    expect(step.pending_worker_question_id).toBeNull();
    expect(workerDeliver).toHaveBeenCalledTimes(1);
    expect(workerDeliver.mock.calls[0]![1]).toContain("Go with the rubric.");
  });

  it("treats forward_to_agent as answering the open question so the step is never stranded", async () => {
    // The prompt tells the mediator to forward_to_agent when the user answers an
    // ask_user, which for a WORKER question would relay the text but leave the
    // card open and the step parked forever. Forwarding while a worker question
    // is open IS answering it, so route it that way.
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    seedOpenWorkerQuestion(db);

    const workerDeliver = vi.fn(async (_sessionId: string, _text: string) => "delivered" as const);
    const service = new OrchestratorService(
      makeEngine(workerDeliver), noBroker(), fakeRegistry(), undefined, fakeStepDispatch(),
      { invoke: async () => ({ kind: "forward_to_agent", translated: "Go with the rubric." }) },
      workerDeliver,
    );

    await service.onUserMessage(
      db, () => NOW, { goalId: "goal-1", body: "Go with the rubric." }, { bus, idFactory },
    );
    await flush();
    await flush();

    expect(readQuestionAnswer(db)).toEqual({ viaChat: true });
    const step = db
      .prepare("SELECT pending_worker_question_id FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { pending_worker_question_id: string | null };
    expect(step.pending_worker_question_id).toBeNull();
    expect(workerDeliver.mock.calls[0]![1]).toContain("Go with the rubric.");
  });

  it("falls back to consuming the text as the answer when the mediator is unavailable", async () => {
    // An LLM outage must never strand a user who is trying to answer a question:
    // degrade to the pre-mediator behavior rather than leaving the run parked.
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    seedOpenWorkerQuestion(db);

    const workerDeliver = vi.fn(async (_sessionId: string, _text: string) => "delivered" as const);
    const service = new OrchestratorService(
      makeEngine(workerDeliver), noBroker(), fakeRegistry(), undefined, fakeStepDispatch(),
      { invoke: async () => { throw new Error("provider down"); } },
      workerDeliver,
    );

    await service.onUserMessage(
      db, () => NOW, { goalId: "goal-1", body: "Go with the rubric." }, { bus, idFactory },
    );
    await flush();
    await flush();

    expect(readQuestionAnswer(db)).toEqual({ viaChat: true });
    expect(workerDeliver).toHaveBeenCalledTimes(1);
  });
});
