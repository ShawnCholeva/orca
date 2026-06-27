import type Database from "better-sqlite3";
import {
  AdapterId,
  ProviderRecoveryCheckpoint,
  StepResultScoringProposal,
  validateStepOutput,
  type DomainEvent,
  type OrchestratorAction,
  type PendingQuestion as PendingQuestionT,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepTemplate,
  type WorkflowTemplate as WorkflowTemplateT,
  type TransitionStatus,
  type StateDepsFacet,
} from "@orca/contracts";

import { EventBus } from "../../events.js";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent } from "../events.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { loadRunTemplate } from "../runs/run-template.js";
import { reconstructTranscript } from "./interview.js";
import { buildStepExecutionInput } from "./step-input.js";
import { decodeSessionTail, decodeSessionTailFromSeq } from "./session-tail.js";
import { synthesizeStepOutput } from "./synthesize.js";
import { detectPendingAgentQuestion } from "./agent-interview.js";
import { listWorkspacesByGoal } from "../../workspaces/projection.js";
import { buildStepCompleteStateFacet, decideConflictResponse } from "../../harness-state/step-complete.js";
import { conflictPolicyForGoal } from "../../harness-state/conflict-policy.js";
import { emitStepComplete } from "../../harness-transitions/emit.js";
import { runSensors } from "../../harness-sensors/runner.js";
import { stepRequiresExecution } from "./requires-execution.js";
import { judgeAgentResponse } from "./judgement.js";
import { extractOrcaStepCompleteBlock } from "./orca-output.js";
import { completeStepWithLedger } from "./ledger-commit.js";
import { incrementReviseAttempt, REVISE_CAP } from "./revise-loop.js";
import { incrementCrashRetry, CRASH_RETRY_CAP } from "./crash-retry.js";
import {
  buildEvaluationFailedStepResult,
} from "../steps/step-result.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import { resolveAgentProvider } from "../../orchestrator-llm/providers/registry.js";
import { listAgents } from "../../agents.js";
import { buildProviderRecoveryChoices } from "./provider-recovery.js";
import {
  recoverStepScoring,
  type ShadowAsk,
} from "./recover-step-scoring.js";
import { interruptLive, expireConfirmation, openOrUpdateLive, pauseForConfirmation, pauseForProviderRecovery, resumeFromConfirmation, resumeFromProviderRecovery } from "../../activities/store.js";
import { setSessionStatus } from "../../sessions/projection.js";
import { recordRevisionSignal } from "../revision-signals/store.js";
import { extractProposal, summarizeScoring } from "./scoring-summary.js";
import { scoringFacts, buildApprovalStepResult, replayEvaluationFailedResult } from "./step-result-builder.js";
import {
  type GoalRow,
  type StepRunRow,
  readGoal,
  readStepRun,
  preferencesForGoal,
} from "./db-rows.js";
import {
  stepRunIdsByTemplateId,
  hasActiveUnansweredQuestion,
  publishStaged,
  buildStepResultBuilderDeps,
} from "./queries.js";
import { postOrchestratorMessage } from "./orchestrator-message.js";

import {
  type StepDispatchCapabilities,
  type RequestNextDecisionOptions,
  type TokenAccumulator,
  OrchestratorRunNotFoundError,
  OrchestratorTemplateNotFoundError,
} from "./dispatch-types.js";
import {
  DispatchEngine,
  NULL_ACCUMULATOR,
  nowWithFirstTimestamp,
  buildTelemetry,
  recommendationFeedbackInterventions,
  goalRequiresHumanReview,
  resolveShadowAdapterId,
  stepDispatchEnablesOneShot,
} from "./dispatch-engine.js";
export {
  NULL_ACCUMULATOR,
  buildTelemetry,
  nowWithFirstTimestamp,
} from "./dispatch-engine.js";

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

/** Pull the step's free-text `assumptions[]` out of its completion block, if present. */
function extractStepCompleteAssumptions(block: unknown): string[] {
  const raw = (block as { assumptions?: unknown } | null)?.assumptions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.length > 0);
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
  private readonly engine: DispatchEngine;

  constructor(
    engine: DispatchEngine,
    private readonly broker: Pick<OrchestrationTransportBroker, "propose">,
    private readonly operators: Pick<OperatorRegistry, "list">,
    sessionOutputStore?: SessionOutputStore,
    private readonly stepDispatch?: StepDispatchCapabilities,
    private readonly orchestratorMediator?: Pick<OrchestratorMediator, "invoke"> & Partial<Pick<OrchestratorMediator, "invokeWithBackoff">>,
    // Reliable idle-gated submit to the worker's stdin (initial objective, forwards, revise feedback).
    private readonly workerDeliver?: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">,
    // Best-effort worker termination when a step's session ends.
    private readonly workerTerminate?: (sessionId: string) => Promise<void>,
    private readonly shadowAsk?: ShadowAsk,
    private readonly recoveryPromptComposer: RecoveryScoringPromptComposer =
      composeRecoveryScoringPrompt,
    // Interrupts the worker's current turn (sends Escape) so the user can course-correct.
    private readonly workerInterrupt?: (sessionId: string) => Promise<void>,
    // Drains accrued OTEL worker tokens for a session when a step_complete
    // transition is recorded, so the TelemetryFacet carries real cost. Defaults
    // to a no-op (drain → null) so transitions get `cost: null`.
    private readonly otlpAccumulator: TokenAccumulator = NULL_ACCUMULATOR
  ) {
    this.engine = engine;
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
        await this.engine.requestNextDecision(db, now, stepRun.workflow_run_id, options).catch(() => {});
        return;
      }
      const run = getWorkflowRunById(db, stepRun.workflow_run_id);
      if (!run || run.status !== "active") return;
      const finishedAt = now();
      const stepResult = replayEvaluationFailedResult(buildStepResultBuilderDeps(this.broker), db, stepRun, finishedAt);
      await this.engine.requestNextDecision(
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
      this.engine.blockRun(
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
        postOrchestratorMessage(
          db,
          now,
          run.goalId,
          `The agent for "${stepTpl.name}" crashed ${CRASH_RETRY_CAP} times${sess.failure_reason ? ` (${sess.failure_reason})` : ""}. Manual intervention needed.`,
          options
        );
      } else {
        await this.engine.spawnStepAgent(
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
    const stepRunByStepId = stepRunIdsByTemplateId(db, run.id);
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
      this.engine.blockRun(
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
      this.engine.blockRun(db, now, { run, stepRun, stepTpl, goal }, result.reason, options);
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
    publishStaged(options.bus, stagedEvents);

    // (10) Drive advancement to the next step / completion.
    const finishedAt = now();
    const facts = scoringFacts(buildStepResultBuilderDeps(this.broker), db, stepRun, "passed", finishedAt);
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
    await this.engine.requestNextDecision(db, nowWithFirstTimestamp(now, finishedAt), run.id, {
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
    const provider = resolveAgentProvider(sess.adapter_id as ShadowAdapterId);
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
        this.engine.commitDeterministicStepSelection(
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
    if (hasActiveUnansweredQuestion(db, stepArtifacts, stepRun.id)) return;

    // (6) Load run, template, step template to call commitUserInputDecision.
    const run = getWorkflowRunById(db, stepRun.workflow_run_id);
    if (!run || run.status !== "active") return;
    const template = loadRunTemplate(db, run);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;

    // (7) Record the decision.
    this.engine.commitUserInputDecision(
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
    postOrchestratorMessage(
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
        postOrchestratorMessage(db, now, ctx.run.goalId, action.body, options);
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
        postOrchestratorMessage(db, now, ctx.run.goalId, action.body, options, "orchestrator", pendingQuestion);
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
            postOrchestratorMessage(
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
          postOrchestratorMessage(
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

        // Stateful axis: derive write_set + assumptions, detect concurrent state
        // conflicts, and escalate (pause) or warn per policy. Built and threaded
        // BEFORE the evidence-gate transition below so the step_complete
        // transition carries evidence+telemetry+stateDeps in ONE record:
        //  - gated steps record at the evidence gate (~1711), reading the
        //    threaded facet from options.stateDepsByStepRunId;
        //  - non-gated steps record at the downstream advance-site (~2493);
        //  - the conflict-pause early-return records inline (non-gated only;
        //    gated steps already recorded at the evidence gate).
        // Guarded so it can NEVER break completion.
        let conflictPause: { summary: string } | null = null;
        let stateFacet: StateDepsFacet | null = null;
        try {
          const assumptions = extractStepCompleteAssumptions(block);
          const facet = buildStepCompleteStateFacet(db, {
            goalId: ctx.run.goalId,
            sessionId: sessionId ?? "",
            thisStepRunId: ctx.stepRun.id,
            assumptions,
            conflictPolicy: conflictPolicyForGoal(db, ctx.run.goalId),
          });
          stateFacet = facet;
          if (decideConflictResponse(facet.conflict_policy, facet.conflicts.length).pause) {
            const c = facet.conflicts[0];
            conflictPause = { summary: `state conflict: ${c.kind} on ${c.refs.join(", ")}` };
          } else if (facet.conflicts.length > 0) {
            // auto policy → warn-and-proceed: the conflict is recorded on the
            // facet (carried to the step_complete transition); emit a distinct
            // event for surfacing.
            try {
              db.prepare(
                "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
              ).run(
                options.idFactory ? options.idFactory() : crypto.randomUUID(),
                "state.conflict.detected",
                ctx.run.goalId,
                JSON.stringify({ goalId: ctx.run.goalId, stepRunId: ctx.stepRun.id, conflicts: facet.conflicts }),
                now()
              );
            } catch (err) {
              console.error("state.conflict.detected emit failed", err);
            }
          }
        } catch (err) {
          console.error("step_complete state-conflict detection failed", err);
        }
        // Thread the facet onto the eventual step_complete transition (evidence
        // gate for gated steps, advance-site for non-gated). One transition
        // carries it.
        if (stateFacet) {
          options = {
            ...options,
            stateDepsByStepRunId: { ...options.stateDepsByStepRunId, [ctx.stepRun.id]: stateFacet },
          };
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
          emitStepComplete(
            { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
            {
              goalId: ctx.run.goalId,
              workflowRunId: ctx.run.id,
              workflowStepRunId: ctx.stepRun.id,
              evidence: evidence ?? undefined,
              stateDeps: options.stateDepsByStepRunId?.[ctx.stepRun.id] ?? undefined,
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
            publishStaged(options.bus, evStaged);
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
          publishStaged(options.bus, evStaged);
        }

        const finishedAt = now();

        if (conflictPause || goalRequiresHumanReview(db, ctx.run.goalId) || ctx.stepTpl.completionPolicy === "handoff") {
          const scoringParse = StepResultScoringProposal.safeParse(action.scoring);
          const scoring = scoringParse.success ? scoringParse.data : undefined;
          const proposal = extractProposal(responseText);
          db.prepare(
            "UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = ?"
          ).run(
            JSON.stringify({ block: block ?? {}, scoring: scoring ?? null, finishedAt, proposal }),
            ctx.stepRun.id
          );
          // This is an early-return pause: for non-gated steps the downstream
          // step_complete transition is never recorded, so emit the
          // facet-bearing transition here. Gated steps already recorded their
          // facet-bearing transition at the evidence gate above, so emitting
          // here would duplicate it — skip them to keep exactly one.
          if (stateFacet && !execReq) {
            try {
              emitStepComplete(
                { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
                {
                  goalId: ctx.run.goalId,
                  workflowRunId: ctx.run.id,
                  workflowStepRunId: ctx.stepRun.id,
                  stateDeps: stateFacet,
                }
              );
            } catch (err) {
              console.error("emitStepComplete (state pause) failed", err);
            }
          }
          const summary = conflictPause?.summary ?? summarizeScoring(scoring, proposal);
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
        const rejected = await completeStepWithLedger(db, now, ctx, block, options, stagedEvents);
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
        publishStaged(options.bus, stagedEvents);
        // Best-effort: terminate the tmux worker for the completed step session.
        if (sessionId) {
          void this.workerTerminate?.(sessionId);
        }
        const stepResult = buildApprovalStepResult(buildStepResultBuilderDeps(this.broker), db, ctx, action.scoring, finishedAt);
        await this.engine.advanceToNextStep(db, nowWithFirstTimestamp(now, finishedAt), ctx.run.id, {
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
      postOrchestratorMessage(
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
        postOrchestratorMessage(
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
      postOrchestratorMessage(
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
      postOrchestratorMessage(
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
      postOrchestratorMessage(
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
        postOrchestratorMessage(
          db, now, run.goalId, acknowledgment, options
        );
      }
    }
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
    await this.engine.spawnStepAgent(
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
    await this.engine.spawnStepAgent(db, now, { run, stepRun, stepTpl, template, goal }, options);
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
    await completeStepWithLedger(db, now, ctx, stash.block, options, stagedEvents, "drop");
    publishStaged(options.bus, stagedEvents);

    const sessionRow = db
      .prepare("SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1")
      .get(stepRun.id) as { id: string } | undefined;
    if (sessionRow?.id) void this.workerTerminate?.(sessionRow.id);

    const stepResult = buildApprovalStepResult(buildStepResultBuilderDeps(this.broker), db, ctx, stash.scoring ?? undefined, stash.finishedAt);
    await this.engine.advanceToNextStep(db, nowWithFirstTimestamp(now, stash.finishedAt), run.id, {
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
    postOrchestratorMessage(
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
    postOrchestratorMessage(db, now, run.goalId, feedback, options, "user");

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

    postOrchestratorMessage(db, now, ctx.run.goalId, lines.join("\n"), options);
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
      await this.engine.confirmGate(db, now, p.run_id, options);
    }

    // Runs parked at a splitter confirmation checkpoint also resume.
    const pausedSplits = db
      .prepare(
        `SELECT id AS run_id FROM workflow_runs WHERE pending_split_route_json IS NOT NULL${goalId ? " AND goal_id = ?" : ""}`
      )
      .all(...goalParams) as { run_id: string }[];
    for (const p of pausedSplits) {
      await this.engine.confirmSplit(db, now, p.run_id, options);
    }
  }

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

}
