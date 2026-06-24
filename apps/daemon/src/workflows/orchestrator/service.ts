import type Database from "better-sqlite3";
import {
  AdapterId,
  InterviewTurn,
  LedgerUpdate,
  OrchestrationRequest,
  ProviderRecoveryCheckpoint,
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  SplitEvaluationProposal,
  SplitEvaluationRequest,
  StepResultScoringProposal,
  StepSkillProposal,
  validateStepOutput,
  type DomainEvent,
  type ModelProviderId,
  type OperatorDescriptor,
  type OrchestratorAction,
  type PendingQuestion as PendingQuestionT,
  type StepResultScoringFacts,
  type StepAgentChoice,
  type WorkflowDecisionTrace,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepResult,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowStepTemplate,
  type WorkflowTemplate as WorkflowTemplateT,
  type TelemetryFacet,
  type CostEntry,
  type TransitionStatus,
  type FailureCode,
} from "@orca/contracts";
import { computeCost } from "../../harness-telemetry/cost.js";

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
import { effectiveGraph, resolveGateNext, resolveSplitterNext, resolveStepNext, type Destination } from "../graph/graph-routing.js";
import { nextTraversalSeq, recordGateDecision } from "../gates/usecases.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { recordSplitDecision } from "../splitters/usecases.js";
import { listSplitDecisionsForRun } from "../splitters/projection.js";
import { loadRunTemplate } from "../runs/run-template.js";
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
import { listRecentFeedbackByGoal } from "../../recommendations/feedback.js";
import { decodeSessionTail, decodeSessionTailFromSeq } from "./session-tail.js";
import { synthesizeStepOutput } from "./synthesize.js";
import { detectPendingAgentQuestion } from "./agent-interview.js";
import { assembleWorkspaceContext } from "./workspace-context.js";
import { listWorkspacesByGoal } from "../../workspaces/projection.js";
import { listMemoryByGoal } from "../../memory/projection.js";
import { listDecisionsByGoal } from "../../decisions/projection.js";
import { getGoalRefinement } from "../../goal-refinements.js";
import { deriveReadSet } from "../../harness-state/read-set.js";
import { recordHarnessTransition } from "../../harness-transitions/usecases.js";
import { runSensors } from "../../harness-sensors/runner.js";
import { stepRequiresExecution } from "./requires-execution.js";
import { resolveStepDispatch, type ResolvedStepDispatch } from "./step-dispatch.js";
import { composeAgentInitialPrompt } from "../../orchestrator-llm/prompts.js";
import { judgeAgentResponse } from "./judgement.js";
import { extractOrcaStepCompleteBlock, parseStepCompletionEnvelope } from "./orca-output.js";
import { commitLedgerVersion } from "../ledger/usecases.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import { reviewAndNormalizeLedgerUpdates } from "../ledger/review.js";
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
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import { resolveShadowProvider } from "../../orchestrator-llm/providers/registry.js";
import { listAgents } from "../../agents.js";
import { buildProviderRecoveryChoices, composeProviderSwitchPrompt } from "./provider-recovery.js";
import {
  recoverStepScoring,
  type ShadowAsk,
} from "./recover-step-scoring.js";
import { materializeStepResultActivity } from "../../activities/step-result-activity.js";
import { interruptLive, expireConfirmation, openOrUpdateLive, pauseForConfirmation, pauseForGateDecision, pauseForProviderRecovery, resolveGateDecisionActivity, resumeFromConfirmation, resumeFromProviderRecovery } from "../../activities/store.js";
import { setSessionStatus } from "../../sessions/projection.js";
import { recordRevisionSignal } from "../revision-signals/store.js";
import { extractProposal, summarizeScoring } from "./scoring-summary.js";

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
  pending_provider_recovery_json: string | null;
  pending_judge_json: string | null;
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

/**
 * Raised when a provider-recovery checkpoint cannot be loaded for an action:
 * the run/step is no longer active, the current step no longer matches the
 * checkpoint, the checkpoint is missing/unparseable, the checkpoint ID does not
 * match, or the limited session no longer belongs to the step. Task 6's HTTP
 * routes map this to a 404/409 response.
 */
export class OrchestratorProviderRecoveryNotFoundError extends Error {
  readonly code = "provider_recovery_not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrchestratorProviderRecoveryNotFoundError";
  }
}

/**
 * Raised when a recovery action is not allowed in the checkpoint's current mode
 * (e.g. Retry while still `choose`, any action while `retrying`/`switching`, or
 * a preserved-session Retry before a known future reset time). Task 6's HTTP
 * routes map this to a 409 response.
 */
export class OrchestratorProviderRecoveryInvalidTransitionError extends Error {
  readonly code = "provider_recovery_invalid_transition" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrchestratorProviderRecoveryInvalidTransitionError";
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

function goalRequiresHumanReview(db: Database.Database, goalId: string): boolean {
  const row = db.prepare("SELECT operating_mode FROM goals WHERE id = ?").get(goalId) as { operating_mode: string } | undefined;
  // Fail-safe: unknown goal → require human review.
  return (row?.operating_mode ?? "human_review") === "human_review";
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

/** Clamps a display string to a schema char limit, marking truncation with an
 *  ellipsis so the cutoff is visible. Returns the input unchanged when it fits. */
function clampToLimit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

// Drain-only view of the OTLP SessionCostAccumulator (Task 5). Drains and clears
// a session's accrued worker tokens; returns null when nothing accrued.
interface TokenAccumulator {
  drain(sessionId: string): {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    usd: number | null; // authoritative provider cost (Claude); null when none carried (Codex)
    durationMs: number | null; // provider-reported model time; null when none carried (Codex)
    model?: string;
  } | null;
}

const NULL_ACCUMULATOR: TokenAccumulator = { drain: () => null };

/**
 * Builds the TelemetryFacet for a step_complete transition: drains the session's
 * accrued worker tokens into a CostEntry (null when nothing accrued or model is
 * unpriced/unknown) and records the categorical outcome.
 */
function buildTelemetry(
  acc: TokenAccumulator | undefined,
  sessionId: string | null | undefined,
  status: TransitionStatus,
  failureCode: FailureCode | null,
  latencyMs: number | null,
  humanInterventions: TelemetryFacet["human_interventions"] = []
): TelemetryFacet {
  const drained = acc && sessionId ? acc.drain(sessionId) : null;
  // Prefer the authoritative provider cost (Claude emits it; it already prices
  // cache). When absent (Codex) fall back to the price-map estimate over
  // input+output tokens — that estimate does NOT yet price Codex's cache.
  // cost null only when nothing drained, or when there's no model to price AND
  // no authoritative usd was emitted.
  let cost: CostEntry | null = null;
  if (drained && (drained.model || drained.usd != null)) {
    const usd =
      drained.usd != null
        ? drained.usd
        : computeCost(drained.model!, drained.tokensIn, drained.tokensOut).usd;
    cost = {
      tokens_in: drained.tokensIn,
      tokens_out: drained.tokensOut,
      cache_read_tokens: drained.cacheReadTokens,
      cache_creation_tokens: drained.cacheCreationTokens,
      usd,
    };
  }
  return {
    cost,
    latency_ms: drained?.durationMs ?? latencyMs,
    model: drained?.model ?? null,
    provider_id: null,
    provider_version: null,
    prompt_ref: null,
    raw_output_ref: null,
    rejected_alternatives: [],
    human_interventions: humanInterventions,
    outcome: { status, failure_code: failureCode },
  };
}

/**
 * Reads a goal's recent recommendation feedback (bounded to the existing MAX 10)
 * and maps each row to a `recommendation_feedback` human-intervention entry. This
 * revives the previously-dead feedback by surfacing it on the inspectable
 * step_complete transition.
 */
function recommendationFeedbackInterventions(
  db: Database.Database,
  goalId: string
): TelemetryFacet["human_interventions"] {
  return listRecentFeedbackByGoal(db, goalId).map((f) => ({
    kind: "recommendation_feedback",
    ref: f.id,
  }));
}

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
      composeRecoveryScoringPrompt,
    // Drives a provider's terminal "wait for limit reset" interaction against the
    // worker's live tmux session (preserved-session Wait/Retry).
    private readonly workerWait?: (sessionId: string, adapterId: string) => Promise<void>,
    // Interrupts the worker's current turn (sends Escape) so the user can course-correct.
    private readonly workerInterrupt?: (sessionId: string) => Promise<void>,
    // Drains accrued OTEL worker tokens for a session when a step_complete
    // transition is recorded, so the TelemetryFacet carries real cost. Defaults
    // to a no-op (drain → null) so transitions get `cost: null`.
    private readonly otlpAccumulator: TokenAccumulator = NULL_ACCUMULATOR
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
    const template = loadRunTemplate(db, run);
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
      .prepare("SELECT workflow_step_run_id, adapter_id, status FROM sessions WHERE id = ?")
      .get(args.sessionId) as
      | { workflow_step_run_id: string | null; adapter_id: string; status: string }
      | undefined;
    if (!sess?.workflow_step_run_id) return;
    if (sess.status !== "running" && sess.status !== "starting") return;

    // (2) Load step run; skip if not active.
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(sess.workflow_step_run_id) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") return;

    // (3) Decode the full tail; provider terminal/turn parsing happens below.
    const tail = decodeSessionTail(this.sessionOutputStore.readTail(args.sessionId));
    const provider = resolveShadowProvider(sess.adapter_id as ShadowAdapterId);
    const bus = options.bus ?? new EventBus();
    const activityCtx = { db, bus, now, idFactory: options.idFactory };

    // Helpers to persist/clear the step's recovery checkpoint.
    const updateCheckpoint = (next: ProviderRecoveryCheckpoint): void => {
      db.prepare(
        "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
      ).run(JSON.stringify(ProviderRecoveryCheckpoint.parse(next)), stepRun.id);
    };
    const clearCheckpoint = (): void => {
      db.prepare(
        "UPDATE workflow_step_runs SET pending_provider_recovery_json = NULL WHERE id = ?"
      ).run(stepRun.id);
    };

    // (4) Parse any existing recovery checkpoint up front so we can branch on its mode.
    const checkpoint = stepRun.pending_provider_recovery_json
      ? ProviderRecoveryCheckpoint.parse(JSON.parse(stepRun.pending_provider_recovery_json))
      : null;

    // (5) Drive in-flight retry progress (preserved or fresh session).
    if (checkpoint?.mode === "retrying") {
      const recoverySessionId =
        checkpoint.retryKind === "preserved_session"
          ? checkpoint.currentSessionId
          : checkpoint.replacementSessionId;
      const firstSeq =
        checkpoint.retryKind === "preserved_session"
          ? checkpoint.retryOutputSeq
          : checkpoint.replacementOutputSeq;
      if (!recoverySessionId || args.sessionId !== recoverySessionId || firstSeq === null) return;
      const snapshot = this.sessionOutputStore.readTail(args.sessionId);
      if (snapshot.nextSeq <= firstSeq) return;
      const retryTail = decodeSessionTailFromSeq(snapshot, firstSeq) || decodeSessionTail(snapshot);
      const retryFailure = provider.turnParser().detectError?.(retryTail, new Date(now()));
      if (retryFailure) {
        updateCheckpoint({
          ...checkpoint,
          mode: "waiting",
          message: retryFailure.message,
          resetTimeText: retryFailure.resetTimeText,
          resetAt: retryFailure.resetAt,
          timezone: retryFailure.timezone,
          detectedAt: now(),
          retryOutputSeq: null,
          replacementSessionId: null,
          replacementOutputSeq: null,
        });
        return;
      }
      if (provider.turnParser().detectTurnStarted?.(retryTail)) {
        if (checkpoint.retryKind === "preserved_session" && checkpoint.pendingGuidance.length > 0) {
          const guidance = checkpoint.pendingGuidance.join("\n\n");
          const delivered = await this.workerDeliver?.(recoverySessionId, guidance);
          if (delivered !== "delivered") {
            // Bounce back to waiting so the operator can Retry/Switch again;
            // staying in retrying would leave the card busy and the run stuck.
            updateCheckpoint({
              ...checkpoint,
              mode: "waiting",
              retryOutputSeq: null,
              lastError: "The provider resumed, but pending guidance could not be delivered.",
            });
            return;
          }
        }
        clearCheckpoint();
        resumeFromProviderRecovery(activityCtx, {
          stepRunId: stepRun.id,
          agentSessionId: recoverySessionId,
          summary:
            checkpoint.retryKind === "preserved_session"
              ? `Retrying ${checkpoint.currentProviderName} in the preserved session…`
              : `Continuing ${checkpoint.currentProviderName} in a fresh session…`,
        });
        if (
          checkpoint.retryKind === "fresh_session" &&
          checkpoint.currentSessionId !== recoverySessionId
        ) {
          setSessionStatus(db, checkpoint.currentSessionId, "stopped", {
            failureReason: "provider_session_replaced",
            exitedAt: now(),
          });
          await this.workerTerminate?.(checkpoint.currentSessionId).catch(() => {});
        }
      }
      return;
    }

    // (6) Drive in-flight switch startup against the replacement session.
    if (
      checkpoint?.mode === "switching" &&
      checkpoint.replacementSessionId === args.sessionId &&
      checkpoint.replacementOutputSeq !== null
    ) {
      const snapshot = this.sessionOutputStore.readTail(args.sessionId);
      if (snapshot.nextSeq <= checkpoint.replacementOutputSeq) return;
      const switchTail =
        decodeSessionTailFromSeq(snapshot, checkpoint.replacementOutputSeq) ||
        decodeSessionTail(snapshot);
      const replacementFailure = provider.turnParser().detectError?.(switchTail, new Date(now()));
      if (replacementFailure) {
        setSessionStatus(db, args.sessionId, "failed", {
          failureReason: "provider_recovery_start_failed",
          exitedAt: now(),
        });
        await this.workerTerminate?.(args.sessionId).catch(() => {});
        updateCheckpoint({
          ...checkpoint,
          mode: "choose",
          replacementSessionId: null,
          replacementOutputSeq: null,
          lastError: replacementFailure.message,
        });
        return;
      }
      if (provider.turnParser().detectTurnStarted?.(switchTail)) {
        const choice = checkpoint.choices.find(
          (candidate) => candidate.adapterId === sess.adapter_id && candidate.enabled
        );
        if (!choice?.modelId) return;
        const run = getWorkflowRunById(db, stepRun.workflow_run_id);
        if (!run || run.status !== "active") return;
        const template = loadRunTemplate(db, run);
        if (!template) return;
        const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
        if (!stepTpl) return;
        const goal = readGoal(db, run.goalId);
        const mode = this.stepDispatch!.resolveMode(choice.adapterId);
        this.commitDeterministicStepSelection(
          db,
          now,
          { run, stepRun, stepTpl, template, goal },
          {
            adapterId: choice.adapterId,
            modelId: choice.modelId,
            executionMode: mode.mode,
            fallbackModes: mode.fallbacks,
          },
          options
        );
        clearCheckpoint();
        resumeFromProviderRecovery(activityCtx, {
          stepRunId: stepRun.id,
          agentSessionId: args.sessionId,
          summary: `Continuing with ${choice.displayName}…`,
        });
        setSessionStatus(db, checkpoint.currentSessionId, "stopped", {
          failureReason: "provider_switched",
          exitedAt: now(),
        });
        await this.workerTerminate?.(checkpoint.currentSessionId).catch(() => {});
      }
      return;
    }

    // (7) Scan the tail for a fresh provider terminal screen.
    const providerFailure = provider.turnParser().detectError?.(tail, new Date(now()));
    if (providerFailure) {
      // A checkpoint already exists in choose/waiting: refresh reset details from
      // the newest matching limit frame without creating a duplicate or re-pausing.
      if (checkpoint) {
        if (checkpoint.mode === "choose" || checkpoint.mode === "waiting") {
          updateCheckpoint({
            ...checkpoint,
            message: providerFailure.message,
            resetTimeText: providerFailure.resetTimeText,
            resetAt: providerFailure.resetAt,
            timezone: providerFailure.timezone,
            detectedAt: now(),
          });
        }
        return;
      }

      const run = getWorkflowRunById(db, stepRun.workflow_run_id);
      if (!run || run.status !== "active") return;
      const template = loadRunTemplate(db, run);
      if (!template) return;
      const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
      if (!stepTpl) return;
      const goal = readGoal(db, run.goalId);

      // Build recovery choices over connected, non-current agents only; never
      // probe registered-but-disconnected adapters.
      const connectedAdapterIds = listAgents(db)
        .filter((agent) => agent.connected)
        .map((agent) => agent.id);
      const operatorDescriptors = await this.operators.list(run.goalId, {
        agentIds: connectedAdapterIds,
        includeNonAgents: false,
      });
      const choices = buildProviderRecoveryChoices({
        currentAdapterId: sess.adapter_id,
        connectedAdapterIds,
        stepPreferences: preferencesForGoal(
          stepTpl.agentPreference,
          goal.orchestrator_provider
        ),
        operators: operatorDescriptors,
        supportsModel: (id, mid) => this.stepDispatch?.supportsModel(id, mid) ?? false,
      });

      const newCheckpoint = ProviderRecoveryCheckpoint.parse({
        id: options.idFactory?.() ?? randomUUID(),
        mode: "choose",
        failureCode: providerFailure.code,
        message: providerFailure.message,
        currentSessionId: args.sessionId,
        currentAdapterId: AdapterId.parse(sess.adapter_id),
        currentProviderName: provider.displayName,
        resetTimeText: providerFailure.resetTimeText,
        resetAt: providerFailure.resetAt,
        timezone: providerFailure.timezone,
        detectedAt: new Date(now()).toISOString(),
        retryOutputSeq: null,
        retryKind: "preserved_session",
        replacementSessionId: null,
        replacementOutputSeq: null,
        pendingGuidance: [],
        lastError: null,
        choices,
      });

      db.prepare(
        "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
      ).run(JSON.stringify(newCheckpoint), stepRun.id);

      const summary = providerFailure.resetTimeText
        ? `${provider.displayName} reached its session limit. Available again at ${providerFailure.resetTimeText}.`
        : `${provider.displayName} reached its session limit. Reset time unavailable.`;
      pauseForProviderRecovery(
        { db, bus, now, idFactory: options.idFactory },
        { stepRunId: stepRun.id, summary }
      );
      return;
    }

    // A recovery checkpoint exists but the tail shows neither a new limit nor turn
    // progress yet: do not run normal [orca:ask] handling while recovering.
    if (checkpoint) return;

    // (8) Scan the tail for an explicit user-input sentinel.
    const question = detectPendingAgentQuestion(tail);
    if (!question) return;

    // (5) Idempotency: already an unanswered question outstanding?
    const stepArtifacts = listArtifactsForRun(db, stepRun.workflow_run_id).filter(
      (a) => a.stepRunId === stepRun.id
    );
    if (this.hasActiveUnansweredQuestion(db, stepArtifacts, stepRun.id)) return;

    // (6) Load run, template, step template to call commitUserInputDecision.
    const run = getWorkflowRunById(db, stepRun.workflow_run_id);
    if (!run || run.status !== "active") return;
    const template = loadRunTemplate(db, run);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;

    // (7) Record the decision.
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

  // -------------------------------------------------------------------------
  // Provider recovery actions (wait / retry / refresh / switch).
  // These set exactly the checkpoint mode + fields the committed
  // onSessionOutputChunk recovery branches observe to drive startup progress.
  // -------------------------------------------------------------------------

  /**
   * Validates that a recovery action targets a live, matching checkpoint:
   * run/step active, current step matches the checkpoint step, checkpoint
   * parses, the requested id matches, and the current session still belongs to
   * the step. Throws NotFound for missing/mismatched targets and the
   * invalid-transition error type elsewhere.
   */
  private loadProviderRecoveryContext(
    db: Database.Database,
    runId: string,
    checkpointId: string
  ): {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    template: WorkflowTemplateT;
    goal: GoalRow;
    checkpoint: ProviderRecoveryCheckpoint;
  } {
    const run = getWorkflowRunById(db, runId);
    if (!run) throw new OrchestratorProviderRecoveryNotFoundError(`workflow run not found: ${runId}`);
    if (run.status !== "active" || !run.currentStepRunId) {
      throw new OrchestratorProviderRecoveryNotFoundError(`workflow run not active: ${runId}`);
    }
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") {
      throw new OrchestratorProviderRecoveryNotFoundError(`active step run not found for run: ${runId}`);
    }
    if (!stepRun.pending_provider_recovery_json) {
      throw new OrchestratorProviderRecoveryNotFoundError(`no pending provider recovery for run: ${runId}`);
    }
    let checkpoint: ProviderRecoveryCheckpoint;
    try {
      checkpoint = ProviderRecoveryCheckpoint.parse(
        JSON.parse(stepRun.pending_provider_recovery_json)
      );
    } catch {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `malformed provider recovery checkpoint for run: ${runId}`
      );
    }
    if (checkpoint.id !== checkpointId) {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `provider recovery checkpoint mismatch: ${checkpointId}`
      );
    }
    const template = loadRunTemplate(db, run);
    if (!template) throw new OrchestratorProviderRecoveryNotFoundError(`template not found: ${run.templateId}`);
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorProviderRecoveryNotFoundError(`step template not found: ${stepRun.step_template_id}`);
    const goal = readGoal(db, run.goalId);

    const sessRow = db
      .prepare("SELECT workflow_step_run_id FROM sessions WHERE id = ?")
      .get(checkpoint.currentSessionId) as { workflow_step_run_id: string | null } | undefined;
    if (!sessRow || sessRow.workflow_step_run_id !== stepRun.id) {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `recovery session no longer belongs to the step: ${checkpoint.currentSessionId}`
      );
    }

    return { run, stepRun, stepTpl, template, goal, checkpoint };
  }

  private persistCheckpoint(
    db: Database.Database,
    stepRunId: string,
    next: ProviderRecoveryCheckpoint
  ): void {
    db.prepare(
      "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
    ).run(JSON.stringify(ProviderRecoveryCheckpoint.parse(next)), stepRunId);
  }

  /** choose → waiting; preserves the session and drives the provider wait interaction. */
  async waitForProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    void options;
    const { stepRun, checkpoint } = this.loadProviderRecoveryContext(db, runId, checkpointId);
    if (checkpoint.mode !== "choose") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Wait is only allowed while choosing (mode: ${checkpoint.mode}).`
      );
    }
    this.persistCheckpoint(db, stepRun.id, { ...checkpoint, mode: "waiting", lastError: null });
    try {
      await this.workerWait?.(checkpoint.currentSessionId, checkpoint.currentAdapterId);
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "choose",
        lastError: (err instanceof Error ? err.message : "wait failed").slice(0, 512),
      });
      throw err;
    }
  }

  /**
   * waiting → retrying. Preserved-session: stores the current output_seq and
   * delivers a continue prompt to the same worker. Fresh-session: launches a
   * replacement of the same adapter with bounded handoff context.
   */
  async retryProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const ctx = this.loadProviderRecoveryContext(db, runId, checkpointId);
    const { stepRun, checkpoint } = ctx;
    if (checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Retry is only allowed while waiting (mode: ${checkpoint.mode}).`
      );
    }
    if (
      checkpoint.retryKind === "preserved_session" &&
      checkpoint.resetAt !== null &&
      Date.parse(checkpoint.resetAt) > Date.parse(now())
    ) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Retry is not yet available; the provider resets at ${checkpoint.resetTimeText ?? checkpoint.resetAt}.`
      );
    }

    if (checkpoint.retryKind === "fresh_session") {
      await this.startRecoveryReplacementSession(
        db,
        now,
        ctx,
        checkpoint.currentAdapterId,
        "retrying",
        options
      );
      return;
    }

    const outputSeq = this.sessionOutputStore.readTail(checkpoint.currentSessionId).nextSeq;
    this.persistCheckpoint(db, stepRun.id, {
      ...checkpoint,
      mode: "retrying",
      retryOutputSeq: outputSeq,
      lastError: null,
    });
    try {
      await this.workerDeliver?.(checkpoint.currentSessionId, "Continue the previous step request.");
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "waiting",
        retryOutputSeq: null,
        lastError: (err instanceof Error ? err.message : "retry failed").slice(0, 512),
      });
      throw err;
    }
  }

  /** Rebuilds the switch choices from current readiness, preserving id + mode. */
  async refreshProviderRecovery(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    void options;
    void now;
    const { run, stepRun, stepTpl, goal, checkpoint } = this.loadProviderRecoveryContext(
      db,
      runId,
      checkpointId
    );
    if (checkpoint.mode !== "choose" && checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Refresh is only allowed while choosing or waiting (mode: ${checkpoint.mode}).`
      );
    }
    const connectedAdapterIds = listAgents(db)
      .filter((agent) => agent.connected)
      .map((agent) => agent.id);
    const operatorDescriptors = await this.operators.list(run.goalId, {
      agentIds: connectedAdapterIds,
      includeNonAgents: false,
    });
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: checkpoint.currentAdapterId,
      connectedAdapterIds,
      stepPreferences: preferencesForGoal(stepTpl.agentPreference, goal.orchestrator_provider),
      operators: operatorDescriptors,
      supportsModel: (id, mid) => this.stepDispatch?.supportsModel(id, mid) ?? false,
    });
    this.persistCheckpoint(db, stepRun.id, { ...checkpoint, choices });
  }

  /**
   * choose|waiting → switching. Validates the target against the live choice
   * set, then launches a replacement session for that adapter. The committed
   * switching output branch commits selection + retires the old session once the
   * replacement produces started output.
   */
  async switchProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    adapterId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const ctx = this.loadProviderRecoveryContext(db, runId, checkpointId);
    const { checkpoint } = ctx;
    if (checkpoint.mode !== "choose" && checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Switch is only allowed while choosing or waiting (mode: ${checkpoint.mode}).`
      );
    }
    if (adapterId === checkpoint.currentAdapterId) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Cannot switch to the limited provider (${adapterId}).`
      );
    }
    const choice = checkpoint.choices.find((c) => c.adapterId === adapterId);
    if (!choice) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${adapterId} is not an available recovery choice.`
      );
    }
    if (!choice.enabled || !choice.modelId) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${choice.displayName} is not available: ${choice.reason ?? "provider unavailable"}.`
      );
    }
    const ready = await (this.stepDispatch?.isAdapterReady(adapterId) ?? Promise.resolve(false));
    if (!ready) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${choice.displayName} became unavailable.`
      );
    }
    await this.startRecoveryReplacementSession(db, now, ctx, adapterId, "switching", options);
  }

  /**
   * Launches a replacement worker for the given adapter using a bounded
   * interrupted-session handoff (with any pending guidance), records the
   * replacement session id + its pre-delivery output_seq, and moves the
   * checkpoint to the supplied terminal-progress mode (retrying for a fresh
   * retry, switching for a provider switch). The old session is retained; it is
   * retired only by the committed output branch once the replacement starts.
   * On launch failure the old session is preserved and the checkpoint is
   * restored to choose with a bounded lastError.
   */
  private async startRecoveryReplacementSession(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      checkpoint: ProviderRecoveryCheckpoint;
    },
    adapterId: string,
    mode: "retrying" | "switching",
    options: RequestNextDecisionOptions
  ): Promise<void> {
    void now;
    const { run, stepRun, stepTpl, goal, checkpoint } = ctx;
    const interruptedTail = decodeSessionTail(
      this.sessionOutputStore.readTail(checkpoint.currentSessionId)
    );
    const guidanceBlock =
      checkpoint.pendingGuidance.length > 0
        ? `\n\n# Operator guidance\n${checkpoint.pendingGuidance.join("\n\n")}`
        : "";
    const handoffPrompt =
      composeProviderSwitchPrompt({
        agentPromptInput: {
          goalTitle: goal.title,
          goalDescription: goal.description,
          stepInstructions: stepTpl.instructions,
          outputSchema: stepTpl.outputSchema,
          priorStepArtifacts: this.collectPriorStepArtifacts(db, run.id, stepRun.id),
          repairContext: this.latestRejectingGate(db, run.id),
        },
        interruptedTail,
      }) + guidanceBlock;

    let sessionId: string;
    try {
      const launched = await this.launcher.launch({
        goalId: goal.id,
        workflowRunId: run.id,
        workflowStepRunId: stepRun.id,
        operatorId: "agent:" + adapterId,
        operatorKind: "agent",
        objective: handoffPrompt,
      });
      sessionId = launched.sessionId;
      await this.workerSpawn?.({ sessionId, goalId: goal.id, adapterId });
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "choose",
        replacementSessionId: null,
        replacementOutputSeq: null,
        lastError: (err instanceof Error ? err.message : "replacement launch failed").slice(0, 512),
      });
      throw err;
    }

    // Pre-delivery output sequence: started-output detection compares against this.
    const replacementOutputSeq = this.sessionOutputStore.readTail(sessionId).nextSeq;
    this.persistCheckpoint(db, stepRun.id, {
      ...checkpoint,
      mode,
      replacementSessionId: sessionId,
      replacementOutputSeq,
      lastError: null,
    });
    await this.workerDeliver?.(sessionId, handoffPrompt);
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
    const template = loadRunTemplate(db, run);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, run.goalId);
    if (!this.orchestratorMediator) return; // not configured

    if (!goal.orchestrator_provider || !goal.orchestrator_model) return;
    const adapterId = adapterIdForProvider(goal.orchestrator_provider);
    const modelId = goal.orchestrator_model;

    let action: OrchestratorAction;
    try {
      action = await judgeAgentResponse({
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
    } catch (err) {
      // The orchestrator-LLM evaluation failed (e.g. a shadow timeout). Don't
      // let the run silently park with no result: stash the agent's response so
      // it can be replayed, and tell the user how to retry.
      this.stashJudgeFailure(
        db,
        now,
        { goalId: run.goalId, stepRunId: stepRun.id, responseText: payload.responseText, err },
        options
      );
      return;
    }

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
   * The orchestrator-LLM evaluation of an agent response failed (timeout / error).
   * Stash the response on the step run so it can be replayed, and post a chat
   * message so the run doesn't silently park — any user message retries it.
   */
  private stashJudgeFailure(
    db: Database.Database,
    now: () => string,
    args: { goalId: string; stepRunId: string; responseText: string; err: unknown },
    options: RequestNextDecisionOptions
  ): void {
    const message = args.err instanceof Error ? args.err.message : String(args.err);
    db.prepare("UPDATE workflow_step_runs SET pending_judge_json = ? WHERE id = ?").run(
      JSON.stringify({ responseText: args.responseText, error: message, at: now() }),
      args.stepRunId
    );
    this.postOrchestratorMessage(
      db,
      now,
      args.goalId,
      `I couldn't evaluate this step — the orchestrator did not respond (${message}). The agent's work is saved; send any message to retry the evaluation.`,
      options
    );
  }

  /**
   * Replay a stashed agent-response judgement (see stashJudgeFailure). Called from
   * onUserMessage when a judge is pending: re-runs the evaluation with the stored
   * response, clears the stash on success, or re-stashes if it fails again.
   */
  private async runStashedJudgeRetry(
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
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const stash = JSON.parse(ctx.stepRun.pending_judge_json!) as { responseText: string };
    const adapterId = adapterIdForProvider(ctx.goal.orchestrator_provider!);
    const modelId = ctx.goal.orchestrator_model!;
    let action: OrchestratorAction;
    try {
      action = await judgeAgentResponse({
        mediator: this.orchestratorMediator as OrchestratorMediator,
        schemaValidate: (output) => {
          const v = validateStepOutput(ctx.stepTpl.outputSchema, output);
          return v.ok ? { ok: true } : { ok: false, errors: v.errors };
        },
        goalId: ctx.run.goalId,
        runId: ctx.run.id,
        stepRunId: ctx.stepRun.id,
        adapterId,
        modelId,
        responseText: stash.responseText,
      });
    } catch (err) {
      this.stashJudgeFailure(
        db,
        now,
        { goalId: ctx.run.goalId, stepRunId: ctx.stepRun.id, responseText: stash.responseText, err },
        options
      );
      return;
    }
    db.prepare("UPDATE workflow_step_runs SET pending_judge_json = NULL WHERE id = ?").run(ctx.stepRun.id);
    await this.applyOrchestratorAction(db, now, ctx, sessionId, stash.responseText, action, options);
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
      case "ask_user": {
        // The step agent needs a decision. Surface it as an interactive choice
        // (pending_question on the chat message); the user's answer flows back
        // as ordinary guidance via onUserMessage → forward_to_agent.
        const idFactory = options.idFactory ?? randomUUID;
        const pendingQuestion: PendingQuestionT = {
          questionId: idFactory(),
          toolUseId: idFactory(),
          questions: action.questions,
        };
        this.postOrchestratorMessage(db, now, ctx.run.goalId, action.body, options, "orchestrator", pendingQuestion);
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

        if (ctx.stepTpl.completionPolicy === "interview") {
          // An absent open_questions field is treated as empty (step may complete).
          const openQuestions = (block as { open_questions?: unknown } | null)?.open_questions;
          if (Array.isArray(openQuestions) && openQuestions.length > 0) {
            return this.reviseStep(
              db,
              now,
              ctx,
              sessionId,
              "This interview step still has unresolved open questions. Resolve each one with the user (one at a time, with a recommended answer), then present the synthesized result and ask the user to confirm before completing.",
              options
            );
          }
        }

        // Deterministic evidence gate: for steps that require execution, run the
        // sensor ladder in the workspace and veto the LLM's approval if the
        // verdict is not "passed". Runs before the supervision branch so it
        // applies to both supervised and unsupervised completions.
        const execReq = stepRequiresExecution(ctx.template.guardrails, ctx.stepTpl.id);
        if (execReq) {
          const workspacePath = listWorkspacesByGoal(db, ctx.run.goalId)[0]?.path ?? null;
          let evidence: Awaited<ReturnType<typeof runSensors>> | null = null;
          if (workspacePath) {
            try {
              evidence = await runSensors({ workspacePath, required: execReq.required });
            } catch (err) {
              console.error("runSensors failed", err);
              evidence = null;
            }
          }

          const evStaged: DomainEvent[] = [];
          evStaged.push(
            appendWorkflowEvent(
              db,
              "workflow.validation.run",
              { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
              now(),
              options.idFactory
            )
          );

          // Record the evidence facet on the step_complete transition regardless
          // of outcome (inspectability), then decide advance vs veto. A non-passed
          // verdict vetoes completion, so the outcome is a categorical failure
          // (failure_code: "evidence_veto"); "partial" escalates, "failed" fails.
          const vetoed = !!evidence && evidence.verdict !== "passed";
          const evidenceStatus: TransitionStatus = vetoed
            ? evidence!.verdict === "partial"
              ? "escalated"
              : "failed"
            : "succeeded";
          recordHarnessTransition(
            { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
            {
              goalId: ctx.run.goalId,
              workflowRunId: ctx.run.id,
              workflowStepRunId: ctx.stepRun.id,
              boundary: "step_complete",
              evidence: evidence ?? undefined,
              telemetry: buildTelemetry(
                this.otlpAccumulator,
                sessionId,
                evidenceStatus,
                vetoed ? "evidence_veto" : null,
                null,
                recommendationFeedbackInterventions(db, ctx.run.goalId)
              ),
            }
          );

          if (evidence && evidence.verdict !== "passed") {
            evStaged.push(
              appendWorkflowEvent(
                db,
                "workflow.validation.failed",
                { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
                now(),
                options.idFactory
              )
            );
            this.publish(options.bus, evStaged);
            const failingSummary = evidence.sensorsRun
              .filter((s) => s.result === "failed")
              .map((s) => `- ${s.kind} (\`${s.command}\`): ${s.summary.slice(0, 600)}`)
              .join("\n");
            const gapSummary =
              evidence.oracleAdequacy.gaps.length > 0
                ? `\nMissing required checks: ${evidence.oracleAdequacy.gaps.join(", ")}`
                : "";
            return this.reviseStep(
              db,
              now,
              ctx,
              sessionId,
              `Required verification did not pass. Fix these and re-run, then re-emit completion:\n${failingSummary}${gapSummary}`,
              options
            );
          }
          evStaged.push(
            appendWorkflowEvent(
              db,
              "workflow.validation.passed",
              { goalId: ctx.run.goalId, workflowRunId: ctx.run.id, stepRunId: ctx.stepRun.id },
              now(),
              options.idFactory
            )
          );
          this.publish(options.bus, evStaged);
        }

        const finishedAt = now();

        if (goalRequiresHumanReview(db, ctx.run.goalId) || ctx.stepTpl.completionPolicy === "handoff") {
          const scoringParse = StepResultScoringProposal.safeParse(action.scoring);
          const scoring = scoringParse.success ? scoringParse.data : undefined;
          const proposal = extractProposal(responseText);
          db.prepare(
            "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
          ).run(
            JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt, proposal }),
            ctx.stepRun.id
          );
          const summary = summarizeScoring(scoring, proposal);
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
        const rejected = await this.completeStepWithLedger(db, now, ctx, block, options, stagedEvents);
        if (rejected) {
          return this.reviseStep(
            db,
            now,
            ctx,
            sessionId,
            `Your ledger_updates were rejected:\n${rejected.rejections.join("\n")}\nRevise and re-emit.`,
            options
          );
        }
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
        return this.reviseStep(db, now, ctx, sessionId, action.feedback, options);
      }
    }
  }

  /**
   * Revises the current step: bumps the revise counter, and below the cap relays
   * feedback to the live agent session; at the cap posts an escalation message.
   * Shared by the mediator-driven revise_step action and deterministic revisions
   * (e.g. rejected ledger proposals on approval).
   */
  private async reviseStep(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow },
    sessionId: string | null,
    feedback: string,
    options: RequestNextDecisionOptions
  ): Promise<{ postedChatReply: boolean }> {
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
        `Step needs help after ${REVISE_CAP} revision attempts:\n${feedback}`,
        options
      );
      return { postedChatReply: true };
    }
    if (sessionId && this.workerDeliver) {
      const r = await this.workerDeliver(sessionId, feedback);
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
    const template = loadRunTemplate(db, run);
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

    // Provider recovery is pending: capture chat as bounded guidance instead of
    // forwarding to (or interpreting via the mediator on behalf of) the limited
    // worker. The guidance is replayed on retry / handed off on switch.
    if (stepRun.pending_provider_recovery_json) {
      const checkpoint = ProviderRecoveryCheckpoint.parse(
        JSON.parse(stepRun.pending_provider_recovery_json)
      );
      const item = args.body.slice(0, 4000);
      const pendingGuidance = [...checkpoint.pendingGuidance, item].slice(-20);
      db.prepare(
        "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
      ).run(
        JSON.stringify(ProviderRecoveryCheckpoint.parse({ ...checkpoint, pendingGuidance })),
        stepRun.id
      );
      this.postOrchestratorMessage(
        db,
        now,
        run.goalId,
        "Saved this guidance. It will be sent when the current provider is retried or included in the replacement provider handoff.",
        options
      );
      return;
    }

    // A previous step evaluation failed (stashJudgeFailure). Treat this message
    // as a retry: replay the stored agent response through the judge rather than
    // routing the text as fresh guidance.
    if (stepRun.pending_judge_json) {
      const sessionId =
        (
          db
            .prepare(
              "SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('created','starting','running') ORDER BY created_at DESC LIMIT 1"
            )
            .get(stepRun.id) as { id: string } | undefined
        )?.id ?? null;
      await this.runStashedJudgeRetry(db, now, { run, stepRun, stepTpl, template, goal }, sessionId, options);
      return;
    }

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
    options: RequestNextDecisionOptions,
    role: "orchestrator" | "user" = "orchestrator",
    pendingQuestion?: PendingQuestionT,
    pendingRevision?: { workflowRunId: string }
  ): void {
    const idFactory = options.idFactory ?? randomUUID;
    const messageId = idFactory();
    const correlationId = idFactory();
    const createdAt = now();
    const event = db.transaction(() => {
      db.prepare(
        `INSERT INTO orchestrator_messages
          (id, goal_id, role, kind, body, correlation_id, created_at, pending_question, pending_revision)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        goalId,
        role,
        body,
        correlationId,
        createdAt,
        pendingQuestion ? JSON.stringify(pendingQuestion) : null,
        pendingRevision ? JSON.stringify(pendingRevision) : null
      );
      const payload = { messageId, role };
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
    const template = loadRunTemplate(db, run);
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
    const template = loadRunTemplate(db, run);
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

    const template = loadRunTemplate(db, run);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, run.goalId);
    const ctx = { run, stepRun, stepTpl, template, goal };

    // Clear the stash first so a racing refine/confirm cannot double-apply.
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(stepRun.id);
    expireConfirmation({ db, bus: options.bus ?? new EventBus() }, { stepRunId: stepRun.id });

    const stagedEvents: DomainEvent[] = [];
    // The user already approved this completion; never block the confirmation on
    // ledger review — drop rejected proposals and commit the accepted ones.
    await this.completeStepWithLedger(db, now, ctx, stash.block, options, stagedEvents, "drop");
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

    if (stepTpl.completionPolicy === "handoff") {
      this.postHandoffClosingSummary(db, now, ctx, stash.block, options);
    }
  }

  /** Posts the conversational revision prompt and marks the step awaiting a
   *  revision. No-op if the step is not paused at a confirmation. */
  async requestStepRevision(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return;
    const stash = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as { pending_completion_json: string | null } | undefined;
    if (!stash?.pending_completion_json) return;
    this.postOrchestratorMessage(
      db, now, run.goalId, "What would you like to revise?", options,
      "orchestrator", undefined, { workflowRunId: runId }
    );
  }

  /** Accepts the user's revision text: persists it as a user bubble, clears the
   *  pending marker + completion stash, relays the feedback to the live step
   *  agent, and resumes the step. Idempotent once the stash is cleared. */
  async submitStepRevision(
    db: Database.Database,
    now: () => string,
    runId: string,
    feedback: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return;
    const stepRun = readStepRun(db, run.currentStepRunId);
    const stashRow = db
      .prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = ?")
      .get(stepRun.id) as { pending_completion_json: string | null } | undefined;
    if (!stashRow?.pending_completion_json) return; // idempotent no-op

    // Persist the user's revision as a chat bubble (no mediator trigger).
    this.postOrchestratorMessage(db, now, run.goalId, feedback, options, "user");

    db.prepare(
      "UPDATE orchestrator_messages SET pending_revision = NULL WHERE goal_id = ? AND json_extract(pending_revision, '$.workflowRunId') = ?"
    ).run(run.goalId, runId);
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = NULL WHERE id = ?").run(stepRun.id);

    const activityCtx = { db, bus: options.bus ?? new EventBus() };
    resumeFromConfirmation(activityCtx, { stepRunId: stepRun.id });

    const sessionRow = db
      .prepare("SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1")
      .get(stepRun.id) as { id: string } | undefined;
    await this.reviseStep(db, now, { run, stepRun }, sessionRow?.id ?? null, feedback, options);
  }

  /** Posts the Done step's closing summary and best-effort verifies the spec file(s). */
  private postHandoffClosingSummary(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; goal: GoalRow },
    block: unknown,
    options: RequestNextDecisionOptions
  ): void {
    const out = (block ?? {}) as { chosen_direction?: unknown; artifacts?: unknown };
    const direction = typeof out.chosen_direction === "string" ? out.chosen_direction : null;
    const artifacts = Array.isArray(out.artifacts) ? out.artifacts : [];
    const specRefs = artifacts
      .filter((a): a is { type: unknown; reference: unknown } => {
        return a && typeof a === "object" && (a as { type?: unknown }).type === "spec";
      })
      .map((a) => a.reference)
      .filter((r): r is string => typeof r === "string");

    const roots = (db
      .prepare("SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC")
      .all(ctx.goal.id) as Array<{ path: string }>).map((w) => w.path);

    const verified: string[] = [];
    const missing: string[] = [];
    for (const ref of specRefs) {
      const found = isAbsolute(ref) ? existsSync(ref) : roots.some((root) => existsSync(join(root, ref)));
      (found ? verified : missing).push(ref);
    }

    const lines: string[] = ["Design complete."];
    if (direction) lines.push(`Direction: ${direction}`);
    if (verified.length > 0) lines.push(`Spec saved: ${verified.join(", ")}`);
    if (missing.length > 0) lines.push(`Could not verify spec file(s): ${missing.join(", ")}`);
    if (specRefs.length === 0) lines.push("No spec artifact was reported by the Done step.");

    this.postOrchestratorMessage(db, now, ctx.run.goalId, lines.join("\n"), options);
  }

  /**
   * Continues all workflow runs currently paused at a supervised confirmation
   * checkpoint. Called when supervision mode switches to "unsupervised" so that
   * any held steps are immediately advanced without waiting for user confirmation.
   * Delegates to confirmStep for each paused run.
   *
   * When `goalId` is provided, the drain is scoped to that goal's parked runs
   * (used by the operating-mode flip); when omitted, it drains globally (the
   * settings route).
   */
  async continueAllPausedSteps(
    db: Database.Database,
    now: () => string,
    options: RequestNextDecisionOptions = {},
    goalId?: string
  ): Promise<void> {
    // When goalId is provided, drain ONLY that goal's parked runs; otherwise global.
    const goalParams = goalId ? [goalId] : [];

    const paused = db
      .prepare(
        `SELECT wr.id AS run_id
         FROM workflow_runs wr
         JOIN workflow_step_runs sr ON sr.id = wr.current_step_run_id
         WHERE sr.pending_completion_json IS NOT NULL${goalId ? " AND wr.goal_id = ?" : ""}`
      )
      .all(...goalParams) as { run_id: string }[];
    for (const p of paused) {
      await this.confirmStep(db, now, p.run_id, options);
    }

    // Runs parked at a gate confirmation checkpoint also resume.
    const pausedGates = db
      .prepare(
        `SELECT id AS run_id FROM workflow_runs WHERE pending_gate_route_json IS NOT NULL${goalId ? " AND goal_id = ?" : ""}`
      )
      .all(...goalParams) as { run_id: string }[];
    for (const p of pausedGates) {
      await this.confirmGate(db, now, p.run_id, options);
    }

    // Runs parked at a splitter confirmation checkpoint also resume.
    const pausedSplits = db
      .prepare(
        `SELECT id AS run_id FROM workflow_runs WHERE pending_split_route_json IS NOT NULL${goalId ? " AND goal_id = ?" : ""}`
      )
      .all(...goalParams) as { run_id: string }[];
    for (const p of pausedSplits) {
      await this.confirmSplit(db, now, p.run_id, options);
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
    const template = loadRunTemplate(db, run);
    if (!template) throw new OrchestratorTemplateNotFoundError(run.templateId);
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorStepNotFoundError(stepRun.id);
    const goal = readGoal(db, run.goalId);

    await this.commitAdvanceOrComplete(db, now, { run, stepRun, stepTpl, template, goal }, options);

    // Steps WITH an evidence gate emit their step_complete transition (with the
    // evidence facet) in the approve_step_complete veto block; emitting again
    // here would duplicate it. Only emit here for steps without a gate.
    if (!stepRequiresExecution(template.guardrails, stepRun.step_template_id)) {
      try {
        // No agent session id is in scope here; map the worker session that
        // accrued tokens for this step via sessions.workflow_step_run_id.
        const sessionRow = db
          .prepare(
            "SELECT id FROM sessions WHERE workflow_step_run_id = ? ORDER BY created_at DESC LIMIT 1"
          )
          .get(stepRun.id) as { id: string } | undefined;
        recordHarnessTransition(
          { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
          {
            goalId: run.goalId,
            workflowRunId: run.id,
            workflowStepRunId: stepRun.id,
            boundary: "step_complete",
            telemetry: buildTelemetry(
              this.otlpAccumulator,
              sessionRow?.id,
              "succeeded",
              null,
              null,
              recommendationFeedbackInterventions(db, run.goalId)
            ),
          }
        );
      } catch (err) {
        console.error("recordHarnessTransition failed", err);
      }
    }

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

    const workspaceRows = db
      .prepare("SELECT w.name AS name, w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC")
      .all(ctx.goal.id) as Array<{ name: string; path: string }>;

    const objective = composeAgentInitialPrompt({
      goalTitle: ctx.goal.title,
      goalDescription: ctx.goal.description,
      stepInstructions: ctx.stepTpl.instructions,
      outputSchema: ctx.stepTpl.outputSchema,
      priorStepArtifacts: this.collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.id),
      repairContext: this.latestRejectingGate(db, ctx.run.id),
      workspaces: workspaceRows.map((w) => ({ name: w.name, root: w.path })),
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
   * Collects the most recent step_output artifact per step template (excluding
   * the current step run's own output), returning each as { stepId, outputJson }.
   * Selection is by recency (artifact created_at), NOT ordinal, so a step
   * revisited via a backward gate route still sees the latest DOWNSTREAM step
   * outputs (e.g. Validation, which has a higher ordinal) needed to repair.
   * stepId is the step_template_id of the artifact's step run; outputJson is the
   * parsed artifact body.
   */
  private collectPriorStepArtifacts(
    db: Database.Database,
    runId: string,
    currentStepRunId: string
  ): Array<{ stepId: string; outputJson: unknown }> {
    const stepRuns = db
      .prepare("SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ?")
      .all(runId) as Array<{ id: string; step_template_id: string }>;
    const byId = new Map(stepRuns.map((s) => [s.id, s]));
    // listArtifactsForRun is ordered by created_at ASC; keeping the last seen
    // artifact per template yields the most recent output per step.
    const latestByTemplate = new Map<string, unknown>();
    for (const artifact of listArtifactsForRun(db, runId)) {
      if (artifact.type !== "step_output" || !artifact.stepRunId) continue;
      if (artifact.stepRunId === currentStepRunId) continue;
      const owner = byId.get(artifact.stepRunId);
      if (!owner) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.body);
      } catch {
        parsed = artifact.body;
      }
      latestByTemplate.set(owner.step_template_id, parsed);
    }
    return [...latestByTemplate].map(([stepId, outputJson]) => ({ stepId, outputJson }));
  }

  /**
   * Returns the most recent rejecting gate decision for the run, used as repair
   * context when a backward gate route re-runs an earlier step. Null when no
   * gate has rejected.
   */
  private latestRejectingGate(
    db: Database.Database,
    runId: string
  ): { reason: string; issueRefs: string[] } | null {
    const last = listGateDecisionsForRun(db, runId)
      .filter((d) => d.outcome === "rejected")
      .at(-1);
    return last ? { reason: last.reason, issueRefs: last.issueRefs } : null;
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

    const template = loadRunTemplate(db, run);
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
      const result = buildScoredStepResult(facts, proposal.data);
      return this.withResultSummary(db, ctx.stepRun, result);
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

  /** Attaches the step's own output summary + primary artifact to a built result,
   *  so the result card can lead with the result rather than the scoring reason. */
  private withResultSummary(
    db: Database.Database,
    stepRun: StepRunRow,
    result: WorkflowStepResult,
  ): WorkflowStepResult {
    const output = this.readStepOutputAsRecord(db, stepRun.workflow_run_id, stepRun.id);
    if (!output) return result;
    // These are denormalized display fields; the full text lives in the
    // step_output artifact. Clamp to the WorkflowStepResult schema's own limits
    // so an over-length agent summary can't fail validation and strand the step.
    const summary =
      typeof output.summary === "string" ? clampToLimit(output.summary, 2000) : undefined;
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    const chosen =
      artifacts.find((a) => a && typeof a === "object" && (a as { type?: unknown }).type === "spec") ??
      artifacts[0];
    let primaryArtifact: { reference: string; description: string } | undefined;
    if (chosen && typeof chosen === "object") {
      const ref = (chosen as { reference?: unknown }).reference;
      const desc = (chosen as { description?: unknown }).description;
      if (typeof ref === "string") {
        primaryArtifact = {
          reference: clampToLimit(ref, 1024),
          description: clampToLimit(typeof desc === "string" ? desc : "", 512),
        };
      }
    }
    return {
      ...result,
      ...(summary ? { resultSummary: summary } : {}),
      ...(primaryArtifact ? { primaryArtifact } : {}),
    };
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
      riskLabels: ["operator:" + chosen.id],
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
      this.recordStepLaunchTransition(db, now, goal, run, stepRun, options);
      return this.commitNoopLatestDecision(db, run.id, stepRun.id);
    } catch {
      return this.commitLaunchRecommendation(db, now, ctx, chosen, objective, options);
    }
  }

  /**
   * Record the step_launch HarnessTransition carrying the read_set derived from the
   * goal's current context inputs (memory/decisions/refinement/workspace) — the
   * "state version as of launch" that belief-divergence later compares against.
   * The context-assembly rows are not in scope here, so re-derive via the same
   * readers buildContextAssemblyInput uses. Sibling summaries are intentionally
   * omitted (context, not conflict-relevant state). A state-record failure must
   * never break step launch, so the whole block is guarded.
   */
  private recordStepLaunchTransition(
    db: Database.Database,
    now: () => string,
    goal: GoalRow,
    run: WorkflowRunT,
    stepRun: StepRunRow,
    options: RequestNextDecisionOptions
  ): void {
    try {
      const memory = listMemoryByGoal(db, goal.id, { includeArchived: false }).map((m) => ({
        id: m.id,
        updatedAt: m.updatedAt,
      }));
      const decisions = listDecisionsByGoal(db, goal.id, { includeArchived: false }).map((d) => ({
        id: d.id,
        updatedAt: d.updatedAt,
      }));
      const ref = getGoalRefinement(db, goal.id);
      const refinement = ref ? { goalId: ref.goalId, refinedAt: ref.refinedAt } : null;
      // Goal's first-attached workspace is its working workspace (same convention
      // as the sensor-ladder lookup). branch/dirty are not persisted metadata, so
      // mirror buildContextAssemblyInput and leave them null.
      const ws = listWorkspacesByGoal(db, goal.id)[0];
      const workspace = ws ? { id: ws.id, branch: null, dirty: null } : null;

      const { read_set, version_deps } = deriveReadSet({
        memory,
        decisions,
        summaries: [],
        refinement,
        workspace,
      });

      recordHarnessTransition(
        { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
        {
          goalId: goal.id,
          workflowRunId: run.id,
          workflowStepRunId: stepRun.id,
          boundary: "step_launch",
          stateDeps: {
            read_set,
            write_set: [],
            assumptions: [],
            version_deps,
            conflict_policy: "escalate",
            conflicts: [],
          },
        }
      );
    } catch (err) {
      console.error("recordHarnessTransition failed", err);
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

  /**
   * Completes a step from its agent-emitted completion envelope: splits the
   * envelope into business `output` + proposed `ledger_updates`, reviews the
   * proposals against the latest committed ledger, then ATOMICALLY writes the
   * `step_output` artifact (storing only the validated business output, so
   * downstream readers are unaffected) and commits one ledger version.
   *
   * The async review runs OUTSIDE the synchronous better-sqlite3 transaction
   * (transactions are synchronous). On rejection, NO ledger version is committed
   * and no step_output is written — the caller revises the step.
   *
   * Decision: a ledger version is committed on EVERY successful executable step
   * even when there are no updates, so `ledger_version` advances monotonically
   * and gates can reference a stable version. An empty version is cheap.
   *
   * Returns the rejection reasons when review fails (caller revises), or `null`
   * on success.
   */
  private async completeStepWithLedger(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
    },
    block: unknown,
    options: RequestNextDecisionOptions,
    stagedEvents: DomainEvent[],
    onReject: "revise" | "drop" = "revise"
  ): Promise<{ rejections: string[] } | null> {
    const { output, ledgerUpdates } = parseStepCompletionEnvelope(block);

    // Guard the proposed updates even though parseStepCompletionEnvelope already
    // returns typed updates (defensive: bare-output back-compat returns []).
    const guard = LedgerUpdate.array().safeParse(ledgerUpdates);
    if (!guard.success) {
      if (onReject === "revise") return { rejections: ["ledger_updates failed schema validation"] };
      // drop: complete with an empty ledger version (the user already approved).
      this.commitStepOutputAndLedger(db, now, ctx, output, [], options, stagedEvents);
      return null;
    }

    // Async review/normalize MUST happen before opening the synchronous tx.
    const committed = latestCommittedLedger(db, ctx.run.id);
    const review = await reviewAndNormalizeLedgerUpdates(
      {},
      { committed, proposals: guard.data }
    );
    if (review.rejected.length > 0 && onReject === "revise") {
      return { rejections: review.rejected.map((r) => r.reason) };
    }
    if (review.rejected.length > 0 && onReject === "drop") {
      console.warn("[ledger] dropping rejected proposals on confirm (user already approved)", { stepRunId: ctx.stepRun.id, count: review.rejected.length, reasons: review.rejected.map((r) => r.reason) });
    }

    this.commitStepOutputAndLedger(db, now, ctx, output, review.accepted, options, stagedEvents);
    return null;
  }

  /** Atomic: step_output write + ledger version commit roll back together. */
  private commitStepOutputAndLedger(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate; goal: GoalRow },
    output: unknown,
    updates: LedgerUpdate[],
    options: RequestNextDecisionOptions,
    stagedEvents: DomainEvent[]
  ): void {
    // Atomic: step_output write + ledger version commit roll back together.
    // (createArtifact and commitLedgerVersion each open their own tx; nested
    // here they become SAVEPOINTs under this single outer transaction.)
    db.transaction(() => {
      this.createStepOutputArtifact(db, now, ctx, JSON.stringify(output ?? {}), options, stagedEvents);
      commitLedgerVersion(db, now, {
        goalId: ctx.run.goalId,
        workflowRunId: ctx.run.id,
        sourceStepRunId: ctx.stepRun.id,
        traversalSeq: ctx.run.traversalSeq,
        updates,
      });
    })();
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
        this.parkForGateApproval(
          db,
          now,
          { run, stepRun, stepTpl, template, goal, gateNodeId: result.nodeId },
          options
        );
        // A missing gate blocks the run; do not recurse. Otherwise the gate is
        // parked awaiting a human approve/reject (current_step_run_id = NULL);
        // do not recurse either — the decideGate path resumes routing.
        const after = getWorkflowRunById(db, run.id);
        if (!after || after.status !== "active" || !after.currentStepRunId) {
          return this.commitNoopLatestDecision(db, run.id, stepRun.id);
        }
      }

      if (result.kind === "splitter") {
        await this.evaluateAndParkSplitter(
          db,
          now,
          { run, stepRun, stepTpl, template, goal, splitterNodeId: result.nodeId },
          options
        );
        // A supervised park leaves current_step_run_id = NULL (awaiting Continue);
        // do not recurse. An unsupervised inline route either advanced to a step
        // with a spawned agent or parked at a downstream splitter/gate.
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
        "SELECT body FROM workflow_artifacts WHERE workflow_run_id = ? AND step_run_id = ? AND type = 'step_output' ORDER BY created_at DESC, rowid DESC LIMIT 1"
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
  /**
   * The run cursor has advanced to a gate (current_node_kind='gate'). Gates are
   * always resolved by a human approve/reject decision — there is no LLM
   * auto-evaluation. We stash the gate + source step, park a confirmation
   * activity, and leave the run active with current_step_run_id NULL until
   * decideGate records the chosen outcome and routes.
   */
  private parkForGateApproval(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      gateNodeId: string;
    },
    options: RequestNextDecisionOptions
  ): void {
    const { run, stepRun, stepTpl, template, goal, gateNodeId } = ctx;
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

    const stagedEvents: DomainEvent[] = [];
    db.transaction(() => {
      db.prepare("UPDATE workflow_runs SET pending_gate_route_json = ? WHERE id = ?").run(
        JSON.stringify({
          awaitingHumanDecision: true,
          gateNodeId: gateNode.id,
          sourceStepRunId: stepRun.id,
        }),
        run.id
      );
      // Record a decision so the caller (commitNoopLatestDecision) has a trace to
      // return while the run is parked awaiting the user's gate decision.
      recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "evaluate_gate",
          selectedAction: `gate:${gateNode.id}:await_human`,
          reason: `Gate "${gateNode.name}" awaiting human approval`,
          influencedBy: [
            { kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "evaluate_gate",
            payload: `${gateNode.id}:await_human`,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    this.publish(options.bus, stagedEvents);
    const activityCtx = { db, bus: options.bus ?? new EventBus() };
    pauseForGateDecision(activityCtx, {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      gateName: gateNode.name,
    });
  }

  /**
   * Builds the broker request payload for a splitter evaluation: the splitter's
   * declared branches/instructions, the goal, the source step output, prior split
   * decisions, and the committed ledger (capped to the contract's serialized-size
   * limits). Mirrors the GateEvaluationRequest shape.
   */
  private buildSplitEvaluationRequest(
    db: Database.Database,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      goal: GoalRow;
      splitterNode: WorkflowGraphNode;
    }
  ): SplitEvaluationRequest {
    const { run, stepRun, goal, splitterNode } = ctx;
    const priorDecisions = listSplitDecisionsForRun(db, run.id)
      .map((d) => ({
        nodeId: d.nodeId,
        selectedBranch: d.selectedBranch,
        reason: d.reason.slice(0, 1024),
      }))
      .slice(-50);
    const committedLedger = latestCommittedLedger(db, run.id)
      .records.slice(-35)
      .map((r) => ({
        id: r.id.slice(0, 128),
        recordType: r.recordType.slice(0, 64),
        status: r.status.slice(0, 64),
        note: r.note.slice(0, 500),
      }));
    return SplitEvaluationRequest.parse({
      splitter: {
        nodeId: splitterNode.id,
        name: splitterNode.name,
        instructions: splitterNode.instructions ?? "",
        branches: splitterNode.branches ?? [],
      },
      goal: { id: goal.id, description: goal.description },
      sourceStepOutput: this.readStepOutputAsRecord(db, run.id, stepRun.id),
      priorDecisions,
      committedLedger,
    });
  }

  /**
   * The run cursor is parked at a splitter (current_node_kind='splitter').
   * Evaluates the branch via the orchestrator broker, validates the selected
   * branch against the node's declared branches, records the split decision,
   * then routes — parking for a Continue confirmation in supervised mode or
   * routing inline in unsupervised mode.
   */
  private async evaluateAndParkSplitter(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      splitterNodeId: string;
    },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, stepRun, stepTpl, template, goal, splitterNodeId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const splitterNode = graph.nodes.find(
      (n) => n.id === splitterNodeId && n.type === "splitter"
    );
    if (!splitterNode) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `splitter node not found in graph: ${splitterNodeId}`,
        options
      );
      return;
    }
    const branches = splitterNode.branches ?? [];

    // The broker requires a concrete orchestrator provider + model; a goal with
    // neither cannot be evaluated, so block with a clear reason rather than
    // passing null into the OrchestrationRequest (which would throw on parse).
    if (!goal.orchestrator_provider || !goal.orchestrator_model) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `goal has no orchestrator provider/model for splitter ${splitterNode.id}`,
        options
      );
      return;
    }

    const request = OrchestrationRequest.parse({
      kind: "evaluate_split",
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      providerId: goal.orchestrator_provider,
      modelId: goal.orchestrator_model,
      payload: this.buildSplitEvaluationRequest(db, { run, stepRun, goal, splitterNode }),
    });
    const validate = (raw: unknown) => {
      const parsed = SplitEvaluationProposal.safeParse(raw);
      if (!parsed.success) {
        return { accepted: false as const, failureMessage: "invalid split proposal" };
      }
      if (!branches.includes(parsed.data.selectedBranch)) {
        return {
          accepted: false as const,
          failureMessage: `selectedBranch '${parsed.data.selectedBranch}' is not a declared branch`,
        };
      }
      return { accepted: true as const, parsed: parsed.data };
    };

    let result = await this.broker.propose(request, { validateProposal: validate });
    if (result.status !== "proposed") {
      result = await this.broker.propose(request, { validateProposal: validate });
    }
    if (result.status !== "proposed") {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `splitter ${splitterNode.id} evaluation failed`,
        options
      );
      return;
    }
    const proposal = result.parsed as SplitEvaluationProposal;

    let dest: Destination;
    try {
      dest = resolveSplitterNext(graph, splitterNode.id, proposal.selectedBranch);
    } catch (e) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `splitter ${splitterNode.id} routing failed: ${(e as Error).message}`,
        options
      );
      return;
    }
    if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `splitter ${splitterNode.id} resolved to an unroutable destination`,
        options
      );
      return;
    }

    const ledger = latestCommittedLedger(db, run.id);
    const seq = nextTraversalSeq(db, run.id);
    recordSplitDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: splitterNode.id,
      traversalSeq: seq,
      selectedBranch: proposal.selectedBranch,
      reason: proposal.reason,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: proposal.inputsConsidered,
      ledgerVersion: ledger.version,
    });

    if (goalRequiresHumanReview(db, run.goalId)) {
      const stagedEvents: DomainEvent[] = [];
      db.transaction(() => {
        db.prepare("UPDATE workflow_runs SET pending_split_route_json = ? WHERE id = ?").run(
          JSON.stringify({
            splitterNodeId: splitterNode.id,
            selectedBranch: proposal.selectedBranch,
            destNodeId: dest.nodeId,
            destKind: dest.kind,
            sourceStepRunId: stepRun.id,
          }),
          run.id
        );
        recordDecisionInTx(
          db,
          now,
          {
            goalId: goal.id,
            workflowRunId: run.id,
            stepRunId: stepRun.id,
            decisionType: "evaluate_split",
            selectedAction: `splitter:${splitterNode.id}:${proposal.selectedBranch}`,
            reason: proposal.reason,
            influencedBy: [
              { kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" },
            ],
            inputFingerprint: decisionFingerprint({
              runId: run.id,
              stepRunId: stepRun.id,
              decisionType: "evaluate_split",
              payload: `${splitterNode.id}:${proposal.selectedBranch}`,
            }),
          },
          { idFactory: options.idFactory, stagedEvents }
        );
      })();
      this.publish(options.bus, stagedEvents);
      const summary = `Routing to "${proposal.selectedBranch}": ${proposal.reason}`;
      const activityCtx = { db, bus: options.bus ?? new EventBus() };
      // The source step has already completed, so its live activity is likely
      // finalized — pauseForConfirmation alone would no-op and strand the run.
      // Mirror the supervised step-completion path: guarantee a live activity
      // for the source step run exists before pausing, so a confirmation card
      // is always created (no agent → agentSessionId null).
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

    // Unsupervised: route inline immediately.
    await this.routeGateDestination(
      db,
      now,
      { run, template, goal, sourceStepRunId: stepRun.id },
      { kind: dest.kind, nodeId: dest.nodeId },
      options
    );
    const after = getWorkflowRunById(db, run.id);
    if (after && after.status === "active" && after.currentStepRunId) {
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
   * Resolve a gate parked awaiting a human decision. Records the chosen outcome
   * as the gate decision (deduped by traversal_seq), then performs the route via
   * routeGateDestination. Idempotent: a missing or non-human stash is a no-op so
   * a double-submit cannot double-route.
   */
  async decideGate(
    db: Database.Database,
    now: () => string,
    runId: string,
    outcome: "approved" | "rejected",
    options: RequestNextDecisionOptions & { reason?: string } = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) return;
    const stashRow = db
      .prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { pending_gate_route_json: string | null } | undefined;
    if (!stashRow?.pending_gate_route_json) return; // idempotent no-op

    let stash: { awaitingHumanDecision?: boolean; gateNodeId: string; sourceStepRunId: string };
    try {
      stash = JSON.parse(stashRow.pending_gate_route_json);
    } catch {
      db.prepare("UPDATE workflow_runs SET pending_gate_route_json = NULL WHERE id = ?").run(runId);
      return;
    }
    if (!stash.awaitingHumanDecision) return; // not a human-gated park

    const template = loadRunTemplate(db, run);
    if (!template) return;
    const goal = readGoal(db, run.goalId);
    const graph = effectiveGraph(template.graph, template.steps);
    const gateNode = graph.nodes.find((n) => n.id === stash.gateNodeId && n.type === "gate");
    if (!gateNode) {
      db.prepare("UPDATE workflow_runs SET pending_gate_route_json = NULL WHERE id = ?").run(runId);
      return;
    }

    const dest = resolveGateNext(graph, gateNode.id, outcome);
    const stepRun = readStepRun(db, stash.sourceStepRunId);
    const stepTpl =
      template.steps.find((s) => s.id === stepRun.step_template_id) ?? template.steps[0]!;
    if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `gate ${gateNode.id} resolved to an unroutable destination`,
        options
      );
      return;
    }

    const ledger = latestCommittedLedger(db, run.id);
    const seq = nextTraversalSeq(db, run.id);
    // Clear the stash first so a racing submit cannot double-route.
    db.prepare("UPDATE workflow_runs SET pending_gate_route_json = NULL WHERE id = ?").run(runId);
    recordGateDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: gateNode.id,
      traversalSeq: seq,
      outcome,
      reason: options.reason?.trim() || `${outcome} by user`,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: [],
      issueRefs: [],
      ledgerVersion: ledger.version,
    });
    resolveGateDecisionActivity(
      { db, bus: options.bus ?? new EventBus() },
      { stepRunId: stash.sourceStepRunId, gateName: gateNode.name, outcome }
    );

    await this.routeGateDestination(
      db,
      now,
      { run, template, goal, sourceStepRunId: stash.sourceStepRunId },
      { kind: dest.kind, nodeId: dest.nodeId },
      options
    );

    // If the destination is a step, spawn its agent exactly once (mirrors
    // advanceToNextStep). A gate destination re-parks inside routeGateDestination
    // and leaves current_step_run_id NULL, so nothing spawns here.
    const after = getWorkflowRunById(db, runId);
    if (after && after.status === "active" && after.currentStepRunId) {
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
    dest: { kind: "step" | "gate" | "splitter"; nodeId: string },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, template, goal, sourceStepRunId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);

    if (dest.kind === "splitter") {
      db.prepare(
        "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'splitter' WHERE id = ?"
      ).run(dest.nodeId, run.id);
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
      await this.evaluateAndParkSplitter(
        db,
        now,
        { run, stepRun, stepTpl, template, goal, splitterNodeId: dest.nodeId },
        options
      );
      return;
    }

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
      this.parkForGateApproval(
        db,
        now,
        { run, stepRun, stepTpl, template, goal, gateNodeId: dest.nodeId },
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
   * Interrupt the agent currently running the run's active step (sends Escape to
   * its worker) so the user can course-correct. The session stays alive and idle;
   * the user's next message is forwarded to it as the correction. Returns true
   * when a live session was interrupted.
   */
  async interruptStepAgent(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: { bus?: EventBus } = {}
  ): Promise<boolean> {
    const run = getWorkflowRunById(db, runId);
    if (!run || !run.currentStepRunId) return false;
    const sessionRow = db
      .prepare(
        "SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1"
      )
      .get(run.currentStepRunId) as { id: string } | undefined;
    if (!sessionRow?.id) return false;
    await this.workerInterrupt?.(sessionRow.id);
    // The ESC keystroke leaves the agent idle but never fires a Stop hook, so the
    // in-flight turn's activity would pulse "running" forever. Finalize it here so
    // the timeline card settles and visibly reports the interruption; the user's
    // correction opens a fresh turn on the same (still active) step.
    interruptLive(
      { db, bus: options.bus ?? new EventBus(), now },
      {
        stepRunId: run.currentStepRunId,
        finalSummary: "Interrupted — send a correction to resume.",
      }
    );
    return true;
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
      awaitingHumanDecision?: boolean;
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
    // A human-gated park is resolved by decideGate (the user picks the outcome),
    // not by Continue — leave it parked so confirmGate/resume cannot auto-route it.
    if (stash.awaitingHumanDecision) return;

    const template = loadRunTemplate(db, run);
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

  /**
   * User "Continue" for a supervised splitter decision held at a confirmation
   * checkpoint. Reads + clears pending_split_route_json, expires the confirmation
   * activity, then performs the deferred route. Idempotent: a null/consumed stash
   * is a no-op. The splitter is NOT re-evaluated — the decision is already recorded
   * and deduped by traversal_seq.
   */
  async confirmSplit(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) return;
    const stashRow = db
      .prepare("SELECT pending_split_route_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { pending_split_route_json: string | null } | undefined;
    if (!stashRow?.pending_split_route_json) return; // idempotent no-op

    let stash: {
      splitterNodeId: string;
      selectedBranch: string;
      destNodeId: string;
      destKind: "step" | "gate" | "splitter";
      sourceStepRunId: string;
    };
    try {
      stash = JSON.parse(stashRow.pending_split_route_json);
    } catch {
      db.prepare("UPDATE workflow_runs SET pending_split_route_json = NULL WHERE id = ?").run(runId);
      return;
    }

    const template = loadRunTemplate(db, run);
    if (!template) return;
    const goal = readGoal(db, run.goalId);

    // Clear the stash first so a racing Continue cannot double-route.
    db.prepare("UPDATE workflow_runs SET pending_split_route_json = NULL WHERE id = ?").run(runId);
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
    // (mirrors the requestNextDecision recursion). A splitter/gate destination
    // re-parks inside routeGateDestination.
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
