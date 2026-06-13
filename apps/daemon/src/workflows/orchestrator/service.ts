import type Database from "better-sqlite3";
import {
  InterviewTurn,
  OrchestrationRequest,
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  StepResultScoringProposal,
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
  type WorkflowGraph,
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
import {
  advanceToNextStepOrGate,
  insertStepForRouting,
  nextAttemptForStep,
} from "../steps/usecases.js";
import { effectiveGraph, resolveGateNext, resolveStepNext } from "../graph/graph-routing.js";
import { evaluateGate } from "./gate-evaluation.js";
import { nextTraversalSeq, recordGateDecision } from "../gates/usecases.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
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
  buildScoredStepResult,
  durationSeconds,
  mapStepRunStatusToResultStatus,
} from "../steps/step-result.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";
import { randomUUID } from "node:crypto";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import {
  recoverStepScoring,
  type ShadowAsk,
} from "./recover-step-scoring.js";
import { materializeStepResultActivity } from "../../activities/step-result-activity.js";
import { getSupervisionMode } from "../../settings/store.js";
import { expireConfirmation, openOrUpdateLive, pauseForConfirmation, resumeFromConfirmation } from "../../activities/store.js";
import { recordRevisionSignal } from "../revision-signals/store.js";
import { summarizeScoring } from "./scoring-summary.js";

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

interface RecoveryScoringPromptInput {
  stepTpl: WorkflowStepTemplate;
  goal: GoalRow;
  output: Record<string, unknown>;
}

type RecoveryScoringPromptComposer = (
  input: RecoveryScoringPromptInput
) => { systemPrompt: string; userPrompt: string };

function composeRecoveryScoringPrompt(
  input: RecoveryScoringPromptInput
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      "Score a recovered Orca workflow step result.",
      "The JSON object has successScore, quality, reason, and handoffReady.",
      "All numeric values must be between 0 and 1.",
      "quality must contain outputCompleteness, outputCorrectness, instructionAdherence, downstreamReadiness, and riskLevel.",
      "For riskLevel, 0 means no risk and 1 means severe risk.",
      "Output protocol (MANDATORY): emit exactly one fenced block and nothing after the closing fence:",
      "```orca:action",
      '{ ...the scoring JSON object... }',
      "```",
    ].join("\n"),
    userPrompt: JSON.stringify({
      goal: {
        id: input.goal.id,
        title: input.goal.title,
        description: input.goal.description,
      },
      step: {
        id: input.stepTpl.id,
        name: input.stepTpl.name,
        instructions: input.stepTpl.instructions,
        outputSchema: input.stepTpl.outputSchema,
      },
      recoveredOutput: input.output,
    }),
  };
}

function resolveShadowAdapterId(goal: GoalRow): ShadowAdapterId {
  const adapterId = goal.orchestrator_provider
    ? adapterIdForProvider(goal.orchestrator_provider)
    : null;
  if (
    adapterId !== "claude-code"
    && adapterId !== "codex"
    && adapterId !== "antigravity"
  ) {
    throw new Error("goal has no shadow adapter");
  }
  return adapterId;
}

function resolvedModeEnablesOneShot(mode: ResolvedMode): boolean {
  return mode.mode === "one_shot" || mode.fallbacks.includes("one_shot");
}

function stepDispatchEnablesOneShot(
  stepDispatch: StepDispatchCapabilities,
  adapterId: string
): boolean {
  try {
    return resolvedModeEnablesOneShot(stepDispatch.resolveMode(adapterId));
  } catch {
    return false;
  }
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
  step_result_json: string | null;
}

export interface RequestNextDecisionOptions {
  bus?: EventBus;
  idFactory?: () => string;
  stepResultByStepRunId?: Record<string, WorkflowStepResult>;
  terminalFinishedAtByStepRunId?: Record<string, string>;
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

function nowWithFirstTimestamp(now: () => string, fixed: string): () => string {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return fixed;
    }
    return now();
  };
}

/** The template step id backing a graph step node (defaults to the node id). */
function gateDestinationStepTemplateId(graph: WorkflowGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node?.stepId ?? nodeId;
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
    private readonly workerTerminate?: (sessionId: string) => Promise<void>,
    private readonly shadowAsk?: ShadowAsk,
    private readonly recoveryPromptComposer: RecoveryScoringPromptComposer =
      composeRecoveryScoringPrompt
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
        "SELECT body FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1"
      )
      .get(stepRun.id) as { body: string } | undefined;
    if (existing) {
      if (stepRun.step_result_json) {
        await this.requestNextDecision(db, now, stepRun.workflow_run_id, options).catch(() => {});
        return;
      }
      const run = getWorkflowRunById(db, stepRun.workflow_run_id);
      if (!run || run.status !== "active") return;
      const finishedAt = now();
      const stepResult = this.replayEvaluationFailedResult(db, stepRun, finishedAt);
      await this.requestNextDecision(
        db,
        nowWithFirstTimestamp(now, finishedAt),
        stepRun.workflow_run_id,
        {
          ...options,
          stepResultByStepRunId: {
            ...options.stepResultByStepRunId,
            [stepRun.id]: stepResult,
          },
          terminalFinishedAtByStepRunId: {
            ...options.terminalFinishedAtByStepRunId,
            [stepRun.id]: finishedAt,
          },
        }
      ).catch(() => {});
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
    const synthesisAdapterId = resolveShadowAdapterId(goal);
    const synthesisUsesShadow =
      this.shadowAsk
      && this.stepDispatch
      && !stepDispatchEnablesOneShot(this.stepDispatch, synthesisAdapterId);

    // (8) Parse-then-synthesize.
    const result = await synthesizeStepOutput(
      {
        broker: this.broker,
        shadowAsk: synthesisUsesShadow ? this.shadowAsk : undefined,
      },
      {
        goalId: goal.id,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        providerId: provider,
        modelId: model,
        adapterId: synthesisUsesShadow ? synthesisAdapterId : undefined,
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
    const finishedAt = now();
    const facts = this.scoringFacts(db, stepRun, "passed", finishedAt);
    const adapterId = resolveShadowAdapterId(goal);
    let shadowOnly = false;
    try {
      shadowOnly =
        this.stepDispatch?.resolveMode(adapterId).mode === "shadow_session";
    } catch {
      // Missing execution-mode configuration must not block advancement.
    }
    const stepResult = this.shadowAsk && shadowOnly
      ? await recoverStepScoring(this.shadowAsk, {
          goalId: goal.id,
          adapterId,
          timeoutMs: SHADOW_LLM_TIMEOUT_MS,
          facts,
          prompt: this.recoveryPromptComposer({
            stepTpl,
            goal,
            output: result.output,
          }),
          startedAt: stepRun.started_at,
          finishedAt,
        })
      : buildEvaluationFailedStepResult({
          stepId: stepRun.id,
          stepStatus: facts.stepStatus,
          startedAt: stepRun.started_at,
          finishedAt,
          retries: facts.performance.retries,
          producedArtifactsCount: facts.outcome.producedArtifactsCount,
          blockingIssuesCount: facts.outcome.blockingIssuesCount,
          warningsCount: facts.outcome.warningsCount,
          reason: "no shadow session available for recovery scoring",
        });
    await this.requestNextDecision(db, nowWithFirstTimestamp(now, finishedAt), run.id, {
      ...options,
      stepResultByStepRunId: {
        ...options.stepResultByStepRunId,
        [stepRun.id]: stepResult,
      },
      terminalFinishedAtByStepRunId: {
        ...options.terminalFinishedAtByStepRunId,
        [stepRun.id]: finishedAt,
      },
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
        // If this step is paused at a confirmation checkpoint, the user is refining:
        // record the divergence signal, clear the stash, and resume the activity.
        const refineStashRow = db
          .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
          .get(ctx.stepRun.id) as { pending_completion_json: string | null } | undefined;
        if (refineStashRow?.pending_completion_json) {
          try {
            const stash = JSON.parse(refineStashRow.pending_completion_json) as {
              scoring: import("@orca/contracts").StepResultScoringProposal | null;
            };
            if (stash.scoring) {
              recordRevisionSignal(db, {
                id: randomUUID(),
                stepRunId: ctx.stepRun.id,
                goalId: ctx.run.goalId,
                supersededScoring: stash.scoring,
                feedbackText: action.translated.slice(0, 4000),
                now: now(),
              });
            }
          } catch {
            // signal capture must never block refinement
          }
          db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(
            ctx.stepRun.id
          );
          resumeFromConfirmation({ db, bus: options.bus ?? new EventBus() }, { stepRunId: ctx.stepRun.id });
        }
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
        const finishedAt = now();

        if (getSupervisionMode(db) === "supervised") {
          const scoringParse = StepResultScoringProposal.safeParse(action.scoring);
          const scoring = scoringParse.success ? scoringParse.data : undefined;
          db.prepare(
            "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
          ).run(
            JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt }),
            ctx.stepRun.id
          );
          const summary = summarizeScoring(scoring);
          const activityCtx = { db, bus: options.bus ?? new EventBus() };
          openOrUpdateLive(activityCtx, {
            goalId: ctx.run.goalId,
            workflowRunId: ctx.run.id,
            stepRunId: ctx.stepRun.id,
            agentSessionId: sessionId,
            sourceKind: "step_started",
            currentText: summary,
            workCategory: null,
          });
          pauseForConfirmation(activityCtx, { stepRunId: ctx.stepRun.id, summary });
          return { postedChatReply: false };
        }

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
        const stepResult = this.buildApprovalStepResult(db, ctx, action.scoring, finishedAt);
        await this.advanceToNextStep(db, nowWithFirstTimestamp(now, finishedAt), ctx.run.id, {
          ...options,
          stepResultByStepRunId: {
            ...options.stepResultByStepRunId,
            [ctx.stepRun.id]: stepResult,
          },
          terminalFinishedAtByStepRunId: {
            ...options.terminalFinishedAtByStepRunId,
            [ctx.stepRun.id]: finishedAt,
          },
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
   * Builds a user-facing acknowledgment, when needed, for a
   * user_message-triggered action that did not itself post a chat reply.
   * `sessionId` is null when no live agent session exists for the current step
   * (e.g. after a daemon restart).
   */
  private acknowledgeUserMessageAction(
    action: OrchestratorAction,
    sessionId: string | null
  ): string {
    switch (action.kind) {
      case "forward_to_agent":
        return sessionId
          ? ""
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
    // Some actions need a durable acknowledgment after applying their side effect.
    if (!postedChatReply) {
      const acknowledgment = this.acknowledgeUserMessageAction(action, sessionId);
      if (acknowledgment) {
        this.postOrchestratorMessage(
          db, now, run.goalId, acknowledgment, options
        );
      }
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
   * User "Continue" action for a supervised step held at a confirmation
   * checkpoint. Loads the pending_completion_json stash, runs the same terminal
   * tail as the unsupervised path (write artifact, terminate worker, build scored
   * result, advance), and clears the stash. Idempotent no-op when no stash exists.
   */
  async confirmStep(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return;
    const stepRun = readStepRun(db, run.currentStepRunId);
    const stashRow = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(stepRun.id) as { pending_completion_json: string | null } | undefined;
    if (!stashRow?.pending_completion_json) return; // idempotent no-op

    let stash: { block: unknown; scoring: StepResultScoringProposal | null; finishedAt: string };
    try {
      stash = JSON.parse(stashRow.pending_completion_json);
    } catch {
      db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(stepRun.id);
      return;
    }

    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, run.goalId);
    const ctx = { run, stepRun, stepTpl, template, goal };

    // Clear the stash first so a racing refine/confirm cannot double-apply.
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(stepRun.id);
    expireConfirmation({ db, bus: options.bus ?? new EventBus() }, { stepRunId: stepRun.id });

    const stagedEvents: DomainEvent[] = [];
    this.createStepOutputArtifact(db, now, ctx, JSON.stringify(stash.block ?? {}), options, stagedEvents);
    this.publish(options.bus, stagedEvents);

    const sessionRow = db
      .prepare("SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1")
      .get(stepRun.id) as { id: string } | undefined;
    if (sessionRow?.id) void this.workerTerminate?.(sessionRow.id);

    const stepResult = this.buildApprovalStepResult(db, ctx, stash.scoring ?? undefined, stash.finishedAt);
    await this.advanceToNextStep(db, nowWithFirstTimestamp(now, stash.finishedAt), run.id, {
      ...options,
      stepResultByStepRunId: { ...options.stepResultByStepRunId, [stepRun.id]: stepResult },
      terminalFinishedAtByStepRunId: { ...options.terminalFinishedAtByStepRunId, [stepRun.id]: stash.finishedAt },
    });
  }

  /**
   * Continues all workflow runs currently paused at a supervised confirmation
   * checkpoint. Called when supervision mode switches to "unsupervised" so that
   * any held steps are immediately advanced without waiting for user confirmation.
   * Delegates to confirmStep for each paused run.
   */
  async continueAllPausedSteps(
    db: Database.Database,
    now: () => string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const paused = db
      .prepare(
        `SELECT wr.id AS run_id
         FROM workflow_runs wr
         JOIN workflow_step_runs sr ON sr.id = wr.current_step_run_id
         WHERE sr.pending_completion_json IS NOT NULL`
      )
      .all() as { run_id: string }[];
    for (const p of paused) {
      await this.confirmStep(db, now, p.run_id, options);
    }

    // Runs parked at a gate confirmation checkpoint also resume.
    const pausedGates = db
      .prepare("SELECT id AS run_id FROM workflow_runs WHERE pending_gate_route_json IS NOT NULL")
      .all() as { run_id: string }[];
    for (const p of pausedGates) {
      await this.confirmGate(db, now, p.run_id, options);
    }
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
    if (this.stepDispatch) {
      const adapterId = adapterIdForProvider(sel.selectedProviderId);
      if (!stepDispatchEnablesOneShot(this.stepDispatch, adapterId)) {
        return this.blockRun(
          db,
          now,
          ctx,
          "direct model operator disabled for shadow-only adapter",
          options
        );
      }
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
    const finishedAt = now();
    const stepResult = await this.scoreCompletedStepResult(
      db,
      ctx,
      proposal.output,
      finishedAt
    );
    return this.commitAdvanceOrComplete(
      db,
      nowWithFirstTimestamp(now, finishedAt),
      ctx,
      {
        ...options,
        stepResultByStepRunId: {
          ...options.stepResultByStepRunId,
          [stepRun.id]: stepResult,
        },
        terminalFinishedAtByStepRunId: {
          ...options.terminalFinishedAtByStepRunId,
          [stepRun.id]: finishedAt,
        },
      }
    );
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

  /**
   * Builds the terminal step result for a normal approval. Scoring is owned by
   * the shadow orchestrator and arrives on the approve_step_complete action;
   * the daemon owns the measured facts. Missing or invalid scoring yields a
   * non-blocking evaluation-failure result.
   */
  private buildApprovalStepResult(
    db: Database.Database,
    ctx: { stepRun: StepRunRow },
    scoring: unknown,
    finishedAt: string
  ): WorkflowStepResult {
    const facts = this.scoringFacts(db, ctx.stepRun, "passed", finishedAt);
    const proposal = StepResultScoringProposal.safeParse(scoring);
    if (proposal.success) {
      return buildScoredStepResult(facts, proposal.data);
    }
    if (scoring !== undefined) {
      // Field paths + codes only (never values) so a rejected score is debuggable
      // without leaking model-authored content into the logs.
      console.warn("[scoring] approval scoring rejected", {
        stepRunId: ctx.stepRun.id,
        issues: proposal.error.issues.map((i) => `${i.path.join(".")}:${i.code}`),
      });
    }
    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: scoring === undefined ? "approval omitted scoring proposal" : "invalid step result scoring proposal",
    });
  }

  /**
   * Replay/reconciliation: step_output already exists but step_result_json is
   * null (crash between artifact write and result persistence). There is no
   * live approval turn or worker session to score against, so we write a
   * deterministic evaluation-failure result from measured facts — no model call.
   */
  private replayEvaluationFailedResult(
    db: Database.Database,
    stepRun: StepRunRow,
    finishedAt: string
  ): WorkflowStepResult {
    const facts = this.scoringFacts(db, stepRun, "passed", finishedAt);
    return buildEvaluationFailedStepResult({
      stepId: stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: "result recovered on replay without live scoring",
    });
  }

  private async scoreCompletedStepResult(
    db: Database.Database,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    output: Record<string, unknown> | null,
    finishedAt: string
  ): Promise<WorkflowStepResult> {
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

    let result;
    try {
      result = await scoreStepResult(
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
    } catch (err) {
      return buildEvaluationFailedStepResult({
        stepId: ctx.stepRun.id,
        stepStatus: facts.stepStatus,
        startedAt: ctx.stepRun.started_at,
        finishedAt,
        retries: facts.performance.retries,
        producedArtifactsCount: facts.outcome.producedArtifactsCount,
        blockingIssuesCount: facts.outcome.blockingIssuesCount,
        warningsCount: facts.outcome.warningsCount,
        reason: err instanceof Error ? err.message : "step result scoring threw",
      });
    }

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
    const graph = effectiveGraph(template.graph, template.steps);
    const dest = resolveStepNext(graph, stepRun.step_template_id);

    if (dest.kind !== "terminal") {
      const stagedEvents: DomainEvent[] = [];
      const terminalFinishedAt = options.terminalFinishedAtByStepRunId?.[stepRun.id];
      const advanceNow = terminalFinishedAt
        ? nowWithFirstTimestamp(now, terminalFinishedAt)
        : now;
      const result = advanceToNextStepOrGate(
        db,
        advanceNow,
        stepRun.id,
        {
          idFactory: options.idFactory,
          stagedEvents,
          ...(options.bus
            ? {
                activityCtx: {
                  db,
                  bus: options.bus,
                  now,
                  idFactory: options.idFactory,
                },
              }
            : {}),
        },
        options.stepResultByStepRunId?.[stepRun.id]
      );
      this.publish(options.bus, stagedEvents);

      if (result.kind === "gate") {
        const sourceStepOutput = this.readStepOutputAsRecord(db, run.id, stepRun.id);
        await this.evaluateAndRouteGate(
          db,
          now,
          { run, stepRun, stepTpl, template, goal, gateNodeId: result.nodeId, sourceStepOutput },
          options
        );
        // A missing gate or failed evaluation blocks the run; do not recurse.
        // A supervised gate pause leaves the run active but parked on the gate
        // (current_step_run_id = NULL) awaiting Continue; do not recurse there
        // either (the Continue/confirmGate path resumes routing).
        const after = getWorkflowRunById(db, run.id);
        if (!after || after.status !== "active" || !after.currentStepRunId) {
          return this.commitNoopLatestDecision(db, run.id, stepRun.id);
        }
      }

      // recursion depth is bounded by the number of consecutive auto-completing intermediate steps (template step count).
      return this.requestNextDecision(db, now, run.id, options);
    }

    const stagedEvents: DomainEvent[] = [];
    const output = db.transaction(() => {
      const stepResult = options.stepResultByStepRunId?.[stepRun.id];
      if (stepResult) {
        const terminalFinishedAt =
          options.terminalFinishedAtByStepRunId?.[stepRun.id] ?? now();
        db.prepare(
          "UPDATE workflow_step_runs SET finished_at = ?, step_result_json = ? WHERE id = ?"
        ).run(terminalFinishedAt, JSON.stringify(stepResult), stepRun.id);
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
    if (options.bus && options.stepResultByStepRunId?.[stepRun.id]) {
      try {
        materializeStepResultActivity(
          {
            db,
            bus: options.bus,
            now,
            idFactory: options.idFactory,
          },
          {
            goalId: goal.id,
            workflowRunId: run.id,
            stepRunId: stepRun.id,
          }
        );
      } catch (error) {
        console.error("[activity] step result materialization failed", {
          stepRunId: stepRun.id,
          error,
        });
      }
    }
    return output;
  }

  /**
   * Reads the step_output artifact body for a step run and parses it as an
   * object, stripping the reserved `_completion` envelope. Returns null when no
   * step_output exists or it is not a JSON object — that's the contract the gate
   * evaluation request expects for `sourceStepOutput`.
   */
  private readStepOutputAsRecord(
    db: Database.Database,
    runId: string,
    stepRunId: string
  ): Record<string, unknown> | null {
    const row = db
      .prepare(
        "SELECT body FROM workflow_artifacts WHERE workflow_run_id = ? AND step_run_id = ? AND type = 'step_output' LIMIT 1"
      )
      .get(runId, stepRunId) as { body: string } | undefined;
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { _completion: _omit, ...rest } = parsed as Record<string, unknown>;
    return rest;
  }

  /**
   * The run cursor is parked at a gate (current_node_kind='gate'). Evaluates the
   * gate via the orchestrator broker, records the decision + traversal_seq, and
   * moves the cursor to the resolved destination. A gate destination recurses;
   * a step destination inserts a fresh attempt of that step (its agent is then
   * selected/spawned by the requestNextDecision recursion of the caller).
   */
  private async evaluateAndRouteGate(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      gateNodeId: string;
      sourceStepOutput: Record<string, unknown> | null;
    },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, stepRun, stepTpl, template, goal, gateNodeId, sourceStepOutput } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const gateNode = graph.nodes.find((n) => n.id === gateNodeId && n.type === "gate");
    if (!gateNode) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `gate node not found in graph: ${gateNodeId}`,
        options
      );
      return;
    }

    if (!goal.orchestrator_provider || !goal.orchestrator_model) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        "gate evaluation failed: orchestrator model not configured",
        options
      );
      return;
    }

    const evaluation = await evaluateGate(
      { broker: this.broker },
      {
        goalId: goal.id,
        workflowRunId: run.id,
        providerId: goal.orchestrator_provider,
        modelId: goal.orchestrator_model,
        goal: { id: goal.id, description: goal.description },
        gate: {
          nodeId: gateNode.id,
          name: gateNode.name,
          instructions: gateNode.instructions ?? gateNode.condition ?? "",
        },
        sourceStepOutput,
        priorGateDecisions: listGateDecisionsForRun(db, run.id).map((d) => ({
          nodeId: d.nodeId,
          outcome: d.outcome,
          reason: d.reason,
        })),
        availableOutcomes: ["approved", "rejected"],
      }
    );

    if (!evaluation.ok) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `gate evaluation failed: ${evaluation.reason}`,
        options
      );
      return;
    }

    const dest = resolveGateNext(graph, gateNode.id, evaluation.decision.outcome);
    const seq = nextTraversalSeq(db, run.id);
    recordGateDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: gateNode.id,
      traversalSeq: seq,
      outcome: evaluation.decision.outcome,
      reason: evaluation.decision.reason,
      selectedEdgeTo: dest.kind === "terminal" ? "" : dest.nodeId,
      inputsConsidered: evaluation.decision.inputsConsidered,
      issueRefs: evaluation.decision.issueRefs,
    });

    if (dest.kind !== "step" && dest.kind !== "gate") {
      // resolveGateNext only ever classifies edges to step/gate nodes; a terminal
      // destination is unreachable. Guard defensively so the run never stalls.
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `gate ${gateNode.id} resolved to an unroutable destination`,
        options
      );
      return;
    }

    // Supervised mode: pause for user confirmation BEFORE routing to the
    // destination. The decision is already recorded (and deduped by
    // traversal_seq); we stash the deferred route and park a confirmation
    // activity on the source step. The Continue action (confirmGate) consumes
    // the stash and performs the deferred route exactly once.
    if (getSupervisionMode(db) === "supervised") {
      const summary = `Gate "${gateNode.name}" ${evaluation.decision.outcome}: ${evaluation.decision.reason}`;
      const stagedEvents: DomainEvent[] = [];
      db.transaction(() => {
        db.prepare("UPDATE workflow_runs SET pending_gate_route_json = ? WHERE id = ?").run(
          JSON.stringify({
            gateNodeId: gateNode.id,
            outcome: evaluation.decision.outcome,
            destNodeId: dest.nodeId,
            destKind: dest.kind,
            traversalSeq: seq,
            sourceStepRunId: stepRun.id,
          }),
          run.id
        );
        // Record an evaluate_gate decision so the caller has a trace to return
        // while the run is parked awaiting Continue.
        recordDecisionInTx(
          db,
          now,
          {
            goalId: goal.id,
            workflowRunId: run.id,
            stepRunId: stepRun.id,
            decisionType: "evaluate_gate",
            selectedAction: `gate:${evaluation.decision.outcome}:await_confirmation`,
            reason: evaluation.decision.reason,
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
              decisionType: "evaluate_gate",
              payload: `${gateNode.id}:${seq}`,
            }),
          },
          { idFactory: options.idFactory, stagedEvents }
        );
      })();
      this.publish(options.bus, stagedEvents);
      const activityCtx = { db, bus: options.bus ?? new EventBus() };
      openOrUpdateLive(activityCtx, {
        goalId: goal.id,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        agentSessionId: null,
        sourceKind: "step_started",
        currentText: summary,
        workCategory: null,
      });
      pauseForConfirmation(activityCtx, { stepRunId: stepRun.id, summary });
      return;
    }

    await this.routeGateDestination(
      db,
      now,
      { run, template, goal, sourceStepRunId: stepRun.id },
      { kind: dest.kind, nodeId: dest.nodeId },
      options
    );
  }

  /**
   * Performs the deferred destination route for an already-evaluated gate (the
   * decision is recorded + deduped by traversal_seq). A gate destination moves
   * the cursor and recurses into evaluateAndRouteGate; a step destination
   * inserts a fresh attempt (its agent is selected/spawned by the caller's
   * requestNextDecision recursion). Shared by the unsupervised inline path and
   * the supervised Continue (confirmGate) path so routing lives in one place.
   */
  private async routeGateDestination(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      template: WorkflowTemplateT;
      goal: GoalRow;
      sourceStepRunId: string;
    },
    dest: { kind: "step" | "gate"; nodeId: string },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, template, goal, sourceStepRunId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);

    if (dest.kind === "gate") {
      db.prepare(
        "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'gate' WHERE id = ?"
      ).run(dest.nodeId, run.id);
      // Re-read the source step so the recursion has a fresh ctx; the cursor
      // remains parked on the new gate until that evaluation resolves.
      const stepRun = readStepRun(db, sourceStepRunId);
      const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
      if (!stepTpl) {
        this.blockRun(
          db,
          now,
          { run, stepRun, stepTpl: template.steps[0]!, goal },
          `source step template not found: ${stepRun.step_template_id}`,
          options
        );
        return;
      }
      const sourceStepOutput = this.readStepOutputAsRecord(db, run.id, stepRun.id);
      await this.evaluateAndRouteGate(
        db,
        now,
        { run, stepRun, stepTpl, template, goal, gateNodeId: dest.nodeId, sourceStepOutput },
        options
      );
      return;
    }

    // dest.kind === "step": insert a fresh attempt of the destination step. Its
    // agent is selected/spawned by the caller's requestNextDecision recursion.
    const destStepTemplateId = gateDestinationStepTemplateId(graph, dest.nodeId);
    const destStepTpl = template.steps.find((s) => s.id === destStepTemplateId);
    const ordinal = destStepTpl?.ordinal ?? 0;
    const attempt = nextAttemptForStep(db, run.id, destStepTemplateId);
    const stagedEvents: DomainEvent[] = [];
    insertStepForRouting(
      db,
      now,
      goal.id,
      run.id,
      destStepTemplateId,
      ordinal,
      attempt,
      dest.nodeId,
      {
        idFactory: options.idFactory,
        stagedEvents,
        ...(options.bus
          ? { activityCtx: { db, bus: options.bus, now, idFactory: options.idFactory } }
          : {}),
      }
    );
    this.publish(options.bus, stagedEvents);
  }

  /**
   * User "Continue" action for a supervised gate decision held at a confirmation
   * checkpoint. Reads + clears pending_gate_route_json, expires the confirmation
   * activity, then performs the deferred route. Idempotent: a null/consumed stash
   * is a no-op so a double-Continue cannot double-route. The gate is NOT
   * re-evaluated — the decision is already recorded and deduped by traversal_seq.
   */
  async confirmGate(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) return;
    const stashRow = db
      .prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { pending_gate_route_json: string | null } | undefined;
    if (!stashRow?.pending_gate_route_json) return; // idempotent no-op

    let stash: {
      gateNodeId: string;
      outcome: string;
      destNodeId: string;
      destKind: "step" | "gate";
      traversalSeq: number;
      sourceStepRunId: string;
    };
    try {
      stash = JSON.parse(stashRow.pending_gate_route_json);
    } catch {
      db.prepare("UPDATE workflow_runs SET pending_gate_route_json = NULL WHERE id = ?").run(runId);
      return;
    }

    const template = getTemplateById(db, run.templateId);
    if (!template) return;
    const goal = readGoal(db, run.goalId);

    // Clear the stash first so a racing Continue cannot double-route.
    db.prepare("UPDATE workflow_runs SET pending_gate_route_json = NULL WHERE id = ?").run(runId);
    expireConfirmation(
      { db, bus: options.bus ?? new EventBus() },
      { stepRunId: stash.sourceStepRunId }
    );

    await this.routeGateDestination(
      db,
      now,
      { run, template, goal, sourceStepRunId: stash.sourceStepRunId },
      { kind: stash.destKind, nodeId: stash.destNodeId },
      options
    );

    // If the destination is a step, deterministically select/spawn its agent
    // (mirrors the requestNextDecision recursion the unsupervised inline path
    // relies on). A gate destination re-pauses inside routeGateDestination.
    const after = getWorkflowRunById(db, runId);
    if (after && after.status === "active" && after.currentStepRunId) {
      await this.requestNextDecision(db, now, runId, options);
    }
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
