import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  OrchestratorChatMessage,
  type CreateOrchestratorMessageRequest as CreateOrchestratorMessageRequestT,
  type CreateOrchestratorMessageResponse as CreateOrchestratorMessageResponseT,
  type DomainEvent,
  type ModelProviderId,
  type OrchestratorChatMessage as OrchestratorChatMessageT,
  type PendingQuestion as PendingQuestionT,
} from "@orca/contracts";

import type { EventBus } from "../events.js";
import type { ModelProviderRegistry } from "../llm/registry.js";
import { adapterIdForProvider } from "../orchestrator-llm/model-provider-llm-client.js";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";

export interface OrchestratorChatCtx {
  db: Database.Database;
  bus: EventBus;
  modelProviderRegistry: ModelProviderRegistry;
  shadowAsk?: (
    goalId: string,
    input: { adapterId: ShadowAdapterId; systemPrompt: string; userPrompt: string; timeoutMs: number }
  ) => Promise<{ text: string }>;
  resolveOrchestratorMode?: (provider: string) => "shadow_session" | "one_shot";
  onOrchestratorReply?: (goalId: string, body: string) => void;
  now?: () => string;
  idFactory?: () => string;
}

type GoalRow = {
  id: string;
  title: string;
  description: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
  active_workflow_run_id: string | null;
};

type CurrentStepRow = {
  id: string;
  step_template_id: string;
  status: string;
} | null;

export class OrchestratorChatGoalNotFoundError extends Error {
  readonly code = "goal_not_found" as const;

  constructor(readonly goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "OrchestratorChatGoalNotFoundError";
  }
}

export class GoalOrchestratorModelMissingError extends Error {
  readonly code = "goal_orchestrator_model_missing" as const;

  constructor(readonly goalId: string) {
    super(`Goal ${goalId} needs an orchestrator model before Orca can reply.`);
    this.name = "GoalOrchestratorModelMissingError";
  }
}

export class OrchestratorChatProviderUnavailableError extends Error {
  readonly code = "orchestrator_provider_unavailable" as const;

  constructor(readonly providerId: string) {
    super(`Orchestrator provider is unavailable: ${providerId}`);
    this.name = "OrchestratorChatProviderUnavailableError";
  }
}

const GuidanceReply = z
  .object({
    replyText: z.string().trim().min(1).max(4000),
  })
  .strict();

export async function createOrchestratorMessage(
  ctx: OrchestratorChatCtx,
  goalId: string,
  input: CreateOrchestratorMessageRequestT
): Promise<CreateOrchestratorMessageResponseT> {
  const parsed = CreateOrchestratorMessageRequest.parse(input);
  const goal = readGoal(ctx.db, goalId);
  if (!goal) throw new OrchestratorChatGoalNotFoundError(goalId);
  if (!goal.orchestrator_provider || !goal.orchestrator_model) {
    throw new GoalOrchestratorModelMissingError(goalId);
  }

  const now = ctx.now ?? (() => new Date().toISOString());
  const idFactory = ctx.idFactory ?? randomUUID;
  const userMessageId = idFactory();
  const correlationId = idFactory();
  const userMessage = insertMessageWithEvent(ctx, {
    id: userMessageId,
    goalId,
    role: "user",
    body: parsed.body,
    correlationId,
    createdAt: now(),
  });

  // When a workflow run is active, defer chat reply to the mediator (onUserMessage),
  // which will post the reply asynchronously.
  const hasActiveRun = Boolean(goal.active_workflow_run_id);
  if (hasActiveRun) {
    return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: null });
  }

  const mode = ctx.resolveOrchestratorMode?.(goal.orchestrator_provider) ?? "one_shot";

  if (mode === "shadow_session") {
    if (!ctx.shadowAsk || !ctx.onOrchestratorReply) {
      throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
    }
    const sys = [
      "You are Orca's goal orchestrator.",
      "Answer the user's freeform guidance message for the current goal.",
      "This is chat-only guidance: do not claim that recommendations, workflow steps, artifacts, or decisions were changed.",
      'Return JSON: {"replyText":"..."}.',
      "Output protocol: wrap that JSON in a fenced ```orca:action block and emit nothing after the closing fence.",
    ].join("\n");
    const usr = JSON.stringify({ goal: { id: goal.id, title: goal.title, description: goal.description }, userMessage: parsed.body });
    void ctx.shadowAsk(goalId, {
      adapterId: toShadowAdapterId(goal.orchestrator_provider),
      systemPrompt: sys,
      userPrompt: usr,
      timeoutMs: 120_000,
    })
      .then((out) => {
        let body: string;
        try { body = GuidanceReply.parse(JSON.parse(out.text)).replyText; }
        catch { body = "Orchestrator returned an unreadable reply."; }
        ctx.onOrchestratorReply!(goalId, body);
      })
      .catch(() => ctx.onOrchestratorReply!(goalId, "Orchestrator is unavailable right now. Please try again."));
    return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: null });
  }

  // one_shot (SDK) — synchronous (existing path)
  const provider = ctx.modelProviderRegistry.get(goal.orchestrator_provider);
  if (!provider) throw new OrchestratorChatProviderUnavailableError(goal.orchestrator_provider);
  const currentStep = readCurrentStep(ctx.db, goal.active_workflow_run_id);
  const completion = await provider.complete<unknown>({
    model: goal.orchestrator_model,
    systemPrompt: [
      "You are Orca's goal orchestrator.",
      "Answer the user's freeform guidance message for the current goal.",
      "This is chat-only guidance: do not claim that recommendations, workflow steps, artifacts, or decisions were changed.",
      "Return only structured JSON matching OrchestratorGuidanceReply.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      goal: { id: goal.id, title: goal.title, description: goal.description },
      activeWorkflowRunId: goal.active_workflow_run_id,
      currentStep,
      userMessage: parsed.body,
    }),
    responseSchemaName: "OrchestratorGuidanceReply",
    responseSchema: GuidanceReply,
    maxOutputTokens: 800,
    temperature: 0.2,
    callMetadata: { goalId },
  });
  const replyText = GuidanceReply.parse(completion.parsed).replyText;
  const replyMessage = insertMessageWithEvent(ctx, {
    id: idFactory(),
    goalId,
    role: "orchestrator",
    body: replyText,
    correlationId,
    createdAt: now(),
  });
  return CreateOrchestratorMessageResponse.parse({ message: userMessage, reply: replyMessage });
}

function toShadowAdapterId(providerId: ModelProviderId): ShadowAdapterId {
  const adapterId = adapterIdForProvider(providerId);
  return adapterId === "codex" ? "codex" : "claude-code";
}

function readGoal(db: Database.Database, goalId: string): GoalRow | null {
  return (
    (db
      .prepare(
        `SELECT id, title, description, orchestrator_provider, orchestrator_model, active_workflow_run_id
           FROM goals
          WHERE id = ?
            AND archived_at IS NULL`
      )
      .get(goalId) as GoalRow | undefined) ?? null
  );
}

function readCurrentStep(
  db: Database.Database,
  workflowRunId: string | null
): CurrentStepRow {
  if (!workflowRunId) return null;
  const run = db
    .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = ?")
    .get(workflowRunId) as { current_step_run_id: string | null } | undefined;
  if (!run?.current_step_run_id) return null;
  return (
    (db
      .prepare("SELECT id, step_template_id, status FROM workflow_step_runs WHERE id = ?")
      .get(run.current_step_run_id) as CurrentStepRow | undefined) ?? null
  );
}

export function insertMessageWithEvent(
  ctx: OrchestratorChatCtx,
  message: {
    id: string;
    goalId: string;
    role: "user" | "orchestrator" | "system";
    body: string;
    correlationId: string;
    createdAt: string;
    pendingQuestion?: PendingQuestionT;
  }
): OrchestratorChatMessageT {
  const idFactory = ctx.idFactory ?? randomUUID;
  const stagedEvent = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO orchestrator_messages
          (id, goal_id, role, kind, body, correlation_id, created_at, pending_question)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.goalId,
        message.role,
        message.body,
        message.correlationId,
        message.createdAt,
        message.pendingQuestion != null ? JSON.stringify(message.pendingQuestion) : null
      );

    const payload = {
      messageId: message.id,
      role: message.role,
    };
    const eventId = idFactory();
    const result = ctx.db
      .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        eventId,
        "orchestrator.message.created",
        message.goalId,
        JSON.stringify(payload),
        message.createdAt
      );
    return {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: "orchestrator.message.created",
      goalId: message.goalId,
      payload,
      createdAt: message.createdAt,
    } satisfies DomainEvent;
  })();

  ctx.bus.publish(stagedEvent);
  return OrchestratorChatMessage.parse({
    id: message.id,
    goalId: message.goalId,
    role: message.role,
    kind: "message",
    body: message.body,
    correlationId: message.correlationId,
    createdAt: message.createdAt,
    ...(message.pendingQuestion != null ? { pendingQuestion: message.pendingQuestion } : {}),
  });
}
