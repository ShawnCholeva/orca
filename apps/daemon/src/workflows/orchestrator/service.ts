import type Database from "better-sqlite3";
import {
  InterviewTurn,
  OrchestrationRequest,
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  StepSkillProposal,
  validateStepOutput,
  type DomainEvent,
  type ModelProviderId,
  type OperatorDescriptor,
  type OrchestratorAction,
  type StepResultScoringFacts,
  type StepAgentChoice,
  type WorkflowDecisionTrace,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepResult,
  type WorkflowStepTemplate,
  type WorkflowTemplate as WorkflowTemplateT,
} from "@orca/contracts";

import { EventBus } from "../../events.js";
import type { ResolvedMode } from "../../adapters/dispatcher.js";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type { OperatorSelector } from "../operators/selector.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { markWorkflowRunBlocked } from "../runs/usecases.js";
import { getWorkflowStepRunById, recordOperatorSelection } from "../steps/projection.js";
import { advanceToNextStep } from "../steps/usecases.js";
import { getTemplateById } from "../templates/projection.js";
import {
  decisionFingerprint,
  listDecisionsForRun,
  recordDecisionInTx,
} from "../decisions/usecases.js";
import { evaluateGuardrailRequiresApproval } from "../guardrails/evaluator.js";
import { reconstructTranscript } from "./interview.js";
import { buildAgentObjective } from "./agent-objective.js";
import { buildStepExecutionInput } from "./step-input.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { createRecommendationForWorkflowInTx } from "./workflow-recommendations.js";
import { decodeSessionTail } from "./session-tail.js";
import { synthesizeStepOutput } from "./synthesize.js";
import { detectPendingAgentQuestion } from "./agent-interview.js";
import { assembleWorkspaceContext } from "./workspace-context.js";
import { listWorkspacesByGoal } from "../../workspaces/projection.js";
import { resolveStepDispatch, type ResolvedStepDispatch } from "./step-dispatch.js";
import { composeAgentInitialPrompt } from "../../orchestrator-llm/prompts.js";
import { judgeAgentResponse } from "./judgement.js";
import { extractOrcaStepCompleteBlock } from "./orca-output.js";
import { incrementReviseAttempt, REVISE_CAP } from "./revise-loop.js";
import { incrementCrashRetry, CRASH_RETRY_CAP } from "./crash-retry.js";
import { scoreStepResult } from "./step-result-scoring.js";
import {
  buildEvaluationFailedStepResult,
  durationSeconds,
  mapStepRunStatusToResultStatus,
} from "../steps/step-result.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";
import { randomUUID } from "node:crypto";

export interface StepDispatchCapabilities {
  isAdapterReady(adapterId: string): Promise<boolean>;
  supportsModel(adapterId: string, modelId: string): boolean;
  resolveMode(adapterId: string): ResolvedMode;
}

interface GoalRow {
  id: string;
  title: string;
  description: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
}

function preferencesForGoal(
  preferences: StepAgentChoice[],
  orchestratorProvider: GoalRow["orchestrator_provider"]
): StepAgentChoice[] {
  if (!orchestratorProvider) return preferences;
  const preferredAdapterId = adapterIdForProvider(orchestratorProvider);
  if (!preferences.some((pref) => pref.adapterId === preferredAdapterId)) return preferences;
  return [
    ...preferences.filter((pref) => pref.adapterId === preferredAdapterId),
    ...preferences.filter((pref) => pref.adapterId !== preferredAdapterId),
  ];
}

interface StepRunRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  attempt: number;
  status: string;
  started_at: string | null;
  selected_operator_id: string | null;
  selected_model_id: string | null;
  revise_attempts: number;
  crash_retries: number;
}

export interface RequestNextDecisionOptions {
  bus?: EventBus;
  idFactory?: () => string;
  stepResultByStepRunId?: Record<string, WorkflowStepResult>;
}

export class OrchestratorRunNotFoundError extends Error {
  readonly code = "workflow_run_not_found" as const;

  constructor(runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "OrchestratorRunNotFoundError";
  }
}

export class OrchestratorRunNotActiveError extends Error {
  readonly code = "workflow_run_not_active" as const;

  constructor(runId: string) {
    super(`Workflow run is not active: ${runId}`);
    this.name = "OrchestratorRunNotActiveError";
  }
}

export class OrchestratorStepNotFoundError extends Error {
  readonly code = "workflow_step_run_not_found" as const;

  constructor(stepRunId: string | null) {
    super(`Workflow step run not found: ${stepRunId ?? "null"}`);
    this.name = "OrchestratorStepNotFoundError";
  }
}

export class OrchestratorTemplateNotFoundError extends Error {
  readonly code = "workflow_template_not_found" as const;

  constructor(templateId: string) {
    super(`Workflow template not found: ${templateId}`);
    this.name = "OrchestratorTemplateNotFoundError";
  }
}

export class OrchestratorGoalNotFoundError extends Error {
  readonly code = "goal_not_found" as const;

  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "OrchestratorGoalNotFoundError";
  }
}

function readStepRun(db: Database.Database, stepRunId: string | null): StepRunRow {
  if (!stepRunId) throw new OrchestratorStepNotFoundError(stepRunId);
  const row = db
    .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as StepRunRow | undefined;
  if (!row) throw new OrchestratorStepNotFoundError(stepRunId);
  return row;
}

function readGoal(db: Database.Database, goalId: string): GoalRow {
  const row = db
    .prepare(
      "SELECT id, title, description, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?",
    )
    .get(goalId) as GoalRow | undefined;
  if (!row) throw new OrchestratorGoalNotFoundError(goalId);
  return row;
}

function requestEventPayload(args: {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  stepTemplateId: string;
}): Record<string, unknown> {
  return {
    goalId: args.goalId,
    workflowRunId: args.workflowRunId,
    stepRunId: args.stepRunId,
    stepTemplateId: args.stepTemplateId,
  };
}

/** Minimal no-op output store used when sessionOutputStore is not injected */
const NULL_OUTPUT_STORE: SessionOutputStore = {
  appendChunk: () => { throw new Error("appendChunk not supported on null output store"); },
  readTail: (sessionId) => ({
    sessionId,
    firstByteOffset: 0,
    nextSeq: 0,
    totalBytesKept: 0,
    chunks: [],
  }),
};

export class OrchestratorService {
  private readonly sessionOutputStore: SessionOutputStore;

  constructor(
    private readonly operatorSelector: Pick<OperatorSelector, "select">,
    private readonly broker: Pick<OrchestrationTransportBroker, "propose">,
    private readonly operators: Pick<OperatorRegistry, "list">,
    private readonly launcher: WorkflowSessionLauncher = {
      launch: async () => { throw new Error("direct_launch_unsupported"); },
    },
    sessionOutputStore?: SessionOutputStore,
    private readonly stepDispatch?: StepDispatchCapabilities,
    private readonly orchestratorMediator?: Pick<OrchestratorMediator, "invoke"> & Partial<Pick<OrchestratorMediator, "invokeWithBackoff">>,
    // Spawns the tmux worker for a freshly-created step session (resolves workspace + adapter spawn in the wiring).
    private readonly workerSpawn?: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>,
    // Reliable idle-gated submit to the worker's stdin (initial objective, forwards, revise feedback).
    private readonly workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">,
    // Best-effort worker termination when a step's session ends.
    private readonly workerTerminate?: (sessionId: string) => Promise<void>
  ) {
    this.sessionOutputStore = sessionOutputStore ?? NULL_OUTPUT_STORE;
  }

  /**
   * Called when a session reaches a terminal state (exited | stopped | failed).
   * Synthesizes step output from session tail (exited) or blocks the run
   * (failed/stopped). Idempotent: if step_output already exists, skips
   * synthesis but still drives advancement via requestNextDecision.
   */
  async onWorkflowSessionCompleted(
    db: Database.Database,
    now: () => string,
    args: { sessionId: string; goalId: string },
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    // (1) Load session; skip if not linked to a workflow step run.
    const sess = db
      .prepare(
        "SELECT id, workflow_step_run_id, status, failure_reason FROM sessions WHERE id = ?"
      )
      .get(args.sessionId) as
      | { id: string; workflow_step_run_id: string | null; status: string; failure_reason: string | null }
      | undefined;
    if (!sess || !sess.workflow_step_run_id) return;

    // (2) Load step run; skip if not active.
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(sess.workflow_step_run_id) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;

    // (3) Idempotency: skip synthesis if step_output exists, but still advance.
    const existing = db
      .prepare(
        "SELECT 1 FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1"
      )
      .get(stepRun.id);
    if (existing) {
      await this.requestNextDecision(db, now, stepRun.workflow_run_id, options).catch(() => {});
      return;
    }

    // (4) Load run, template, goal — needed for blockRun/synthesis context.
    const run = getWorkflowRunById(db, stepRun.workflow_run_id);
    if (!run || run.status !== "active") return;
    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, run.goalId);

    // (5) Non-exited terminal states.
    // User-requested stop is not a crash → block immediately.
    if (sess.status === "stopped") {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `session stopped${sess.failure_reason ? `: ${sess.failure_reason}` : ""}`,
        options
      );
      return;
    }
    // Crash → consume a retry from the budget; respawn under cap, escalate at cap.
    if (sess.status === "failed") {
      const counter = incrementCrashRetry(stepRun.crash_retries ?? 0);
      db.prepare("UPDATE workflow_step_runs SET crash_retries = ? WHERE id = ?").run(
        counter.nextAttempt,
        stepRun.id
      );
      if (counter.capReached) {
        this.postOrchestratorMessage(
          db,
          now,
          run.goalId,
          `The agent for "${stepTpl.name}" crashed ${CRASH_RETRY_CAP} times${sess.failure_reason ? ` (${sess.failure_reason})` : ""}. Manual intervention needed.`,
          options
        );
      } else {
        await this.spawnStepAgent(
          db,
          now,
          { run, stepRun, stepTpl, template, goal },
          options
        );
      }
      return;
    }

    // (6) Build synthesis inputs from session tail and artifact history.
    const tail = decodeSessionTail(this.sessionOutputStore.readTail(args.sessionId));
    const artifacts = listArtifactsForRun(db, run.id);
    const transcript = reconstructTranscript(artifacts.filter((a) => a.stepRunId === stepRun.id));
    const stepRunByStepId = this.stepRunIdsByTemplateId(db, run.id);
    const stepInput = buildStepExecutionInput({
      goal: { id: goal.id, description: goal.description },
      steps: template.steps,
      currentStep: stepTpl,
      artifacts,
      transcript,
      stepRunByStepId,
    });

    // (7) Orchestrator model required for synthesis.
    const provider = goal.orchestrator_provider;
    const model = goal.orchestrator_model;
    if (!provider || !model) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        "synthesis requires orchestrator model",
        options
      );
      return;
    }

    // (8) Parse-then-synthesize.
    const result = await synthesizeStepOutput(
      { broker: this.broker },
      {
        goalId: goal.id,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        providerId: provider,
        modelId: model,
        outputSchema: stepTpl.outputSchema,
        stepInput,
        sessionResult: tail,
      }
    );

    if (!result.ok) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, result.reason, options);
      return;
    }

    // (9) Write step_output artifact with source + linkedSessionId.
    const body = JSON.stringify({
      ...result.output,
      _completion: {
        confidence: "medium",
        assumptions: [],
        openQuestions: [],
        whyComplete: `Derived from session ${args.sessionId} via ${result.source}`,
      },
    });
    const stagedEvents: DomainEvent[] = [];
    createArtifact(
      db,
      now,
      {
        goalId: goal.id,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        type: "step_output",
        title: stepTpl.name.slice(0, 256),
        body,
        source: result.source,
        linkedSessionId: args.sessionId,
        linkedTaskId: null,
        linkedContextPackageId: null,
      },
      options.idFactory,
      stagedEvents
    );
    this.publish(options.bus, stagedEvents);

    // (10) Drive advancement to the next step / completion.
    const stepResult = await this.scoreCompletedStepResult(
      db,
      now,
      { run, stepRun, stepTpl, goal },
      result.output
    );
    await this.requestNextDecision(db, now, run.id, {
      ...options,
      stepResultByStepRunId: { [stepRun.id]: stepResult },
    });
  }

  /**
   * Called whenever a chunk of session output lands. Scans the tail for the
   * [orca:ask] sentinel and, if found, records a request_user_input decision.
   * Idempotent: a second call with the same sentinel is a no-op because
   * hasActiveUnansweredQuestion returns true once the first decision exists.
   */
  async onSessionOutputChunk(
    db: Database.Database,
    now: () => string,
    args: { sessionId: string; goalId: string },
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    // (1) Resolve step run from session.
    const sess = db
      .prepare("SELECT workflow_step_run_id FROM sessions WHERE id = ?")
      .get(args.sessionId) as { workflow_step_run_id: string | null } | undefined;
    if (!sess?.workflow_step_run_id) return;

    // (2) Load step run; skip if not active.
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(sess.workflow_step_run_id) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;

    // (3) Scan the tail for a sentinel.
    const tail = decodeSessionTail(this.sessionOutputStore.readTail(args.sessionId));
    const question = detectPendingAgentQuestion(tail);
    if (!question) return;

    // (4) Idempotency: already an unanswered question outstanding?
    const stepArtifacts = listArtifactsForRun(db, stepRun.workflow_run_id).filter(
      (a) => a.stepRunId === stepRun.id
    );
    if (this.hasActiveUnansweredQuestion(db, stepArtifacts, stepRun.id)) return;

    // (5) Load run, template, step template to call commitUserInputDecision.
    const run = getWorkflowRunById(db, stepRun.workflow_run_id);
    if (!run || run.status !== "active") return;
    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;

    // (6) Record the decision.
    this.commitUserInputDecision(
      db,
      now,
      run.goalId,
      run.id,
      stepRun,
      stepTpl,
      question,
      options
    );
  }

  /**
   * Called when a per-step agent emits a completed response (via the
   * /v1/agent-hooks/response-done endpoint). Judges the response and applies the
   * resulting OrchestratorAction: forwards/paraphrases chat messages, approves a
   * step (writing step_output + advancing), sends revise feedback back to the
   * agent (bounded by REVISE_CAP), or escalates to the user.
   *
   * No-op when the session is not linked to an active workflow step run, or when
   * no orchestrator mediator is configured (production wiring lands in a later
   * sub-plan; behavior is proven via unit tests with a fake mediator).
   */
  async onAgentResponseDone(
    db: Database.Database,
    now: () => string,
    payload: { sessionId: string; adapterId: string; responseText: string },
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const sess = db
      .prepare("SELECT workflow_step_run_id FROM sessions WHERE id = ?")
      .get(payload.sessionId) as { workflow_step_run_id: string | null } | undefined;
    if (!sess?.workflow_step_run_id) return;
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(sess.workflow_step_run_id) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;
    const run = getWorkflowRunById(db, stepRun.workflow_run_id);
    if (!run || run.status !== "active") return;
    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, run.goalId);
    if (!this.orchestratorMediator) return; // not configured

    if (!goal.orchestrator_provider || !goal.orchestrator_model) return;
    const adapterId = adapterIdForProvider(goal.orchestrator_provider);
    const modelId = goal.orchestrator_model;

    const action = await judgeAgentResponse({
      mediator: this.orchestratorMediator as OrchestratorMediator,
      schemaValidate: (output) => {
        const v = validateStepOutput(stepTpl.outputSchema, output);
        return v.ok ? { ok: true } : { ok: false, errors: v.errors };
      },
      goalId: run.goalId,
      runId: run.id,
      stepRunId: stepRun.id,
      adapterId,
      modelId,
      responseText: payload.responseText,
    });

    const ctx = { run, stepRun, stepTpl, template, goal };
    await this.applyOrchestratorAction(
      db,
      now,
      ctx,
      payload.sessionId,
      payload.responseText,
      action,
      options
    );
  }

  /**
   * Applies an OrchestratorAction produced by the mediator. Shared by
   * onAgentResponseDone (response-done trigger) and onUserMessage (user_message
   * trigger). Effects:
   *  - paraphrase / answer / escalate → post an orchestrator chat message
   *  - forward_to_agent → relay the translated text into the live agent session
   *  - approve_step_complete → write step_output (from the response's
   *    orca:step-complete block) and advance the run
   *  - revise_step → bump the revise counter; below the cap relay feedback to the
   *    agent, at the cap post an escalation message
   */
  private async applyOrchestratorAction(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    sessionId: string | null,
    responseText: string,
    action: OrchestratorAction,
    options: RequestNextDecisionOptions
  ): Promise<{ postedChatReply: boolean }> {
    switch (action.kind) {
      case "paraphrase_agent_message":
      case "answer_user_directly":
      case "escalate_to_user": {
        this.postOrchestratorMessage(db, now, ctx.run.goalId, action.body, options);
        return { postedChatReply: true };
      }
      case "forward_to_agent": {
        if (sessionId && this.workerDeliver) {
          const r = await this.workerDeliver(sessionId, action.translated);
          if (r !== "delivered") {
            this.postOrchestratorMessage(
              db,
              now,
              ctx.run.goalId,
              r === "timeout"
                ? "Unable to forward the message because the step agent did not become idle in time."
                : "Unable to forward the message because the step agent session is not running.",
              options
            );
            return { postedChatReply: true };
          }
        } else {
          this.postOrchestratorMessage(
            db,
            now,
            ctx.run.goalId,
            "Unable to forward the message because no step agent session is available.",
            options
          );
          return { postedChatReply: true };
        }
        return { postedChatReply: false };
      }
      case "approve_step_complete": {
        const block = extractOrcaStepCompleteBlock(responseText);
        const stagedEvents: DomainEvent[] = [];
        this.createStepOutputArtifact(
          db,
          now,
          ctx,
          JSON.stringify(block ?? {}),
          options,
          stagedEvents
        );
        this.publish(options.bus, stagedEvents);
        // Best-effort: terminate the tmux worker for the completed step session.
        if (sessionId) {
          void this.workerTerminate?.(sessionId);
        }
        const output = block && typeof block === "object" && !Array.isArray(block)
          ? (block as Record<string, unknown>)
          : null;
        const stepResult = await this.scoreCompletedStepResult(db, now, ctx, output);
        await this.advanceToNextStep(db, now, ctx.run.id, {
          ...options,
          stepResultByStepRunId: { [ctx.stepRun.id]: stepResult },
        });
        return { postedChatReply: false };
      }
      case "revise_step": {
        const counter = incrementReviseAttempt(ctx.stepRun.revise_attempts ?? 0);
        db.prepare("UPDATE workflow_step_runs SET revise_attempts = ? WHERE id = ?").run(
          counter.nextAttempt,
          ctx.stepRun.id
        );
        if (counter.capReached) {
          this.postOrchestratorMessage(
            db,
            now,
            ctx.run.goalId,
            `Step needs help after ${REVISE_CAP} revision attempts:\n${action.feedback}`,
            options
          );
          return { postedChatReply: true };
        }
        if (sessionId && this.workerDeliver) {
          const r = await this.workerDeliver(sessionId, action.feedback);
          if (r !== "delivered") {
            this.postOrchestratorMessage(
              db,
              now,
              ctx.run.goalId,
              r === "timeout"
                ? "Unable to send revision feedback because the step agent did not become idle in time."
                : "Unable to send revision feedback because the step agent session is not running.",
              options
            );
            return { postedChatReply: true };
          }
        } else {
          this.postOrchestratorMessage(
            db,
            now,
            ctx.run.goalId,
            "Unable to send revision feedback because no step agent session is available.",
            options
          );
          return { postedChatReply: true };
        }
        return { postedChatReply: false };
      }
    }
  }

  /**
   * Builds a short user-facing acknowledgment for a user_message-triggered
   * action that did NOT itself post a chat reply (forward_to_agent,
   * approve_step_complete, revise_step under cap). Without this the chat UI's
   * "thinking" indicator never clears, because it only stops once a non-user
   * message lands. `sessionId` is null when no live agent session exists for the
   * current step (e.g. after a daemon restart) — surface that to the user
   * instead of letting the relay silently no-op.
   */
  private acknowledgeUserMessageAction(
    action: OrchestratorAction,
    sessionId: string | null
  ): string {
    switch (action.kind) {
      case "forward_to_agent":
        return sessionId
          ? "Relayed your message to the agent working the current step."
          : "Couldn't relay your message — no live agent session for the current step. It may need to be respawned.";
      case "approve_step_complete":
        return "Approved the current step from your message — advancing the workflow.";
      case "revise_step":
        return sessionId
          ? "Sent your feedback to the agent as a revision."
          : "Couldn't send your feedback — no live agent session for the current step. It may need to be respawned.";
      default:
        return "Working on it.";
    }
  }

  /**
   * Called when a user posts an orchestrator chat message during an active
   * workflow run. Invokes the orchestrator-LLM mediator with the user_message
   * trigger and applies the resulting action (paraphrase / answer / forward to
   * agent / escalate / approve / revise).
   *
   * No-op when no mediator is configured (production wiring lands later), when
   * the goal has no active run, or when the run has no active current step.
   */
  async onUserMessage(
    db: Database.Database,
    now: () => string,
    args: { goalId: string; body: string },
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    if (!this.orchestratorMediator) return;

    const runId = (
      db
        .prepare(
          "SELECT id FROM workflow_runs WHERE goal_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
        )
        .get(args.goalId) as { id: string } | undefined
    )?.id;
    if (!runId) return;
    const run = getWorkflowRunById(db, runId);
    if (!run || run.status !== "active" || !run.currentStepRunId) return;
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;
    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = db
      .prepare(
        "SELECT id, title, description, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?"
      )
      .get(run.goalId) as GoalRow | undefined;
    if (!goal) return;

    if (!goal.orchestrator_provider || !goal.orchestrator_model) return;
    const adapterId = adapterIdForProvider(goal.orchestrator_provider);
    const modelId = goal.orchestrator_model;

    const invoke = this.orchestratorMediator.invokeWithBackoff?.bind(this.orchestratorMediator) ?? this.orchestratorMediator.invoke.bind(this.orchestratorMediator);

    let action;
    try {
      action = await invoke({
        triggerKind: "user_message",
        goalId: args.goalId,
        runId: run.id,
        stepRunId: stepRun.id,
        adapterId,
        modelId,
        triggerPayload: { userMessage: args.body },
      });
    } catch (err) {
      this.postOrchestratorMessage(
        db, now, run.goalId,
        `Orchestrator-LLM unavailable after retries; pausing — last error: ${err instanceof Error ? err.message : "unknown"}`,
        options
      );
      return;
    }

    // Live session for the current step (needed for forward_to_agent / revise).
    const sessionId =
      (
        db
          .prepare(
            "SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('created','starting','running') ORDER BY created_at DESC LIMIT 1"
          )
          .get(stepRun.id) as { id: string } | undefined
      )?.id ?? null;

    const ctx = { run, stepRun, stepTpl, template, goal };
    const { postedChatReply } = await this.applyOrchestratorAction(
      db, now, ctx, sessionId, "", action, options
    );
    // The chat UI clears its "thinking" indicator only when a non-user message
    // arrives. Actions that route to the agent (forward_to_agent) or advance the
    // workflow (approve_step_complete) post nothing to chat, so acknowledge them
    // here — otherwise the user's bubble spins forever.
    if (!postedChatReply) {
      this.postOrchestratorMessage(
        db, now, run.goalId,
        this.acknowledgeUserMessageAction(action, sessionId),
        options
      );
    }
  }

  /**
   * Inserts a single orchestrator_messages row (role "orchestrator", kind
   * "message") and emits the orchestrator.message.created event, mirroring the
   * orchestrator-chat use case shape. Used for escalations and forwarded /
   * paraphrased agent messages.
   */
  private postOrchestratorMessage(
    db: Database.Database,
    now: () => string,
    goalId: string,
    body: string,
    options: RequestNextDecisionOptions
  ): void {
    const idFactory = options.idFactory ?? randomUUID;
    const messageId = idFactory();
    const correlationId = idFactory();
    const createdAt = now();
    const event = db.transaction(() => {
      db.prepare(
        `INSERT INTO orchestrator_messages
          (id, goal_id, role, kind, body, correlation_id, created_at)
         VALUES (?, ?, 'orchestrator', 'message', ?, ?, ?)`
      ).run(messageId, goalId, body, correlationId, createdAt);
      const payload = { messageId, role: "orchestrator" as const };
      const eventId = idFactory();
      const result = db
        .prepare(
          "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          eventId,
          "orchestrator.message.created",
          goalId,
          JSON.stringify(payload),
          createdAt
        );
      return {
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type: "orchestrator.message.created",
        goalId,
        payload,
        createdAt,
      } satisfies DomainEvent;
    })();
    options.bus?.publish(event);
  }

  /**
   * Bootstraps a workflow run by spawning the agent for its first step (ordinal
   * 0). Used by the run-bootstrap route. The current step run must already point
   * at the first step (created at run start).
   */
  async startWorkflowFirstStep(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) throw new OrchestratorRunNotFoundError(runId);
    const template = getTemplateById(db, run.templateId);
    if (!template) throw new OrchestratorTemplateNotFoundError(run.templateId);
    const firstStep = template.steps.find((s) => s.ordinal === 0);
    if (!firstStep) throw new Error(`template has no first step: ${run.templateId}`);
    const stepRun = readStepRun(db, run.currentStepRunId);
    const goal = readGoal(db, run.goalId);
    await this.spawnStepAgent(
      db,
      now,
      { run, stepRun, stepTpl: firstStep, template, goal },
      options
    );
  }

  /**
   * Re-launches the agent for a run's currently-active step. Used by boot-time
   * resume: node-pty children die with the daemon, so on restart an active step's
   * session is gone and must be respawned. No-op if the run/step is no longer
   * active. spawnStepAgent is idempotent on selection (already-selected step is
   * re-launched without re-selecting), so this just relaunches the session.
   */
  async respawnStepAgent(
    db: Database.Database,
    now: () => string,
    runId: string,
    stepRunId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || run.status !== "active") return;
    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = db
      .prepare(
        "SELECT id, title, description, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?"
      )
      .get(run.goalId) as GoalRow | undefined;
    if (!goal) return;
    await this.spawnStepAgent(db, now, { run, stepRun, stepTpl, template, goal }, options);
  }

  /**
   * Advances the run past the current step's produced output, then — when an
   * intermediate step becomes active — spawns the next step's agent. On the
   * terminal step, commitAdvanceOrComplete produces the complete_workflow_run
   * recommendation and no further agent is spawned.
   *
   * Composition note: commitAdvanceOrComplete, for an intermediate step, calls
   * the free-function advanceToNextStep (moving currentStepRunId) and then
   * recurses via requestNextDecision. That recursion deterministically *selects*
   * the next step's operator but does NOT launch a session. spawnStepAgent is
   * therefore idempotent on selection (it skips re-selecting an already-selected
   * step) so the operator is selected exactly once and the agent launched
   * exactly once.
   */
  async advanceToNextStep(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) throw new OrchestratorRunNotFoundError(runId);
    const stepRun = readStepRun(db, run.currentStepRunId);
    const template = getTemplateById(db, run.templateId);
    if (!template) throw new OrchestratorTemplateNotFoundError(run.templateId);
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorStepNotFoundError(stepRun.id);
    const goal = readGoal(db, run.goalId);

    await this.commitAdvanceOrComplete(db, now, { run, stepRun, stepTpl, template, goal }, options);

    // If a NEW intermediate step is now active, spawn its agent (exactly once).
    const after = getWorkflowRunById(db, runId);
    if (
      after &&
      after.status === "active" &&
      after.currentStepRunId &&
      after.currentStepRunId !== stepRun.id
    ) {
      const nextStepRun = readStepRun(db, after.currentStepRunId);
      const nextTpl = template.steps.find((s) => s.id === nextStepRun.step_template_id);
      if (nextTpl) {
        await this.spawnStepAgent(
          db,
          now,
          { run: after, stepRun: nextStepRun, stepTpl: nextTpl, template, goal },
          options
        );
      }
    }
  }

  /**
   * Resolves the deterministic per-step agent dispatch, persists the selection
   * (idempotent — skipped if the step is already operator-selected), then
   * launches a session for the step with a composed initial prompt.
   */
  private async spawnStepAgent(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    if (!this.stepDispatch) throw new Error("step dispatch capabilities not configured");
    const dispatch = await resolveStepDispatch({
      preferences: preferencesForGoal(ctx.stepTpl.agentPreference, ctx.goal.orchestrator_provider),
      isAdapterReady: (id) => this.stepDispatch!.isAdapterReady(id),
      supportsModel: (id, mid) => this.stepDispatch!.supportsModel(id, mid),
      resolveMode: (id) => this.stepDispatch!.resolveMode(id),
    });

    // Persist selection only when the step has not already been operator-selected
    // (commitAdvanceOrComplete's recursion may have selected it already).
    if (ctx.stepRun.selected_operator_id !== `agent:${dispatch.adapterId}`) {
      this.commitDeterministicStepSelection(db, now, ctx, dispatch, options);
    }

    const objective = composeAgentInitialPrompt({
      goalTitle: ctx.goal.title,
      goalDescription: ctx.goal.description,
      stepInstructions: ctx.stepTpl.instructions,
      outputSchema: ctx.stepTpl.outputSchema,
      priorStepArtifacts: this.collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.ordinal),
    });

    try {
      const { sessionId } = await this.launcher.launch({
        goalId: ctx.goal.id,
        workflowRunId: ctx.run.id,
        workflowStepRunId: ctx.stepRun.id,
        operatorId: "agent:" + dispatch.adapterId,
        operatorKind: "agent",
        objective,
      });

      // Run the agent as a headless tmux worker, then submit its objective.
      await this.workerSpawn?.({ sessionId, goalId: ctx.goal.id, adapterId: dispatch.adapterId });
      const delivered = await this.workerDeliver?.(sessionId, objective);
      if (delivered && delivered !== "delivered") {
        this.postOrchestratorMessage(
          db,
          now,
          ctx.goal.id,
          delivered === "timeout"
            ? `Unable to submit the initial step objective (${dispatch.adapterId}): the step agent did not become idle in time.`
            : `Unable to submit the initial step objective (${dispatch.adapterId}): the step agent session is not running.`,
          options
        );
      }
    } catch (err) {
      this.postOrchestratorMessage(
        db,
        now,
        ctx.goal.id,
        `Unable to start the step agent (${dispatch.adapterId}): ${err instanceof Error ? err.message : "unknown error"}`,
        options
      );
    }
  }

  /**
   * Reads step_output artifacts for steps with ordinal < the current step,
   * returning each as { stepId, outputJson }. stepId is the step_template_id of
   * the artifact's step run; outputJson is the parsed artifact body.
   */
  private collectPriorStepArtifacts(
    db: Database.Database,
    runId: string,
    ordinal: number
  ): Array<{ stepId: string; outputJson: unknown }> {
    const stepRuns = db
      .prepare(
        "SELECT id, step_template_id, ordinal FROM workflow_step_runs WHERE workflow_run_id = ?"
      )
      .all(runId) as Array<{ id: string; step_template_id: string; ordinal: number }>;
    const byId = new Map(stepRuns.map((s) => [s.id, s]));
    const out: Array<{ stepId: string; outputJson: unknown }> = [];
    for (const artifact of listArtifactsForRun(db, runId)) {
      if (artifact.type !== "step_output" || !artifact.stepRunId) continue;
      const owner = byId.get(artifact.stepRunId);
      if (!owner || owner.ordinal >= ordinal) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.body);
      } catch {
        parsed = artifact.body;
      }
      out.push({ stepId: owner.step_template_id, outputJson: parsed });
    }
    return out;
  }

  async requestNextDecision(
    db: Database.Database,
    now: () => string,
    workflowRunId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const run = getWorkflowRunById(db, workflowRunId);
    if (!run) throw new OrchestratorRunNotFoundError(workflowRunId);
    if (run.status !== "active") throw new OrchestratorRunNotActiveError(workflowRunId);

    const template = getTemplateById(db, run.templateId);
    if (!template) throw new OrchestratorTemplateNotFoundError(run.templateId);
    const stepRun = readStepRun(db, run.currentStepRunId);
    if (stepRun.status !== "active") throw new OrchestratorRunNotActiveError(workflowRunId);
    const stepTpl = template.steps.find((step) => step.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorStepNotFoundError(stepRun.id);
    const goal = readGoal(db, run.goalId);

    return this.commitSkillStepDecision(
      db,
      now,
      { run, stepRun, stepTpl, template, goal },
      options
    );
  }

  private async commitSkillStepDecision(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, stepRun, stepTpl, template, goal } = ctx;
    const artifacts = listArtifactsForRun(db, run.id);
    const stepArtifacts = artifacts.filter((a) => a.stepRunId === stepRun.id);

    // (1) idempotency: a valid step_output already exists -> advance or complete.
    if (stepArtifacts.some((a) => a.type === "step_output")) {
      return this.commitAdvanceOrComplete(db, now, ctx, options);
    }

    // (2) idempotency: an unanswered question is outstanding -> wait, create nothing new.
    if (this.hasActiveUnansweredQuestion(db, stepArtifacts, stepRun.id)) {
      return this.commitNoop(db, run.id, stepRun.id);
    }

    // (3) deterministically resolve the per-step agent once.
    const sel = getWorkflowStepRunById(db, stepRun.id);
    if (!sel || !sel.selectedOperatorId) {
      if (!this.stepDispatch) {
        return this.blockRun(db, now, ctx, "step dispatch capabilities not configured", options);
      }
      const dispatch = await resolveStepDispatch({
        preferences: preferencesForGoal(stepTpl.agentPreference, goal.orchestrator_provider),
        isAdapterReady: (id) => this.stepDispatch!.isAdapterReady(id),
        supportsModel: (id, mid) => this.stepDispatch!.supportsModel(id, mid),
        resolveMode: (id) => this.stepDispatch!.resolveMode(id),
      }).catch(() => null);
      if (!dispatch) {
        return this.blockRun(db, now, ctx, "no ready agent for step", options);
      }
      return this.commitDeterministicStepSelection(db, now, ctx, dispatch, options);
    }

    // (3a) branch on operator kind.
    const descriptors = await this.operators.list(goal.id);
    const chosen = descriptors.find((d) => d.id === sel.selectedOperatorId);
    if (!chosen) {
      return this.blockRun(db, now, ctx, "selected operator missing", options);
    }
    if (chosen.kind === "agent") {
      return this.commitAgentStepDecision(db, now, ctx, chosen, options);
    }

    // Model path: require providerId + modelId.
    if (!sel.selectedProviderId || !sel.selectedModelId) {
      return this.blockRun(db, now, ctx, "no ready model operator", options);
    }

    // (4) run the skill turn.
    const transcript = reconstructTranscript(stepArtifacts);
    const stepRunByStepId = this.stepRunIdsByTemplateId(db, run.id);
    const rawWorkspaces = listWorkspacesByGoal(db, goal.id);
    const workspaceContext = assembleWorkspaceContext({
      workspaces: rawWorkspaces.map((w) => ({ id: w.id, name: w.name, root: w.path })),
      summaries: [],
      snippets: [],
      payloadBudget: Math.floor(ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES * 0.25),
    });
    const input = buildStepExecutionInput({
      goal: { id: goal.id, description: goal.description },
      steps: template.steps,
      currentStep: stepTpl,
      artifacts,
      transcript,
      stepRunByStepId,
      workspaceContext: workspaceContext.workspaces.length > 0 ? workspaceContext : undefined,
    });

    const validate = (raw: unknown) => {
      const parsed = StepSkillProposal.safeParse(raw);
      if (!parsed.success) {
        return { accepted: false as const, failureMessage: "invalid step skill proposal" };
      }
      if (parsed.data.action === "complete") {
        const v = validateStepOutput(stepTpl.outputSchema, parsed.data.output);
        if (!v.ok) {
          return { accepted: false as const, failureMessage: `schema: ${v.errors.join("; ")}` };
        }
      }
      return { accepted: true as const, parsed: parsed.data };
    };

    const request = OrchestrationRequest.parse({
      kind: "run_step_skill",
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      providerId: sel.selectedProviderId,
      modelId: sel.selectedModelId,
      payload: input,
    });

    let result = await this.broker.propose(request, { validateProposal: validate });
    if (result.status !== "proposed") {
      result = await this.broker.propose(request, { validateProposal: validate });
    }
    if (result.status !== "proposed") {
      return this.blockRun(db, now, ctx, "step output did not match schema", options);
    }

    const proposal = result.parsed as StepSkillProposal;
    if (proposal.action === "ask") {
      return this.commitUserInputDecision(
        db,
        now,
        goal.id,
        run.id,
        stepRun,
        stepTpl,
        proposal.question,
        options
      );
    }

    // _completion is reserved on step_output bodies; a step outputSchema must not define it.
    const body = JSON.stringify({ ...proposal.output, _completion: proposal.completion });
    // Artifact write and the advance/complete decision are separate transactions but recoverable:
    // a crash between them re-routes via the existing step_output idempotency branch on retry.
    const artifactEvents: DomainEvent[] = [];
    this.createStepOutputArtifact(db, now, ctx, body, options, artifactEvents);
    this.publish(options.bus, artifactEvents);
    return this.commitAdvanceOrComplete(db, now, ctx, options);
  }

  private stepRunIdsByTemplateId(
    db: Database.Database,
    workflowRunId: string
  ): Record<string, string> {
    const rows = db
      .prepare(
        "SELECT step_template_id, id FROM workflow_step_runs WHERE workflow_run_id = ?"
      )
      .all(workflowRunId) as Array<{ step_template_id: string; id: string }>;
    const out: Record<string, string> = {};
    for (const row of rows) out[row.step_template_id] = row.id;
    return out;
  }

  private artifactCountForStep(db: Database.Database, stepRunId: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE step_run_id = ?")
        .get(stepRunId) as { count: number }
    ).count;
  }

  private retryCount(stepRun: StepRunRow): number {
    return (
      Math.max(stepRun.attempt - 1, 0) +
      (stepRun.revise_attempts ?? 0) +
      (stepRun.crash_retries ?? 0)
    );
  }

  private scoringFacts(
    db: Database.Database,
    stepRun: StepRunRow,
    terminalStatus: "passed" | "blocked" | "failed" | "skipped",
    finishedAt: string
  ): StepResultScoringFacts {
    return {
      stepId: stepRun.id,
      stepStatus: mapStepRunStatusToResultStatus(terminalStatus),
      performance: {
        durationSeconds: durationSeconds(stepRun.started_at, finishedAt),
        retries: this.retryCount(stepRun),
      },
      outcome: {
        producedArtifactsCount: this.artifactCountForStep(db, stepRun.id),
        blockingIssuesCount: terminalStatus === "blocked" || terminalStatus === "failed" ? 1 : 0,
        warningsCount: 0,
      },
    };
  }

  private async scoreCompletedStepResult(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    output: Record<string, unknown> | null
  ): Promise<WorkflowStepResult> {
    const finishedAt = now();
    const facts = this.scoringFacts(db, ctx.stepRun, "passed", finishedAt);
    if (!ctx.goal.orchestrator_provider || !ctx.goal.orchestrator_model) {
      return buildEvaluationFailedStepResult({
        stepId: ctx.stepRun.id,
        stepStatus: facts.stepStatus,
        startedAt: ctx.stepRun.started_at,
        finishedAt,
        retries: facts.performance.retries,
        producedArtifactsCount: facts.outcome.producedArtifactsCount,
        blockingIssuesCount: facts.outcome.blockingIssuesCount,
        warningsCount: facts.outcome.warningsCount,
        reason: "orchestrator model not configured",
      });
    }

    const result = await scoreStepResult(
      { broker: this.broker },
      {
        goalId: ctx.goal.id,
        workflowRunId: ctx.run.id,
        stepRunId: ctx.stepRun.id,
        providerId: ctx.goal.orchestrator_provider,
        modelId: ctx.goal.orchestrator_model,
        goal: { id: ctx.goal.id, description: ctx.goal.description },
        step: {
          id: ctx.stepRun.id,
          templateId: ctx.stepTpl.id,
          name: ctx.stepTpl.name,
          instructions: ctx.stepTpl.instructions,
          status: "passed",
        },
        output,
        facts,
      }
    );

    if (result.ok) return result.stepResult;

    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: result.reason,
    });
  }

  private hasActiveUnansweredQuestion(
    db: Database.Database,
    stepArtifacts: ReturnType<typeof listArtifactsForRun>,
    stepRunId: string
  ): boolean {
    const questionDecisions = db
      .prepare(
        "SELECT id FROM workflow_decisions WHERE step_run_id = ? AND decision_type = 'request_user_input'"
      )
      .all(stepRunId) as Array<{ id: string }>;
    if (questionDecisions.length === 0) return false;
    const answeredDecisionIds = new Set<string>();
    for (const artifact of stepArtifacts) {
      if (artifact.type !== "interview_turn") continue;
      const parsed = InterviewTurn.safeParse(JSON.parse(artifact.body));
      if (parsed.success) answeredDecisionIds.add(parsed.data.questionDecisionId);
    }
    return questionDecisions.some((d) => !answeredDecisionIds.has(d.id));
  }

  private commitNoop(
    db: Database.Database,
    workflowRunId: string,
    stepRunId: string
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const decisions = listDecisionsForRun(db, workflowRunId);
    const latest = decisions.find(
      (d) => d.stepRunId === stepRunId && d.decisionType === "request_user_input"
    );
    if (!latest) throw new Error(`active question decision not found for step run: ${stepRunId}`);
    return { decision: latest, recommendationIds: [] };
  }

  /**
   * Returns the latest decision for a step run, regardless of type.
   * Used by agent step noop paths where there is no "request_user_input" decision.
   */
  private commitNoopLatestDecision(
    db: Database.Database,
    workflowRunId: string,
    stepRunId: string
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const decisions = listDecisionsForRun(db, workflowRunId);
    const latest = decisions
      .filter((d) => d.stepRunId === stepRunId)
      .at(-1);
    if (!latest) throw new Error(`no decision found for step run: ${stepRunId}`);
    return { decision: latest, recommendationIds: [] };
  }

  private hasOpenLaunchRecommendation(
    db: Database.Database,
    stepRunId: string
  ): boolean {
    const row = db
      .prepare(
        "SELECT id FROM recommendations WHERE workflow_step_run_id = ? AND type = 'launch_workflow_session' AND status = 'proposed' LIMIT 1"
      )
      .get(stepRunId);
    return row !== undefined;
  }

  private commitLaunchRecommendation(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    chosen: OperatorDescriptor,
    objective: string,
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const { run, stepRun, stepTpl, goal } = ctx;
    const stagedEvents: DomainEvent[] = [];
    const output = db.transaction(() => {
      this.appendDecisionRequested(
        db,
        now,
        goal.id,
        run.id,
        stepRun.id,
        stepTpl.id,
        options,
        stagedEvents
      );
      const decision = recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "select_operator",
          selectedAction: `launch:${chosen.id}`,
          reason: `Launch ${chosen.displayName} to execute "${stepTpl.name}".`,
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "required",
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "select_operator",
            payload: { operatorId: chosen.id, action: "launch" },
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      const recommendationId = createRecommendationForWorkflowInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          type: "launch_workflow_session",
          proposedAction: {
            kind: "launch_workflow_session",
            workflowStepRunId: stepRun.id,
            operatorId: chosen.id,
            operatorKind: chosen.kind as "agent",
            objective,
          },
          rationale: `Launch ${chosen.displayName} to execute "${stepTpl.name}".`,
          decisionId: decision.decisionId,
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      return { decision, recommendationIds: [recommendationId] };
    })();
    this.publish(options.bus, stagedEvents);
    return output;
  }

  private async commitAgentStepDecision(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    chosen: OperatorDescriptor,
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, stepRun, stepTpl, template, goal } = ctx;

    // (a) running session linked? → no-op
    const linked = db
      .prepare(
        "SELECT id, status FROM sessions WHERE workflow_step_run_id = ? AND status IN ('created','starting','running')"
      )
      .all(stepRun.id) as Array<{ id: string; status: string }>;
    if (linked.length > 0) {
      return this.commitNoopLatestDecision(db, run.id, stepRun.id);
    }

    // (b) open launch recommendation? → idempotent no-op
    if (this.hasOpenLaunchRecommendation(db, stepRun.id)) {
      return this.commitNoopLatestDecision(db, run.id, stepRun.id);
    }

    // (c) build objective
    const objective = buildAgentObjective(stepTpl, { goal, stepRun });

    // (d) evaluate guardrails
    const guardrailCheck = evaluateGuardrailRequiresApproval(template.guardrails, {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      stepTemplateId: stepTpl.id,
      candidateAction: { kind: "launch_workflow_session", operatorId: chosen.id },
    });
    if (guardrailCheck === "deny") {
      return this.blockRun(db, now, ctx, "launch denied by guardrail", options);
    }
    const requiresApproval = guardrailCheck === "require_approval";

    // (e) route: recommendation or direct launch
    const launchCtx = {
      goalId: goal.id,
      workflowRunId: run.id,
      workflowStepRunId: stepRun.id,
      operatorId: chosen.id,
      operatorKind: "agent" as const,
      objective,
    };

    if (requiresApproval) {
      return this.commitLaunchRecommendation(db, now, ctx, chosen, objective, options);
    }

    // Direct launch: await to catch direct_launch_unsupported (e.g. no workspace attached).
    // On failure, fall back to a recommendation so the user can resolve the issue.
    try {
      await this.launcher.launch(launchCtx);
      return this.commitNoopLatestDecision(db, run.id, stepRun.id);
    } catch {
      return this.commitLaunchRecommendation(db, now, ctx, chosen, objective, options);
    }
  }

  private commitDeterministicStepSelection(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    dispatch: ResolvedStepDispatch,
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const { run, stepRun, stepTpl, goal } = ctx;
    const operatorId = `agent:${dispatch.adapterId}`;
    const providerId = dispatch.providerId ?? null;

    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(
        db,
        now,
        goal.id,
        run.id,
        stepRun.id,
        stepTpl.id,
        options,
        stagedEvents
      );
      const recorded = recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "select_operator",
          selectedAction: `select:${dispatch.adapterId}:${dispatch.modelId}`,
          reason: "deterministic preference resolution",
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "required",
            },
            {
              kind: "operator_readiness",
              id: operatorId,
              label: operatorId,
              effect: "satisfied",
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "select_operator",
            payload: { operatorId, source: "deterministic" },
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      recordOperatorSelection(db, stepRun.id, {
        operatorId,
        providerId,
        modelId: dispatch.modelId,
        at: now(),
      });
      stagedEvents.push(
        appendWorkflowEvent(
          db,
          "workflow.operator.selected",
          {
            decisionId: recorded.decisionId,
            goalId: goal.id,
            workflowRunId: run.id,
            stepRunId: stepRun.id,
            operatorId,
            operatorKind: "agent",
            source: "deterministic",
            executionMode: dispatch.executionMode,
          },
          now(),
          options.idFactory
        )
      );
      return recorded;
    })();
    this.publish(options.bus, stagedEvents);
    return { decision, recommendationIds: [] };
  }

  private createStepOutputArtifact(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    body: string,
    options: RequestNextDecisionOptions,
    stagedEvents: DomainEvent[]
  ): void {
    createArtifact(
      db,
      now,
      {
        goalId: ctx.goal.id,
        workflowRunId: ctx.run.id,
        stepRunId: ctx.stepRun.id,
        type: "step_output",
        title: ctx.stepTpl.name.slice(0, 256),
        body,
        source: "orchestrator",
        linkedSessionId: null,
        linkedTaskId: null,
        linkedContextPackageId: null,
      },
      options.idFactory,
      stagedEvents
    );
  }

  private async commitAdvanceOrComplete(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
    },
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, stepRun, stepTpl, template, goal } = ctx;
    const nextStepTpl = template.steps.find((step) => step.ordinal === stepRun.ordinal + 1);

    if (nextStepTpl) {
      const stagedEvents: DomainEvent[] = [];
      advanceToNextStep(
        db,
        now,
        stepRun.id,
        {
          idFactory: options.idFactory,
          stagedEvents,
        },
        options.stepResultByStepRunId?.[stepRun.id]
      );
      this.publish(options.bus, stagedEvents);
      // recursion depth is bounded by the number of consecutive auto-completing intermediate steps (template step count).
      return this.requestNextDecision(db, now, run.id, options);
    }

    const stagedEvents: DomainEvent[] = [];
    const output = db.transaction(() => {
      const stepResult = options.stepResultByStepRunId?.[stepRun.id];
      if (stepResult) {
        db.prepare("UPDATE workflow_step_runs SET step_result_json = ? WHERE id = ?").run(
          JSON.stringify(stepResult),
          stepRun.id
        );
      }
      this.appendDecisionRequested(
        db,
        now,
        goal.id,
        run.id,
        stepRun.id,
        stepTpl.id,
        options,
        stagedEvents
      );
      const decision = recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "mark_run_complete",
          selectedAction: "recommend_complete_run",
          reason: "Final step output produced; user approval required before completing the run",
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "satisfied",
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "mark_run_complete",
            payload: "complete",
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      const recommendationId = createRecommendationForWorkflowInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          type: "complete_workflow_run",
          proposedAction: {
            kind: "complete_workflow_run",
            workflowRunId: run.id,
            workflowStepRunId: stepRun.id,
          },
          rationale: "Final step output produced; approve to complete the workflow run.",
          decisionId: decision.decisionId,
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      return { decision, recommendationIds: [recommendationId] };
    })();
    this.publish(options.bus, stagedEvents);
    return output;
  }

  private blockRun(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    reason: string,
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const { run, stepRun, stepTpl, goal } = ctx;
    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(
        db,
        now,
        goal.id,
        run.id,
        stepRun.id,
        stepTpl.id,
        options,
        stagedEvents
      );
      return recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "block_run",
          selectedAction: "block:step_output",
          reason,
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "blocked",
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "block_run",
            payload: reason,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    this.publish(options.bus, stagedEvents);
    markWorkflowRunBlocked(
      { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
      run.id,
      reason
    );
    return { decision, recommendationIds: [] };
  }

  private commitUserInputDecision(
    db: Database.Database,
    now: () => string,
    goalId: string,
    workflowRunId: string,
    stepRun: StepRunRow,
    stepTpl: WorkflowStepTemplate,
    rawQuestion: string,
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const stagedEvents: DomainEvent[] = [];
    const question = rawQuestion.slice(0, 1024);
    const output = db.transaction(() => {
      this.appendDecisionRequested(db, now, goalId, workflowRunId, stepRun.id, stepTpl.id, options, stagedEvents);
      const decision = recordDecisionInTx(
        db,
        now,
        {
          goalId,
          workflowRunId,
          stepRunId: stepRun.id,
          decisionType: "request_user_input",
          selectedAction: `request_input:${stepTpl.id}`,
          reason: question,
          influencedBy: [
            {
              kind: "workflow_step" as const,
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "required" as const,
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: workflowRunId,
            stepRunId: stepRun.id,
            decisionType: "request_user_input",
            payload: question,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      const recommendationId = createRecommendationForWorkflowInTx(
        db,
        now,
        {
          goalId,
          workflowRunId,
          stepRunId: stepRun.id,
          type: "request_user_input",
          proposedAction: {
            kind: "request_user_input",
            workflowStepRunId: stepRun.id,
            question,
          },
          rationale: question,
          decisionId: decision.decisionId,
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      return { decision, recommendationIds: [recommendationId] };
    })();
    this.publish(options.bus, stagedEvents);
    return output;
  }

  private appendDecisionRequested(
    db: Database.Database,
    now: () => string,
    goalId: string,
    workflowRunId: string,
    stepRunId: string,
    stepTemplateId: string,
    options: RequestNextDecisionOptions,
    stagedEvents: DomainEvent[]
  ): void {
    stagedEvents.push(
      appendWorkflowEvent(
        db,
        "workflow.decision.requested",
        requestEventPayload({ goalId, workflowRunId, stepRunId, stepTemplateId }),
        now(),
        options.idFactory
      )
    );
  }

  private publish(bus: EventBus | undefined, stagedEvents: DomainEvent[]): void {
    if (bus) {
      publishStagedWorkflowEvents(bus, stagedEvents);
    }
  }
}
