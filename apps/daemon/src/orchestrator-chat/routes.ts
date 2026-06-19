import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  ListOrchestratorMessagesResponse,
  PendingQuestion,
  SubmitWorkerAnswersRequest,
  type PendingQuestionAnswer,
} from "@orca/contracts";

import type { EventBus } from "../events.js";
import type { ModelProviderRegistry } from "../llm/registry.js";
import {
  assembleAnswerReason,
  assembleFreeTextReason,
  validateAnswers,
} from "../workflows/orchestrator/worker-answer-format.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";
import {
  createOrchestratorMessage,
  GoalOrchestratorModelMissingError,
  OrchestratorChatGoalNotFoundError,
  OrchestratorChatProviderUnavailableError,
  recordWorkerQuestionAnswer,
} from "./usecases.js";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";

export interface OrchestratorChatRouteDeps {
  db: Database.Database;
  bus: EventBus;
  modelProviderRegistry: ModelProviderRegistry;
  now?: () => string;
  idFactory?: () => string;
  shadowAsk?: (
    goalId: string,
    input: { adapterId: ShadowAdapterId; systemPrompt: string; userPrompt: string; timeoutMs: number }
  ) => Promise<{ text: string }>;
  resolveOrchestratorMode?: (provider: string) => "shadow_session" | "one_shot";
  onOrchestratorReply?: (goalId: string, body: string) => void;
  onUserMessage?: (goalId: string, body: string) => Promise<void>;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function goalExists(db: Database.Database, goalId: string): boolean {
  const row = db
    .prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL")
    .get(goalId) as { id: string } | undefined;
  return row !== undefined;
}

export function registerOrchestratorChatRoutes(
  server: FastifyInstance,
  deps: OrchestratorChatRouteDeps
): void {
  server.get("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    if (!goalExists(deps.db, goalId)) {
      reply.status(404);
      return apiError("goal_not_found", `Goal not found: ${goalId}`);
    }

    return ListOrchestratorMessagesResponse.parse({
      messages: listOrchestratorMessagesByGoal(deps.db, goalId),
    });
  });

  server.post("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = CreateOrchestratorMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    try {
      const response = await createOrchestratorMessage(
        {
          db: deps.db,
          bus: deps.bus,
          modelProviderRegistry: deps.modelProviderRegistry,
          now: deps.now,
          idFactory: deps.idFactory,
          shadowAsk: deps.shadowAsk,
          resolveOrchestratorMode: deps.resolveOrchestratorMode,
          onOrchestratorReply: deps.onOrchestratorReply,
        },
        goalId,
        parsed.data
      );
      if (deps.onUserMessage) {
        // Best-effort orchestrator-LLM trigger; never block the chat reply.
        void deps.onUserMessage(goalId, parsed.data.body).catch(() => {});
      }
      reply.status(201);
      return CreateOrchestratorMessageResponse.parse(response);
    } catch (error) {
      if (error instanceof OrchestratorChatGoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalOrchestratorModelMissingError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof OrchestratorChatProviderUnavailableError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  // Answer an orchestrator ask_user question. Unlike a worker question (which
  // blocks an agent tool call and is answered through its own route), an
  // orchestrator question is answered by (1) persisting the answer onto the
  // question message so it renders answered and survives reloads, and (2)
  // forwarding the selection to the mediator as guidance — without posting a
  // separate user chat bubble.
  server.post("/v1/goals/:goalId/orchestrator-questions/:questionId/answer", async (request, reply) => {
    const { goalId, questionId } = request.params as { goalId: string; questionId: string };
    const parsed = SubmitWorkerAnswersRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    const row = deps.db
      .prepare(
        `SELECT pending_question FROM orchestrator_messages
           WHERE goal_id = ? AND json_extract(pending_question, '$.questionId') = ?
           LIMIT 1`
      )
      .get(goalId, questionId) as { pending_question: string } | undefined;
    if (row == null) {
      reply.status(404);
      return apiError("question_not_found", `Question not found: ${questionId}`);
    }

    const pending = PendingQuestion.parse(JSON.parse(row.pending_question));

    let answer: PendingQuestionAnswer;
    let reason: string;
    if (parsed.data.freeText != null) {
      answer = { freeText: parsed.data.freeText };
      reason = assembleFreeTextReason(parsed.data.freeText);
    } else {
      const invalid = validateAnswers(pending.questions, parsed.data.answers!);
      if (invalid) {
        reply.status(400);
        return apiError(invalid, "Invalid answers for this question");
      }
      answer = { answers: parsed.data.answers! };
      reason = assembleAnswerReason(pending.questions, parsed.data.answers!);
    }

    recordWorkerQuestionAnswer(
      { db: deps.db, bus: deps.bus, idFactory: deps.idFactory },
      { goalId, questionId, answer }
    );

    if (deps.onUserMessage) {
      // Best-effort mediator forward; never block the answer ack.
      void deps.onUserMessage(goalId, reason).catch(() => {});
    }

    return { ok: true };
  });
}
