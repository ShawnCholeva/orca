import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  OrchestrationRequest,
  GateEvaluationRequest,
  SplitEvaluationProposal,
  SplitEvaluationRequest,
  StepSkillProposal,
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS,
  validateStepOutput,
  type DomainEvent,
  type OperatorDescriptor,
  type WorkflowDecisionTrace,
  type WorkflowRun as WorkflowRunT,
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
import {
  type StepDispatchCapabilities,
  type RequestNextDecisionOptions,
  type TokenAccumulator,
  OrchestratorRunNotFoundError,
  OrchestratorRunNotActiveError,
  OrchestratorTemplateNotFoundError,
} from "./dispatch-types.js";
import type { OperatorRegistry } from "../operators/registry.js";
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
import { listSplitDecisionsForRun } from "../splitters/projection.js";
import { recordSplitDecision } from "../splitters/usecases.js";
import { loadRunTemplate } from "../runs/run-template.js";
import {
  decisionFingerprint,
  listDecisionsForRun,
  recordDecisionInTx,
} from "../decisions/usecases.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { createRecommendationForWorkflowInTx } from "./workflow-recommendations.js";
import { appendWorkflowEvent } from "../events.js";
import { materializeStepResultActivity } from "../../activities/step-result-activity.js";
import { resolveGateDecisionActivity, pauseForGateDecision, pauseForConfirmation, expireConfirmation, pauseForMarkDoneInTx } from "../../activities/store.js";
import { composeAgentInitialPrompt } from "../../orchestrator-llm/prompts.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import { createStepOutputArtifact } from "./ledger-commit.js";
import { scoreCompletedStepResult } from "./step-result-builder.js";
import { type GoalRow, type StepRunRow, readGoal, readStepRun, preferencesForGoal, OrchestratorStepNotFoundError } from "./db-rows.js";
import {
  stepRunIdsByTemplateId,
  hasActiveUnansweredQuestion,
  readStepOutputAsRecord,
  publishStaged,
  buildStepResultBuilderDeps,
} from "./queries.js";
import { postOrchestratorMessage } from "./orchestrator-message.js";
import { collectPriorStepArtifacts, latestRejectingGate } from "./repair-context.js";
import { resolveStepDispatch, type ResolvedStepDispatch } from "./step-dispatch.js";
import { stepRequiresExecution } from "./requires-execution.js";
import { deriveReadSet } from "../../harness-state/read-set.js";
import { probeWorkspaceForSession } from "../../harness-state/workspace-version.js";
import { conflictPolicyForGoal } from "../../harness-state/conflict-policy.js";
import { emitStepComplete, emitStepLaunch } from "../../harness-transitions/emit.js";
import { latestTransitionCreatedAt } from "../../harness-transitions/usecases.js";
import { listWorkspacesByGoal } from "../../workspaces/projection.js";
import { listMemoryByGoal } from "../../memory/projection.js";
import { listDecisionsByGoal } from "../../decisions/projection.js";
import { getGoalRefinement } from "../../goal-refinements.js";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import {
  evaluateGuardrail,
  evaluateGuardrailRequiresApproval,
  parseBudgetRuleConfig,
} from "../guardrails/evaluator.js";
import { buildGoalCostRollup, buildGoalCostRollupAcross } from "../../harness-state/cost-rollup.js";
import { spawnChildRun, DelegationDepthError } from "../composition/spawn.js";
import { joinChildRun } from "../composition/join.js";
import { realVersionProbe } from "../../harness-state/workspace-version.js";
import { rootRunId, descendantRunIds } from "../composition/store.js";
import { createDecision } from "../../decisions/usecases.js";
import { buildAgentObjective } from "./agent-objective.js";
import { buildStepExecutionInput } from "./step-input.js";
import { assembleWorkspaceContext } from "./workspace-context.js";
import { reconstructTranscript } from "./interview.js";
import { listFeedbackByGoalSince } from "../../recommendations/feedback.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { evaluateGate, issueRefsEqual, GATE_REJECT_CAP } from "./gate-evaluation.js";

export const NULL_ACCUMULATOR: TokenAccumulator = { drain: () => null };

export function goalRequiresHumanReview(db: Database.Database, goalId: string): boolean {
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

export function nowWithFirstTimestamp(now: () => string, fixed: string): () => string {
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

/**
 * Builds the TelemetryFacet for a step_complete transition: drains the session's
 * accrued worker tokens into a CostEntry (null when nothing accrued or model is
 * unpriced/unknown) and records the categorical outcome.
 */
export function buildTelemetry(
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
 * True when the step's persisted result is an evaluation FAILURE (e.g. the
 * orchestrator supplied no scoring). Such a completion has no trustworthy verdict,
 * so its step_complete transition is stamped failed/evaluation_failed and the
 * metrics layer treats it as UNVERIFIED — never a verified pass. Kept a pure read
 * of the step-result the control plane just wrote, so the transition stream stays
 * self-describing (no reach-back from metrics into step-result storage). (#8)
 */
export function stepEvaluationFailed(stepResultJson: string | null): boolean {
  if (!stepResultJson) return false;
  try {
    return (JSON.parse(stepResultJson) as { evaluationStatus?: string }).evaluationStatus === "failed";
  } catch {
    return false;
  }
}

/**
 * Maps the recommendation feedback that arrived *during the current step* to
 * `recommendation_feedback` human-intervention entries for the step_complete
 * transition. Scoped to feedback created since the previous step_complete (the
 * last time feedback was attributed) so each row lands on exactly one step
 * rather than re-stamping the whole recent window on every step_complete. On the
 * first step there is no prior step_complete, so all feedback so far is stamped.
 */
export function recommendationFeedbackInterventions(
  db: Database.Database,
  goalId: string
): TelemetryFacet["human_interventions"] {
  const since = latestTransitionCreatedAt(db, goalId, "step_complete");
  return listFeedbackByGoalSince(db, goalId, since).map((f) => ({
    kind: "recommendation_feedback",
    ref: f.id,
  }));
}

export function resolveShadowAdapterId(goal: GoalRow): ShadowAdapterId {
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

export function resolvedModeEnablesOneShot(mode: ResolvedMode): boolean {
  return mode.mode === "one_shot" || mode.fallbacks.includes("one_shot");
}

export function stepDispatchEnablesOneShot(
  stepDispatch: StepDispatchCapabilities,
  adapterId: string
): boolean {
  try {
    return resolvedModeEnablesOneShot(stepDispatch.resolveMode(adapterId));
  } catch {
    return false;
  }
}

export class DispatchEngine {
  constructor(
    private readonly broker: Pick<OrchestrationTransportBroker, "propose">,
    private readonly operators: Pick<OperatorRegistry, "list">,
    private readonly launcher: WorkflowSessionLauncher,
    private readonly stepDispatch: StepDispatchCapabilities | undefined,
    private readonly workerSpawn: ((input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>) | undefined,
    private readonly workerDeliver: ((sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">) | undefined,
    private readonly otlpAccumulator: TokenAccumulator = NULL_ACCUMULATOR,
    private readonly shadowAsk?: ShadowAsk,
  ) {}

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
        emitStepComplete(
          { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
          {
            goalId: run.goalId,
            workflowRunId: run.id,
            workflowStepRunId: stepRun.id,
            stateDeps: options.stateDepsByStepRunId?.[stepRun.id] ?? undefined,
            refute: options.refuteByStepRunId?.[stepRun.id] ?? undefined,
            telemetry: buildTelemetry(
              this.otlpAccumulator,
              sessionRow?.id,
              stepEvaluationFailed(stepRun.step_result_json) ? "failed" : "succeeded",
              stepEvaluationFailed(stepRun.step_result_json) ? "evaluation_failed" : null,
              null,
              recommendationFeedbackInterventions(db, run.goalId)
            ),
          }
        );
      } catch (err) {
        console.error("emitStepComplete failed", err);
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
  async spawnStepAgent(
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
      priorStepArtifacts: collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.id),
      repairContext: latestRejectingGate(db, ctx.run.id),
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

      // Record the step_launch transition (belief-divergence baseline). This is
      // the bootstrap/advance launch path (first step + post-completion + gate
      // routing); commitAgentStepDecision records it on its own direct-launch
      // path. Without this, steps launched here never capture a launch-time
      // workspace version, so belief-divergence has nothing to compare against.
      this.recordStepLaunchTransition(db, now, ctx.goal, ctx.run, ctx.stepRun, sessionId, options);

      // Run the agent as a headless tmux worker, then submit its objective.
      await this.workerSpawn?.({ sessionId, goalId: ctx.goal.id, adapterId: dispatch.adapterId });
      const delivered = await this.workerDeliver?.(sessionId, objective);
      if (delivered && delivered !== "delivered") {
        postOrchestratorMessage(
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
      postOrchestratorMessage(
        db,
        now,
        ctx.goal.id,
        `Unable to start the step agent (${dispatch.adapterId}): ${err instanceof Error ? err.message : "unknown error"}`,
        options
      );
    }
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
    if (hasActiveUnansweredQuestion(db, stepArtifacts, stepRun.id)) {
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
    const stepRunByStepId = stepRunIdsByTemplateId(db, run.id);
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
      delegatePriorOutputs: this.collectDelegatePriorOutputs(db, run.id, template, artifacts),
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
    createStepOutputArtifact(db, now, ctx, body, options, artifactEvents);
    publishStaged(options.bus, artifactEvents);
    const finishedAt = now();
    const stepResult = await scoreCompletedStepResult(buildStepResultBuilderDeps(this.broker), db, ctx, proposal.output, finishedAt);
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
    publishStaged(options.bus, stagedEvents);
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

    // (c2) budget pre-check (control-plane spend gate). A runaway step otherwise
    // has no spend floor. Over-budget is a hard cap, routed by operating_mode:
    // escalate to the human under human_review (a launch recommendation they can
    // approve), hard-stop the run under automated (no human is watching).
    const budgetReason = this.budgetDenyReason(db, template.guardrails, {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      stepTemplateId: stepTpl.id,
    });
    if (budgetReason) {
      return goalRequiresHumanReview(db, goal.id)
        ? this.commitLaunchRecommendation(db, now, ctx, chosen, objective, options)
        : this.blockRun(db, now, ctx, budgetReason, options);
    }

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
      const { sessionId } = await this.launcher.launch(launchCtx);
      this.recordStepLaunchTransition(db, now, goal, run, stepRun, sessionId, options);
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
    sessionId: string,
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
      // The step's session is launched into its target workspace; probe THAT
      // workspace (not the goal's first-attached one) for its live branch/dirty
      // version — the "state as of launch" belief-divergence compares against at
      // complete (which keys off the same session, so they always agree).
      const workspace = probeWorkspaceForSession(db, sessionId);

      const { read_set, version_deps } = deriveReadSet({
        memory,
        decisions,
        summaries: [],
        refinement,
        workspace,
      });

      emitStepLaunch(
        { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
        {
          goalId: goal.id,
          workflowRunId: run.id,
          workflowStepRunId: stepRun.id,
          stateDeps: {
            read_set,
            write_set: [],
            assumptions: [],
            version_deps,
            conflict_policy: conflictPolicyForGoal(db, goal.id),
            conflicts: [],
          },
        }
      );
    } catch (err) {
      console.error("emitStepLaunch failed", err);
    }
  }

  commitDeterministicStepSelection(
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
    publishStaged(options.bus, stagedEvents);
    return { decision, recommendationIds: [] };
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
      publishStaged(options.bus, stagedEvents);

      if (result.kind === "gate") {
        await this.evaluateAndParkGate(
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

      if (result.kind === "delegate") {
        // Composition entry: spawn a child run (or park for a launch confirm). The
        // parent parks to 'delegating' and the child becomes the active leaf, so the
        // parent run is no longer active — never recurse into requestNextDecision here.
        return await this.enterDelegateNode(
          db,
          now,
          { run, stepRun, stepTpl, template, goal, delegateNodeId: result.nodeId },
          options
        );
      }

      // recursion depth is bounded by the number of consecutive auto-completing intermediate steps (template step count).
      return this.requestNextDecision(db, now, run.id, options);
    }

    // Composition terminal interception (§4.3): a CHILD run reaching its terminal
    // step does NOT yield a goal-level mark_done — it joins back into its parent.
    // joinChildRun maps `writes`, flips parent→active, advances the parent cursor;
    // we then spawn the resumed parent step's session.
    const parentCompositionId = (
      db
        .prepare("SELECT parent_composition_id FROM workflow_runs WHERE id = ?")
        .get(run.id) as { parent_composition_id: string | null } | undefined
    )?.parent_composition_id;
    if (parentCompositionId) {
      // Write step_result_json for the child terminal step BEFORE joining so
      // joinChildRun's step_result_json fallback can find a clean-pass signal
      // even when no evidence-bearing step_complete was emitted (§4.5 non-gated
      // clean-join). Without this write, skill/model-path child terminals that
      // complete without an evidence gate hit the conservative absent-verdict →
      // failed fallback and wrongly propagate failure to the parent.
      const stepResult = options.stepResultByStepRunId?.[stepRun.id];
      if (stepResult) {
        const terminalFinishedAt = options.terminalFinishedAtByStepRunId?.[stepRun.id] ?? now();
        db.prepare("UPDATE workflow_step_runs SET finished_at = ?, step_result_json = ? WHERE id = ?")
          .run(terminalFinishedAt, JSON.stringify(stepResult), stepRun.id);
      }
      return await this.joinChildToParentTerminal(db, now, { run, stepRun, stepTpl, goal }, options);
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
      // The mark-done park commits ATOMICALLY with the recommendation: it is the
      // user's only affordance to finish the run, and surfacing it post-commit
      // left a crash window that stranded runs with an invisible park (live e2e).
      const markDone = pauseForMarkDoneInTx(
        { db, now, idFactory: options.idFactory },
        { goalId: goal.id, workflowRunId: run.id, stepRunId: stepRun.id, recommendationId }
      );
      if (markDone.event) stagedEvents.push(markDone.event);
      return { decision, recommendationIds: [recommendationId] };
    })();
    publishStaged(options.bus, stagedEvents);
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

  // ── Workflow composition (delegate node) ──────────────────────────────────

  /** Merge every prior step_output artifact of the run into one blackboard record. */
  private collectParentOutputs(db: Database.Database, runId: string): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const rows = db
      .prepare(
        "SELECT body FROM workflow_artifacts WHERE workflow_run_id = ? AND type = 'step_output' ORDER BY created_at ASC"
      )
      .all(runId) as Array<{ body: string }>;
    for (const r of rows) {
      try {
        const obj = JSON.parse(r.body);
        if (obj && typeof obj === "object") Object.assign(merged, obj);
      } catch {
        // skip unparseable bodies
      }
    }
    return merged;
  }

  /** I3 baseline: snapshot the parent's active workspace via its most recent step session. */
  private parentWorkspaceSnapshotJson(db: Database.Database, runId: string): string | null {
    const row = db
      .prepare(
        "SELECT s.id AS id FROM sessions s JOIN workflow_step_runs sr ON s.workflow_step_run_id = sr.id WHERE sr.workflow_run_id = ? ORDER BY s.created_at DESC LIMIT 1"
      )
      .get(runId) as { id: string } | undefined;
    if (!row) return null;
    const ws = probeWorkspaceForSession(db, row.id);
    return ws ? JSON.stringify(ws) : null;
  }

  /**
   * Delegate `writes` are materialized on a surrogate delegate step-run (step_template_id
   * = the delegate node id), which is NOT a template step — so the skill/model prior-output
   * loop skips it. Surface those outputs so the parent's next step sees delegate results.
   */
  private collectDelegatePriorOutputs(
    db: Database.Database,
    runId: string,
    template: WorkflowTemplateT,
    artifacts: ReturnType<typeof listArtifactsForRun>
  ): Array<{ stepId: string; stepName: string; output: unknown }> {
    const graph = effectiveGraph(template.graph, template.steps);
    const delegateNames = new Map<string, string>();
    for (const n of graph.nodes) if (n.type === "delegate") delegateNames.set(n.id, n.name ?? n.id);
    if (delegateNames.size === 0) return [];
    const stepRuns = db
      .prepare("SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ?")
      .all(runId) as Array<{ id: string; step_template_id: string }>;
    const surrogateNode = new Map<string, string>();
    for (const sr of stepRuns) if (delegateNames.has(sr.step_template_id)) surrogateNode.set(sr.id, sr.step_template_id);
    if (surrogateNode.size === 0) return [];
    const out: Array<{ stepId: string; stepName: string; output: unknown }> = [];
    for (const a of artifacts) {
      if (a.type !== "step_output" || !a.stepRunId) continue;
      const nodeId = surrogateNode.get(a.stepRunId);
      if (!nodeId) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(a.body);
      } catch {
        parsed = a.body;
      }
      out.push({ stepId: nodeId, stepName: delegateNames.get(nodeId)!, output: parsed });
    }
    return out;
  }

  /**
   * The run cursor reached a `delegate` node (§4.1). Gather the parent blackboard +
   * a workspace snapshot, record an auditable GoalDecision, then either park for a
   * human launch confirm (human_review + requiresLaunchApproval) or spawn the child.
   */
  private async enterDelegateNode(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      delegateNodeId: string;
    },
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, stepRun, stepTpl, template, goal, delegateNodeId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const node = graph.nodes.find((n) => n.id === delegateNodeId && n.type === "delegate");
    if (!node || !node.childTemplateId || node.childTemplateVersion == null) {
      return this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `delegate node missing child template: ${delegateNodeId}`, options);
    }
    const reads = node.reads ?? {};
    const writes = node.writes ?? {};
    const parentOutputs = this.collectParentOutputs(db, run.id);
    const workspaceSnapshotJson = this.parentWorkspaceSnapshotJson(db, run.id);

    // Auditable GoalDecision (HITL-as-durable-state, B/§5.2.5).
    try {
      createDecision(
        { db, bus: options.bus ?? new EventBus(), now },
        {
          goalId: goal.id,
          title: `Delegate to ${node.childTemplateId} v${node.childTemplateVersion}`,
          decisionText: `Spawn child workflow ${node.childTemplateId} v${node.childTemplateVersion} from delegate node ${node.id}. Resolved reads: ${JSON.stringify(reads)}.`,
          rationale: "Workflow composition delegate-node entry.",
        }
      );
    } catch (err) {
      console.error("delegate GoalDecision failed", err);
    }

    // Governed launch: opt-in human confirm before spawning (default off).
    if (node.requiresLaunchApproval && goalRequiresHumanReview(db, goal.id)) {
      return this.parkForDelegateLaunch(db, now, { run, stepRun, stepTpl, goal, node }, options);
    }

    return this.performDelegateSpawn(
      db,
      now,
      { run, sourceStepRun: stepRun, sourceStepTpl: stepTpl, goal, node, reads, writes, parentOutputs, workspaceSnapshotJson },
      options
    );
  }

  /**
   * Park a delegate node for a human launch confirm. The run stays active with the
   * cursor on the delegate node (current_node_kind='delegate'); confirmDelegateLaunch
   * re-enters the spawn. No child is spawned until then.
   */
  private parkForDelegateLaunch(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate; goal: GoalRow; node: WorkflowGraphNode },
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const { run, stepRun, stepTpl, goal, node } = ctx;
    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(db, now, goal.id, run.id, stepRun.id, stepTpl.id, options, stagedEvents);
      return recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "advance_step",
          selectedAction: `delegate:${node.id}:await_launch`,
          reason: `Delegate to ${node.childTemplateId} awaiting human launch confirm`,
          influencedBy: [{ kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" }],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "advance_step",
            payload: `${node.id}:await_launch`,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    publishStaged(options.bus, stagedEvents);
    pauseForConfirmation(
      { db, bus: options.bus ?? new EventBus() },
      { goalId: goal.id, workflowRunId: run.id, stepRunId: stepRun.id, summary: `Approve delegating to ${node.childTemplateId} v${node.childTemplateVersion}?` }
    );
    return { decision, recommendationIds: [] };
  }

  /**
   * Resolve a parked delegate launch confirm: re-enter the spawn from the run's
   * delegate cursor. Idempotent — a no-op unless the run is active on a delegate node.
   */
  async confirmDelegateLaunch(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run || run.status !== "active" || run.currentNodeKind !== "delegate" || !run.currentNodeId) return;
    const template = loadRunTemplate(db, run);
    if (!template) return;
    const goal = readGoal(db, run.goalId);
    const graph = effectiveGraph(template.graph, template.steps);
    const node = graph.nodes.find((n) => n.id === run.currentNodeId && n.type === "delegate");
    if (!node || !node.childTemplateId || node.childTemplateVersion == null) return;

    const sourceRow = db
      .prepare("SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(run.id) as { id: string; step_template_id: string } | undefined;
    if (!sourceRow) return;
    const sourceStepRun = readStepRun(db, sourceRow.id);
    const sourceStepTpl = template.steps.find((s) => s.id === sourceRow.step_template_id) ?? template.steps[0]!;

    expireConfirmation({ db, bus: options.bus ?? new EventBus() }, { stepRunId: sourceRow.id });

    await this.performDelegateSpawn(
      db,
      now,
      {
        run,
        sourceStepRun,
        sourceStepTpl,
        goal,
        node,
        reads: node.reads ?? {},
        writes: node.writes ?? {},
        parentOutputs: this.collectParentOutputs(db, run.id),
        workspaceSnapshotJson: this.parentWorkspaceSnapshotJson(db, run.id),
      },
      options
    );
  }

  /** Spawn the child run, launch its initial step, and record the delegate decision. */
  private async performDelegateSpawn(
    db: Database.Database,
    now: () => string,
    args: {
      run: WorkflowRunT;
      sourceStepRun: StepRunRow;
      sourceStepTpl: WorkflowStepTemplate;
      goal: GoalRow;
      node: WorkflowGraphNode;
      reads: Record<string, string>;
      writes: Record<string, string>;
      parentOutputs: Record<string, unknown>;
      workspaceSnapshotJson: string | null;
    },
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, sourceStepRun, sourceStepTpl, goal, node, reads, writes, parentOutputs, workspaceSnapshotJson } = args;
    const idFactory = options.idFactory ?? randomUUID;

    let childRunId: string;
    try {
      const spawn = spawnChildRun(
        { db, bus: options.bus ?? new EventBus(), now, idFactory },
        {
          goalId: goal.id,
          parentRun: { id: run.id },
          delegateNode: {
            id: node.id,
            childTemplateId: node.childTemplateId!,
            childTemplateVersion: node.childTemplateVersion!,
            reads,
            writes,
          },
          parentOutputs,
          workspaceSnapshotJson,
        }
      );
      childRunId = spawn.childRunId;
    } catch (err) {
      // Depth guard / spawn failure: spawnChildRun's whole transaction rolls back on
      // throw, so the parent is still active at the delegate cursor — block it.
      return this.blockRun(
        db,
        now,
        { run, stepRun: sourceStepRun, stepTpl: sourceStepTpl, goal },
        err instanceof DelegationDepthError ? err.message : `delegate spawn failed: ${(err as Error).message}`,
        options
      );
    }

    await this.spawnChildInitialStep(db, now, childRunId, options);

    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(db, now, goal.id, run.id, sourceStepRun.id, sourceStepTpl.id, options, stagedEvents);
      return recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: sourceStepRun.id,
          decisionType: "advance_step",
          selectedAction: `delegate:${node.childTemplateId}:v${node.childTemplateVersion}`,
          reason: `Delegated to child workflow ${node.childTemplateId} (run ${childRunId}).`,
          influencedBy: [{ kind: "workflow_step", id: sourceStepTpl.id, label: sourceStepTpl.name, effect: "satisfied" }],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: sourceStepRun.id,
            decisionType: "advance_step",
            payload: `delegate:${node.id}:${childRunId}`,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    publishStaged(options.bus, stagedEvents);
    return { decision, recommendationIds: [] };
  }

  /** Launch the child run's initial step session (same path a normal advance uses). */
  private async spawnChildInitialStep(
    db: Database.Database,
    now: () => string,
    childRunId: string,
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const child = getWorkflowRunById(db, childRunId);
    if (!child || child.status !== "active" || !child.currentStepRunId) return;
    const stepRun = readStepRun(db, child.currentStepRunId);
    const template = loadRunTemplate(db, child);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, child.goalId);
    try {
      await this.spawnStepAgent(db, now, { run: child, stepRun, stepTpl, template, goal }, options);
    } catch (err) {
      console.error("spawnChildInitialStep failed", err);
    }
  }

  /**
   * A child run reached its terminal step (§4.3): join it back into the parent
   * instead of yielding a goal-level mark_done. On a clean join, resume the parent
   * by spawning its now-active step; on propagated failure the parent is already
   * blocked. Returns a decision trace for the child's terminal step.
   */
  private async joinChildToParentTerminal(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate; goal: GoalRow },
    options: RequestNextDecisionOptions
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const { run, stepRun, stepTpl, goal } = ctx;
    const idFactory = options.idFactory ?? randomUUID;
    const join = await joinChildRun({ db, bus: options.bus ?? new EventBus(), now, idFactory }, run.id, realVersionProbe);
    if (join.outcome === "joined") {
      await this.resumeParentAfterJoin(db, now, join.parentRunId, options);
    }

    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(db, now, goal.id, run.id, stepRun.id, stepTpl.id, options, stagedEvents);
      return recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "advance_step",
          selectedAction: join.outcome === "joined" ? `join:${join.parentRunId}` : `join_failed:${join.parentRunId}`,
          reason:
            join.outcome === "joined"
              ? "Child workflow terminal joined back to parent."
              : "Child workflow terminal failed; parent blocked.",
          influencedBy: [{ kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" }],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "advance_step",
            payload: `join:${join.outcome}:${join.parentRunId}`,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    publishStaged(options.bus, stagedEvents);
    return { decision, recommendationIds: [] };
  }

  /** After a clean join, spawn the parent's resumed (now-active) step session. */
  private async resumeParentAfterJoin(
    db: Database.Database,
    now: () => string,
    parentRunId: string,
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const parent = getWorkflowRunById(db, parentRunId);
    if (!parent || parent.status !== "active" || !parent.currentStepRunId) return;
    const stepRun = readStepRun(db, parent.currentStepRunId);
    const template = loadRunTemplate(db, parent);
    if (!template) return;
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) return;
    const goal = readGoal(db, parent.goalId);
    try {
      await this.spawnStepAgent(db, now, { run: parent, stepRun, stepTpl, template, goal }, options);
    } catch (err) {
      console.error("resumeParentAfterJoin failed", err);
    }
  }

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
    publishStaged(options.bus, stagedEvents);
    const activityCtx = { db, bus: options.bus ?? new EventBus() };
    pauseForGateDecision(activityCtx, {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      gateName: gateNode.name,
    });
  }

  /**
   * Deterministic splitter routing. When the splitter declares a `branchKey`,
   * the branch is taken directly from the source step's structured output field
   * of that key — no LLM call — provided the value is one of the declared
   * branches. Returns undefined when there is no branchKey or the field is
   * absent/not a declared branch, so the caller falls back to broker evaluation.
   */
  private resolveDeterministicSplit(
    db: Database.Database,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      splitterNode: WorkflowGraphNode;
      branches: string[];
    }
  ): SplitEvaluationProposal | undefined {
    const { run, stepRun, splitterNode, branches } = ctx;
    const branchKey = splitterNode.branchKey;
    if (!branchKey) return undefined;
    const output = readStepOutputAsRecord(db, run.id, stepRun.id);
    const raw = output?.[branchKey];
    if (typeof raw !== "string" || !branches.includes(raw)) return undefined;
    return {
      reasoning: `source step's structured output field "${branchKey}" already names a valid branch`,
      selectedBranch: raw,
      reason: `Routed deterministically from ${stepRun.step_template_id}.${branchKey} = "${raw}".`,
      inputsConsidered: [branchKey],
    };
  }

  /**
   * Reasoning-first directive for the split evaluator. There is no local
   * composeXPrompt for `evaluate_split` (its model-facing prompt is composed by
   * the orchestration-transport broker, not yet wired to an automated transport
   * in production — see service.splitter-routing.test.ts `unwiredBroker`), so
   * this directive is carried on the splitter instructions surfaced in the
   * request payload rather than a hand-written prompt literal.
   */
  private static readonly SPLIT_REASONING_FIRST_DIRECTIVE =
    "Fill `reasoning` first — work through the branches and evidence — then select `selectedBranch`.";

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
    const baseInstructions = (splitterNode.instructions ?? "").slice(
      0,
      WORKFLOW_GATE_MAX_INSTRUCTIONS_CHARS - DispatchEngine.SPLIT_REASONING_FIRST_DIRECTIVE.length - 1
    );
    const instructions = baseInstructions
      ? `${baseInstructions}\n${DispatchEngine.SPLIT_REASONING_FIRST_DIRECTIVE}`
      : DispatchEngine.SPLIT_REASONING_FIRST_DIRECTIVE;
    return SplitEvaluationRequest.parse({
      splitter: {
        nodeId: splitterNode.id,
        name: splitterNode.name,
        instructions,
        branches: splitterNode.branches ?? [],
      },
      goal: { id: goal.id, description: goal.description },
      sourceStepOutput: readStepOutputAsRecord(db, run.id, stepRun.id),
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

    // Deterministic routing first: when the splitter declares a `branchKey`, the
    // branch is read straight from the source step's structured output field of
    // that key. This keeps routing in the deterministic core
    // (FUTURE_ARCHITECTURE: "deterministic code owns lifecycle, routing, gates")
    // and avoids a fragile second model round-trip — the failure mode that
    // silently blocked runs when an upstream step (e.g. Triage's
    // `recommended_tier`) had already emitted the decision.
    let proposal = this.resolveDeterministicSplit(db, { run, stepRun, splitterNode, branches });
    // A deterministic route carries no human judgment — it is read straight from
    // an already-produced (and, in supervised mode, already-confirmed) step output.
    // Such a route is owned by the deterministic core and must NOT raise a second
    // redundant Continue gate; only an orchestrator-judged route is reviewable.
    const wasDeterministic = proposal != null;

    if (!proposal) {
      // Fallback: ask the orchestrator to choose the branch. The broker requires
      // a concrete provider + model; a goal with neither cannot be evaluated, so
      // block with a clear reason rather than passing null into the
      // OrchestrationRequest (which would throw on parse).
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

      // An oversized source output/ledger can exceed the request payload cap. Rather
      // than throw out of the dispatch flow, degrade to a human branch choice (the
      // same terminus as an undecidable split below).
      let request: ReturnType<typeof OrchestrationRequest.parse>;
      try {
        request = OrchestrationRequest.parse({
          kind: "evaluate_split",
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          providerId: goal.orchestrator_provider,
          modelId: goal.orchestrator_model,
          payload: this.buildSplitEvaluationRequest(db, { run, stepRun, goal, splitterNode }),
        });
      } catch {
        this.parkForHumanSplitChoice(
          db,
          now,
          { run, stepRun, stepTpl, goal, graph, splitterNode, branches },
          options
        );
        return;
      }
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
        // Neither deterministic routing nor the orchestrator could decide the
        // branch. Rather than block or silently default, escalate to a HUMAN
        // routing choice: park the run at the splitter and surface the declared
        // branches (labeled by destination step) for the user to pick.
        this.parkForHumanSplitChoice(
          db,
          now,
          { run, stepRun, stepTpl, goal, graph, splitterNode, branches },
          options
        );
        return;
      }
      proposal = result.parsed as SplitEvaluationProposal;
    }

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
      reasoning: proposal.reasoning ?? null,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: proposal.inputsConsidered,
      ledgerVersion: ledger.version,
    });

    if (goalRequiresHumanReview(db, run.goalId) && !wasDeterministic) {
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
      publishStaged(options.bus, stagedEvents);
      const summary = `Routing to "${proposal.selectedBranch}": ${proposal.reason}`;
      const activityCtx = { db, bus: options.bus ?? new EventBus() };
      // pauseForConfirmation always inserts the gate row (finalizing the worker
      // turn first if it is still active), so the confirmation card is created
      // whether or not the source step's activity is already finalized.
      pauseForConfirmation(activityCtx, {
        goalId: goal.id,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        summary,
      });
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
    if (dest.kind === "step" && after && after.status === "active" && after.currentStepRunId) {
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

  private buildGateEvaluationRequest(
    db: Database.Database,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      goal: GoalRow;
      gateNode: WorkflowGraphNode;
      graph: ReturnType<typeof effectiveGraph>;
    }
  ): GateEvaluationRequest {
    const { run, stepRun, goal, gateNode, graph } = ctx;
    const availableOutcomes = (["approved", "rejected"] as const).filter((o) =>
      graph.edges.some((e) => e.from === gateNode.id && e.port === o)
    );
    const priorGateDecisions = listGateDecisionsForRun(db, run.id)
      .map((d) => ({ nodeId: d.nodeId, outcome: d.outcome, reason: d.reason.slice(0, 1024) }))
      .slice(-50);
    const committedLedger = latestCommittedLedger(db, run.id)
      .records.slice(-35)
      .map((r) => ({
        id: r.id.slice(0, 128),
        recordType: r.recordType.slice(0, 64),
        status: r.status.slice(0, 64),
        note: r.note.slice(0, 500),
      }));
    return GateEvaluationRequest.parse({
      gate: { nodeId: gateNode.id, name: gateNode.name, instructions: gateNode.instructions ?? "" },
      goal: { id: goal.id, description: goal.description },
      sourceStepOutput: readStepOutputAsRecord(db, run.id, stepRun.id),
      priorGateDecisions,
      availableOutcomes,
      committedLedger,
    });
  }

  /**
   * Gate = the PEV Verify phase. In human_review (L4) — or when no shadow
   * evaluator is available — parks for a human decideGate (unchanged). In
   * automated (L5), the LLM fills the verdict + issue list; the deterministic
   * core branches, bounds the reject loop (GATE_REJECT_CAP), records the decision
   * with issueRefs (which flow to the closing step via latestRejectingGate ->
   * repairContext), and routes inline (forward on approve, backward on reject).
   */
  private async evaluateAndParkGate(
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
  ): Promise<void> {
    const { run, stepRun, stepTpl, template, goal, gateNodeId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const gateNode = graph.nodes.find((n) => n.id === gateNodeId && n.type === "gate");
    if (!gateNode) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate node not found in graph: ${gateNodeId}`, options);
      return;
    }

    // L4, or no evaluator wired: keep the human-authoritative park (unchanged).
    let adapterId: ShadowAdapterId | null = null;
    if (this.shadowAsk && !goalRequiresHumanReview(db, goal.id)) {
      try {
        adapterId = resolveShadowAdapterId(goal);
      } catch {
        adapterId = null;
      }
    }
    if (!this.shadowAsk || goalRequiresHumanReview(db, goal.id) || !adapterId) {
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    // An oversized source output/ledger can exceed the request payload cap. Rather
    // than throw out of the dispatch flow, degrade to the human park (the same
    // safety terminus as a failed evaluation below).
    let gateRequest: GateEvaluationRequest;
    try {
      gateRequest = this.buildGateEvaluationRequest(db, { run, stepRun, goal, gateNode, graph });
    } catch {
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }
    const proposal = await evaluateGate(this.shadowAsk, {
      goalId: goal.id,
      adapterId,
      request: gateRequest,
      timeoutMs: SHADOW_LLM_TIMEOUT_MS,
    });
    if (!proposal) {
      // Escalate to a human — the same safety terminus as the broker's human_review.
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    // Honest, verification-governed termination (agent-harness.pdf p.31/p.46):
    // stop on an OBJECTIVE non-progress signal — the same unresolved issues recur
    // (stagnation) — or at the hard GATE_REJECT_CAP ceiling; never on model
    // confidence. The block reason carries the enumerated issue evidence.
    if (proposal.outcome === "rejected") {
      const priorRejects = listGateDecisionsForRun(db, run.id).filter(
        (d) => d.nodeId === gateNode.id && d.outcome === "rejected"
      );
      const issues = proposal.issueRefs ?? [];
      const stagnated =
        issues.length > 0 &&
        priorRejects.length > 0 &&
        issueRefsEqual(issues, priorRejects[priorRejects.length - 1]!.issueRefs);
      if (priorRejects.length + 1 >= GATE_REJECT_CAP || stagnated) {
        const detail = issues.join(", ");
        const why = stagnated ? "unresolved issues recurred" : `${priorRejects.length + 1} rejections`;
        this.blockRun(
          db,
          now,
          { run, stepRun, stepTpl, goal },
          `gate "${gateNode.name}" not converging (${why}): ${proposal.reason}${detail ? ` [${detail}]` : ""}`,
          options
        );
        return;
      }
    }

    let dest: Destination;
    try {
      dest = resolveGateNext(graph, gateNode.id, proposal.outcome);
    } catch (e) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate ${gateNode.id} routing failed: ${(e as Error).message}`, options);
      return;
    }
    if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate ${gateNode.id} resolved to an unroutable destination`, options);
      return;
    }

    const ledger = latestCommittedLedger(db, run.id);
    const seq = nextTraversalSeq(db, run.id);
    recordGateDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: gateNode.id,
      traversalSeq: seq,
      outcome: proposal.outcome,
      reason: proposal.reason,
      reasoning: proposal.reasoning ?? null,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: proposal.inputsConsidered,
      issueRefs: proposal.issueRefs ?? [],
      ledgerVersion: ledger.version,
    });

    // Route inline (automated => no Continue). Mirrors evaluateAndParkSplitter's
    // unsupervised tail: route the cursor, then spawn only for a direct step
    // destination — a gate/splitter destination is fully owned by (and, if
    // unsupervised, already launched inside) routeGateDestination's recursion.
    await this.routeGateDestination(
      db,
      now,
      { run, template, goal, sourceStepRunId: stepRun.id },
      { kind: dest.kind, nodeId: dest.nodeId },
      options
    );
    const after = getWorkflowRunById(db, run.id);
    if (dest.kind === "step" && after && after.status === "active" && after.currentStepRunId) {
      const nextStepRun = readStepRun(db, after.currentStepRunId);
      const nextTpl = template.steps.find((s) => s.id === nextStepRun.step_template_id);
      if (nextTpl) {
        await this.spawnStepAgent(db, now, { run: after, stepRun: nextStepRun, stepTpl: nextTpl, template, goal }, options);
      }
    }
  }

  /**
   * Park a run at a splitter that could not be routed (no deterministic branchKey
   * value AND no orchestrator decision) so a human can pick the branch. Surfaces
   * the declared branches labeled by their destination step. No silent default, no
   * dead-end block. The choice is resolved by confirmSplit(runId, branch).
   */
  private parkForHumanSplitChoice(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      goal: GoalRow;
      graph: ReturnType<typeof effectiveGraph>;
      splitterNode: WorkflowGraphNode;
      branches: string[];
    },
    options: RequestNextDecisionOptions
  ): void {
    const { run, stepRun, stepTpl, goal, graph, splitterNode, branches } = ctx;
    const opts: Array<{ branch: string; destNodeId: string; destKind: string; label: string }> = [];
    for (const branch of branches) {
      let dest: Destination;
      try {
        dest = resolveSplitterNext(graph, splitterNode.id, branch);
      } catch {
        continue;
      }
      if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") continue;
      const destNode = graph.nodes.find((n) => n.id === dest.nodeId);
      opts.push({ branch, destNodeId: dest.nodeId, destKind: dest.kind, label: destNode?.name || dest.nodeId });
    }
    if (opts.length === 0) {
      this.blockRun(
        db,
        now,
        { run, stepRun, stepTpl, goal },
        `splitter ${splitterNode.id} has no routable branches`,
        options
      );
      return;
    }
    const prompt = `Couldn't determine routing for "${splitterNode.name || splitterNode.id}" — choose the next step.`;
    const stagedEvents: DomainEvent[] = [];
    db.transaction(() => {
      db.prepare("UPDATE workflow_runs SET pending_split_route_json = ? WHERE id = ?").run(
        JSON.stringify({
          splitterNodeId: splitterNode.id,
          sourceStepRunId: stepRun.id,
          needsHumanChoice: true,
          prompt,
          options: opts,
        }),
        run.id
      );
      // Record a decision so the caller (commitNoopLatestDecision) has a trace and
      // the escalation is auditable: an undecidable split routed to the human.
      recordDecisionInTx(
        db,
        now,
        {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "evaluate_split",
          selectedAction: `splitter:${splitterNode.id}:awaiting_human_choice`,
          reason: prompt,
          influencedBy: [
            { kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" },
          ],
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "evaluate_split",
            payload: `${splitterNode.id}:awaiting_human_choice`,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    publishStaged(options.bus, stagedEvents);
    // Finalize the source worker turn + create a paused checkpoint so the run reads
    // as awaiting input; the frontend renders the choice from run.pendingSplitChoice.
    pauseForConfirmation(
      { db, bus: options.bus ?? new EventBus() },
      { goalId: goal.id, workflowRunId: run.id, stepRunId: stepRun.id, summary: prompt }
    );
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
      reasoning: null,
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
      await this.evaluateAndParkGate(
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
    publishStaged(options.bus, stagedEvents);
  }

  /**
   * User "Continue" action for a supervised gate decision held at a confirmation
   * checkpoint. Reads + clears pending_gate_route_json, expires the confirmation
   * activity, then performs the deferred route. Idempotent: a null/consumed stash
   * is a no-op so a double-Continue cannot double-route. The gate is NOT
   * re-evaluated — the decision is already recorded and deduped by traversal_seq.
   */
  /**
   * After a supervised Continue routes to a step destination, launch that step's
   * worker agent. The confirm paths reach a freshly-created attempt with no
   * operator selected, so they must call spawnStepAgent — requestNextDecision
   * only *selects* the operator on a fresh step and returns without launching,
   * which left the destination step hung "active" with no worker. spawnStepAgent
   * is idempotent on selection, and a gate/splitter destination has a null
   * current step (it re-parks inside routeGateDestination), so this no-ops there.
   * Mirrors the unsupervised inline splitter path and decideGate.
   */
  private async spawnRoutedStep(
    db: Database.Database,
    now: () => string,
    runId: string,
    template: WorkflowTemplateT,
    goal: GoalRow,
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const after = getWorkflowRunById(db, runId);
    if (!after || after.status !== "active" || !after.currentStepRunId) return;
    const nextStepRun = readStepRun(db, after.currentStepRunId);
    const nextTpl = template.steps.find((s) => s.id === nextStepRun.step_template_id);
    if (!nextTpl) return;
    await this.spawnStepAgent(
      db,
      now,
      { run: after, stepRun: nextStepRun, stepTpl: nextTpl, template, goal },
      options
    );
  }

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

    // If the destination is a step, launch its worker agent (a gate destination
    // re-pauses inside routeGateDestination, so this no-ops there).
    await this.spawnRoutedStep(db, now, runId, template, goal, options);
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
    options: RequestNextDecisionOptions = {},
    branch?: string
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) return;
    const stashRow = db
      .prepare("SELECT pending_split_route_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { pending_split_route_json: string | null } | undefined;
    if (!stashRow?.pending_split_route_json) return; // idempotent no-op

    let stash: {
      splitterNodeId: string;
      selectedBranch?: string;
      destNodeId?: string;
      destKind?: "step" | "gate" | "splitter";
      sourceStepRunId: string;
      needsHumanChoice?: boolean;
      options?: Array<{ branch: string; destNodeId: string; destKind: string; label: string }>;
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

    // Human routing-choice path: the run parked because routing was undecidable;
    // the user picks one of the offered branches. An absent/invalid branch is a
    // no-op (the stash is retained so the user can still choose).
    if (stash.needsHumanChoice) {
      if (!branch) return;
      const chosen = (stash.options ?? []).find((o) => o.branch === branch);
      if (!chosen) return;
      const ledger = latestCommittedLedger(db, run.id);
      const seq = nextTraversalSeq(db, run.id);
      recordSplitDecision(db, now, {
        goalId: goal.id,
        workflowRunId: run.id,
        nodeId: stash.splitterNodeId,
        traversalSeq: seq,
        selectedBranch: chosen.branch,
        reason: "human routing choice",
        reasoning: null,
        selectedEdgeTo: chosen.destNodeId,
        inputsConsidered: [],
        ledgerVersion: ledger.version,
      });
      db.prepare("UPDATE workflow_runs SET pending_split_route_json = NULL WHERE id = ?").run(runId);
      expireConfirmation(
        { db, bus: options.bus ?? new EventBus() },
        { stepRunId: stash.sourceStepRunId }
      );
      await this.routeGateDestination(
        db,
        now,
        { run, template, goal, sourceStepRunId: stash.sourceStepRunId },
        { kind: chosen.destKind as "step" | "gate" | "splitter", nodeId: chosen.destNodeId },
        options
      );
      await this.spawnRoutedStep(db, now, runId, template, goal, options);
      return;
    }

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
      { kind: stash.destKind!, nodeId: stash.destNodeId! },
      options
    );

    // If the destination is a step, launch its worker agent (a splitter/gate
    // destination re-parks inside routeGateDestination, so this no-ops there).
    await this.spawnRoutedStep(db, now, runId, template, goal, options);
  }

  /**
   * Returns a `budget_exhausted` deny reason if any `budget_rule` guardrail's cap
   * is reached by the run's accumulated spend, else null. Spend is summed from the
   * step_complete telemetry cost (per-workflow, or per-step-type for that scope) —
   * the deterministic control-plane spend signal; the evaluator owns the compare.
   */
  private budgetDenyReason(
    db: Database.Database,
    guardrails: WorkflowTemplateT["guardrails"],
    scope: { goalId: string; workflowRunId: string; stepRunId: string; stepTemplateId: string }
  ): string | null {
    for (const g of guardrails) {
      if (g.kind !== "budget_rule") continue;
      const cfg = parseBudgetRuleConfig(g.configJson);
      // I2 — a composition's workflow-scope budget spans the whole delegation tree:
      // sum spend across the root run + all descendant child runs, so a child step's
      // cost counts against the parent's cap. The step_type scope stays per-run.
      const rollup =
        cfg.scope === "step_type"
          ? buildGoalCostRollup(db, scope.goalId, scope.workflowRunId, {
              stepTemplateId: scope.stepTemplateId,
            })
          : buildGoalCostRollupAcross(
              db,
              scope.goalId,
              descendantRunIds(db, rootRunId(db, scope.workflowRunId))
            );
      const result = evaluateGuardrail(g, {
        goalId: scope.goalId,
        workflowRunId: scope.workflowRunId,
        stepRunId: scope.stepRunId,
        stepTemplateId: scope.stepTemplateId,
        candidateAction: { kind: "launch_workflow_session", operatorId: "" },
        budgetSpentUsd: rollup?.usd ?? 0,
      });
      if (result.result === "deny") return result.message ?? "budget_exhausted";
    }
    return null;
  }

  blockRun(
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
    publishStaged(options.bus, stagedEvents);
    markWorkflowRunBlocked(
      { db, bus: options.bus ?? new EventBus(), now, idFactory: options.idFactory },
      run.id,
      reason
    );
    return { decision, recommendationIds: [] };
  }

  commitUserInputDecision(
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
    publishStaged(options.bus, stagedEvents);
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
}
