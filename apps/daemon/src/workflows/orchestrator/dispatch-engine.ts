import type Database from "better-sqlite3";
import {
  OrchestrationRequest,
  SplitEvaluationProposal,
  SplitEvaluationRequest,
  StepSkillProposal,
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
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
import { resolveGateDecisionActivity, pauseForGateDecision, pauseForConfirmation, openOrUpdateLive, expireConfirmation } from "../../activities/store.js";
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
import { evaluateGuardrailRequiresApproval } from "../guardrails/evaluator.js";
import { buildAgentObjective } from "./agent-objective.js";
import { buildStepExecutionInput } from "./step-input.js";
import { assembleWorkspaceContext } from "./workspace-context.js";
import { reconstructTranscript } from "./interview.js";
import { listFeedbackByGoalSince } from "../../recommendations/feedback.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";

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
      publishStaged(options.bus, stagedEvents);
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
    publishStaged(options.bus, stagedEvents);
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
