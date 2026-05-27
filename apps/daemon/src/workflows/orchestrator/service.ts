import type Database from "better-sqlite3";
import {
  InterviewTurn,
  OrchestrationRequest,
  StepSkillProposal,
  validateStepOutput,
  type DomainEvent,
  type ModelProviderId,
  type OperatorKind,
  type WorkflowArtifactType,
  type WorkflowDecisionTrace,
  type WorkflowGuardrailConfig,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepRun as WorkflowStepRunT,
  type WorkflowStepTemplate,
  type WorkflowTemplate as WorkflowTemplateT,
} from "@orca/contracts";

import { EventBus } from "../../events.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import {
  evaluateAllGuardrailsInTx,
  evaluateGuardrail,
  type GuardrailContext,
  type GuardrailResult,
} from "../guardrails/evaluator.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type {
  OperatorSelectionTransportAttempt,
  OperatorSelector,
} from "../operators/selector.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { markWorkflowRunBlocked } from "../runs/usecases.js";
import { stepRules, type StepRuleContext } from "../steps/rules/index.js";
import { getWorkflowStepRunById, recordOperatorSelection } from "../steps/projection.js";
import { advanceToNextStep, markStepBlocked, recordExitCriteriaSatisfaction } from "../steps/usecases.js";
import { getTemplateById } from "../templates/projection.js";
import {
  decisionFingerprint,
  getDecisionById,
  linkTransportAttemptDecisionInTx,
  listDecisionsForRun,
  recordDecisionInTx,
} from "../decisions/usecases.js";
import { reconstructTranscript } from "./interview.js";
import { buildStepExecutionInput } from "./step-input.js";
import { createRecommendationForWorkflowInTx } from "./workflow-recommendations.js";

interface GoalRow {
  id: string;
  title: string;
  description: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
}

interface StepRunRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  status: string;
  satisfied_exit_criteria_json: string;
  outstanding_exit_criteria_json: string;
}

export interface RequestNextDecisionOptions {
  bus?: EventBus;
  idFactory?: () => string;
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

function parseOutstanding(row: StepRunRow): string[] {
  const parsed = JSON.parse(row.outstanding_exit_criteria_json) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

function parseSatisfied(row: StepRunRow): string[] {
  const parsed = JSON.parse(row.satisfied_exit_criteria_json) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

function ruleContext(
  stepRun: StepRunRow,
  artifacts: ReturnType<typeof listArtifactsForRun>
): StepRuleContext {
  return {
    goalId: stepRun.goal_id,
    workflowRunId: stepRun.workflow_run_id,
    stepRunId: stepRun.id,
    artifacts,
    satisfiedExitCriteria: parseSatisfied(stepRun),
    outstandingExitCriteria: parseOutstanding(stepRun),
  };
}

function latestSessionSummarySignal(
  db: Database.Database,
  stepRunId: string
): {
  sessionId: string;
  sessionStatus: string;
  headline: string;
  summaryText: string;
} | null {
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.status AS session_status,
              COALESCE(ss.headline, '') AS headline,
              COALESCE(SUBSTR(ss.summary_text, 1, 2048), '') AS summary_text
         FROM sessions s
         LEFT JOIN session_summaries ss
           ON ss.id = (
             SELECT id FROM session_summaries
              WHERE session_id = s.id
              ORDER BY created_at DESC, id DESC
              LIMIT 1
           )
        WHERE s.workflow_step_run_id = ?
        ORDER BY COALESCE(ss.created_at, s.exited_at, s.started_at, s.created_at) DESC, s.id DESC
        LIMIT 1`
    )
    .get(stepRunId) as
    | {
        session_id: string;
        session_status: string;
        headline: string;
        summary_text: string;
      }
    | undefined;
  return row
    ? {
        sessionId: row.session_id,
        sessionStatus: row.session_status,
        headline: row.headline,
        summaryText: row.summary_text,
      }
    : null;
}

function applyDeterministicRuleSatisfaction(
  db: Database.Database,
  now: () => string,
  stepRun: StepRunRow,
  artifacts: ReturnType<typeof listArtifactsForRun>
): StepRunRow {
  const rule = stepRules[stepRun.step_template_id];
  if (!rule) return stepRun;

  const ctx = ruleContext(stepRun, artifacts);
  const satisfied = new Set<string>();
  for (const artifact of artifacts) {
    for (const criterion of rule.evaluateArtifactSatisfies?.(artifact, ctx) ?? []) {
      satisfied.add(criterion);
    }
  }

  const summary = latestSessionSummarySignal(db, stepRun.id);
  if (summary) {
    for (const criterion of rule.evaluateSessionSummarySatisfies?.(summary, ctx) ?? []) {
      satisfied.add(criterion);
    }
  }

  if (satisfied.size === 0) return stepRun;
  recordExitCriteriaSatisfaction(db, now, stepRun.id, Array.from(satisfied));
  return readStepRun(db, stepRun.id);
}

function applyGoalContextSatisfaction(
  db: Database.Database,
  now: () => string,
  stepRun: StepRunRow,
  goal: GoalRow,
  workflowRunId: string,
  idFactory?: () => string
): StepRunRow {
  const rule = stepRules[stepRun.step_template_id];
  if (!rule?.evaluateGoalContextSatisfies) return stepRun;

  const ctx = ruleContext(stepRun, listArtifactsForRun(db, workflowRunId));
  const results = rule.evaluateGoalContextSatisfies(
    { title: goal.title, description: goal.description },
    ctx
  );
  if (results.length === 0) return stepRun;

  const satisfied: string[] = [];
  for (const item of results) {
    if (item.artifact) {
      createArtifact(
        db,
        now,
        {
          goalId: stepRun.goal_id,
          workflowRunId,
          stepRunId: stepRun.id,
          type: item.artifact.type,
          title: item.artifact.title,
          body: item.artifact.body,
          source: "orchestrator",
        },
        idFactory
      );
    }
    satisfied.push(item.criterion);
  }
  recordExitCriteriaSatisfaction(db, now, stepRun.id, satisfied);
  return readStepRun(db, stepRun.id);
}

function missingInputs(
  step: WorkflowStepTemplate,
  artifacts: ReturnType<typeof listArtifactsForRun>
): WorkflowArtifactType[] {
  return step.requiredInputs.filter(
    (type) => !artifacts.some((artifact) => artifact.type === type)
  );
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

function pureGuardrailResults(
  guardrails: WorkflowGuardrailConfig[],
  ctx: GuardrailContext
): GuardrailResult[] {
  return guardrails.map((guardrail) => evaluateGuardrail(guardrail, ctx));
}

export class OrchestratorService {
  constructor(
    private readonly operatorSelector: Pick<OperatorSelector, "select">,
    private readonly broker: Pick<OrchestrationTransportBroker, "propose">,
    private readonly operators: Pick<OperatorRegistry, "list">
  ) {}

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

    // (3) select a model operator once.
    const sel = getWorkflowStepRunById(db, stepRun.id);
    if (!sel || !sel.selectedOperatorId) {
      return this.commitOperatorSelectionForSkill(db, now, ctx, options);
    }
    if (!sel.selectedProviderId || !sel.selectedModelId) {
      return this.blockRun(db, now, ctx, "no ready model operator", options);
    }

    // (4) run the skill turn.
    const transcript = reconstructTranscript(stepArtifacts);
    const stepRunByStepId = this.stepRunIdsByTemplateId(db, run.id);
    const input = buildStepExecutionInput({
      goal: { id: goal.id, description: goal.description },
      steps: template.steps,
      currentStep: stepTpl,
      artifacts,
      transcript,
      stepRunByStepId,
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

  private async commitOperatorSelectionForSkill(
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
    const result = await this.operatorSelector.select(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      stepName: stepTpl.id,
      stepPurpose: stepTpl.instructions.slice(0, 1024),
      recommendedCapabilities: [],
      recommendedOperatorIds: [],
      guardrails: template.guardrails,
      orchestratorProvider: goal.orchestrator_provider,
      orchestratorModel: goal.orchestrator_model,
      allowedKinds: ["model"],
    });

    const descriptors = await this.operators.list(goal.id);
    const chosen = descriptors.find((d) => d.id === result.selection.operatorId);
    if (!chosen || chosen.kind !== "model" || !chosen.providerId || !chosen.modelId) {
      return this.blockRun(db, now, ctx, "no ready model operator", options);
    }
    const providerId = chosen.providerId;
    const modelId = chosen.modelId;

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
          selectedAction: `select:${chosen.id}`,
          reason: result.selection.reason,
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "preferred",
            },
            {
              kind: "operator_readiness",
              id: chosen.id,
              label: chosen.id,
              effect: "satisfied",
            },
          ],
          alternativesConsidered: result.selection.alternativesConsidered,
          confidence: result.selection.confidence,
          operatorSelection: result.selection,
          inputFingerprint: decisionFingerprint({
            runId: run.id,
            stepRunId: stepRun.id,
            decisionType: "select_operator",
            payload: { operatorId: chosen.id, source: result.source },
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      recordOperatorSelection(db, stepRun.id, {
        operatorId: chosen.id,
        providerId,
        modelId,
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
            operatorId: chosen.id,
            operatorKind: chosen.kind,
            source: result.source,
            requiresApproval: result.selection.requiresUserApproval,
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
      advanceToNextStep(db, now, stepRun.id, {
        idFactory: options.idFactory,
        stagedEvents,
      });
      this.publish(options.bus, stagedEvents);
      // recursion depth is bounded by the number of consecutive auto-completing intermediate steps (template step count).
      return this.requestNextDecision(db, now, run.id, options);
    }

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

  private commitMissingInputDecision(
    db: Database.Database,
    now: () => string,
    goalId: string,
    workflowRunId: string,
    stepRun: StepRunRow,
    stepTpl: WorkflowStepTemplate,
    missing: WorkflowArtifactType[],
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const stagedEvents: DomainEvent[] = [];
    const decision = db.transaction(() => {
      this.appendDecisionRequested(db, now, goalId, workflowRunId, stepRun.id, stepTpl.id, options, stagedEvents);
      return recordDecisionInTx(
        db,
        now,
        {
          goalId,
          workflowRunId,
          stepRunId: stepRun.id,
          decisionType: "request_artifact",
          selectedAction: `request:${missing[0]}`,
          reason: `Step requires inputs: ${missing.join(", ")}`,
          influencedBy: missing.map((type) => ({
            kind: "artifact" as const,
            id: type,
            label: type,
            effect: "missing" as const,
          })),
          inputFingerprint: decisionFingerprint({
            runId: workflowRunId,
            stepRunId: stepRun.id,
            decisionType: "request_artifact",
            payload: missing,
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
    })();
    this.publish(options.bus, stagedEvents);
    return { decision, recommendationIds: [] };
  }

  private commitSatisfiedExitDecision(
    db: Database.Database,
    now: () => string,
    goalId: string,
    workflowRunId: string,
    stepRun: StepRunRow,
    stepTpl: WorkflowStepTemplate,
    nextStepTpl: WorkflowStepTemplate | undefined,
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const stagedEvents: DomainEvent[] = [];
    const output = db.transaction(() => {
      this.appendDecisionRequested(db, now, goalId, workflowRunId, stepRun.id, stepTpl.id, options, stagedEvents);
      const completing = nextStepTpl === undefined;
      const decision = recordDecisionInTx(
        db,
        now,
        {
          goalId,
          workflowRunId,
          stepRunId: stepRun.id,
          decisionType: completing ? "mark_run_complete" : "advance_step",
          selectedAction: completing
            ? "recommend_complete_run"
            : `recommend_advance:${nextStepTpl.id}`,
          reason: completing
            ? "Final step criteria satisfied; user approval required before completing the run"
            : "All exit criteria satisfied; user approval required before advancing",
          influencedBy: [
            {
              kind: "workflow_step",
              id: stepTpl.id,
              label: stepTpl.name,
              effect: "satisfied",
            },
          ],
          inputFingerprint: decisionFingerprint({
            runId: workflowRunId,
            stepRunId: stepRun.id,
            decisionType: completing ? "mark_run_complete" : "advance_step",
            payload: nextStepTpl?.id ?? "complete",
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
          type: completing ? "complete_workflow_run" : "advance_workflow_step",
          proposedAction: completing
            ? { kind: "complete_workflow_run", workflowRunId, workflowStepRunId: stepRun.id }
            : {
                kind: "advance_workflow_step",
                workflowRunId,
                workflowStepRunId: stepRun.id,
                toStepTemplateId: nextStepTpl.id,
              },
          rationale: completing
            ? "Final step criteria are satisfied; approve to complete the workflow run."
            : "All exit criteria satisfied; approve to advance to the next workflow step.",
          decisionId: decision.decisionId,
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      return { decision, recommendationIds: [recommendationId] };
    })();
    this.publish(options.bus, stagedEvents);
    return output;
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

  private commitOperatorDecision(
    db: Database.Database,
    now: () => string,
    args: {
      goalId: string;
      workflowRunId: string;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      guardrails: WorkflowGuardrailConfig[];
      guardCtx: GuardrailContext;
      guardResults: GuardrailResult[];
      denied: GuardrailResult | undefined;
      requiresApproval: boolean;
      selection: {
        operatorId: string;
        operatorKind: OperatorKind;
        reason: string;
        requiredCapabilities: string[];
        alternativesConsidered: string[];
        confidence: number;
        requiresUserApproval: boolean;
      };
      source: "llm" | "fallback";
      transportAttempt?: OperatorSelectionTransportAttempt;
    },
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const stagedEvents: DomainEvent[] = [];
    const output = db.transaction(() => {
      this.appendDecisionRequested(
        db,
        now,
        args.goalId,
        args.workflowRunId,
        args.stepRun.id,
        args.stepTpl.id,
        options,
        stagedEvents
      );

      if (args.denied) {
        const decision = recordDecisionInTx(
          db,
          now,
          {
            goalId: args.goalId,
            workflowRunId: args.workflowRunId,
            stepRunId: args.stepRun.id,
            decisionType: "block_run",
            selectedAction: `block:${args.denied.guardrailId}`,
            reason: args.denied.message ?? "guardrail denied",
            influencedBy: [
              {
                kind: "guardrail",
                id: args.denied.guardrailId,
                label: args.denied.kind,
                effect: "blocked",
              },
            ],
            operatorSelection: args.selection,
            inputFingerprint: decisionFingerprint({
              runId: args.workflowRunId,
              stepRunId: args.stepRun.id,
              decisionType: "block_run",
              payload: args.denied.guardrailId,
            }),
          },
          { idFactory: options.idFactory, stagedEvents }
        );
        evaluateAllGuardrailsInTx(db, now, args.guardrails, args.guardCtx, decision.decisionId, {
          idFactory: options.idFactory,
          stagedEvents,
        });
        markStepBlocked(
          db,
          now,
          args.stepRun.id,
          `Guardrail ${args.denied.guardrailId} denied selected operator`,
          { idFactory: options.idFactory, stagedEvents }
        );
        return { decision, recommendationIds: [] };
      }

      const decision = recordDecisionInTx(
        db,
        now,
        {
          goalId: args.goalId,
          workflowRunId: args.workflowRunId,
          stepRunId: args.stepRun.id,
          decisionType: "select_operator",
          selectedAction: `select:${args.selection.operatorId}`,
          reason: args.selection.reason,
          influencedBy: [
            {
              kind: "workflow_step",
              id: args.stepTpl.id,
              label: args.stepTpl.name,
              effect: "preferred",
            },
            {
              kind: "operator_readiness",
              id: args.selection.operatorId,
              label: args.selection.operatorId,
              effect: "satisfied",
            },
            ...args.guardResults
              .filter((guardrail) => guardrail.result === "require_approval")
              .map((guardrail) => ({
                kind: "guardrail" as const,
                id: guardrail.guardrailId,
                label: guardrail.kind,
                effect: "required" as const,
              })),
          ],
          alternativesConsidered: args.selection.alternativesConsidered,
          confidence: args.selection.confidence,
          operatorSelection: args.selection,
          inputFingerprint: decisionFingerprint({
            runId: args.workflowRunId,
            stepRunId: args.stepRun.id,
            decisionType: "select_operator",
            payload: { operatorId: args.selection.operatorId, source: args.source },
          }),
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      if (args.transportAttempt) {
        linkTransportAttemptDecisionInTx(db, {
          attemptId: args.transportAttempt.attemptId,
          decisionId: decision.decisionId,
          goalId: args.goalId,
          workflowRunId: args.workflowRunId,
          stepRunId: args.stepRun.id,
        });
      }
      const decisionWithLinks = getDecisionById(db, decision.decisionId) ?? decision;
      evaluateAllGuardrailsInTx(db, now, args.guardrails, args.guardCtx, decision.decisionId, {
        idFactory: options.idFactory,
        stagedEvents,
      });
      stagedEvents.push(
        appendWorkflowEvent(
          db,
          "workflow.operator.selected",
          {
            decisionId: decision.decisionId,
            goalId: args.goalId,
            workflowRunId: args.workflowRunId,
            stepRunId: args.stepRun.id,
            operatorId: args.selection.operatorId,
            operatorKind: args.selection.operatorKind,
            source: args.source,
            requiresApproval: args.requiresApproval,
          },
          now(),
          options.idFactory
        )
      );
      const recommendationId = createRecommendationForWorkflowInTx(
        db,
        now,
        {
          goalId: args.goalId,
          workflowRunId: args.workflowRunId,
          stepRunId: args.stepRun.id,
          type: "launch_workflow_session",
          proposedAction: {
            kind: "launch_workflow_session",
            workflowStepRunId: args.stepRun.id,
            operatorId: args.selection.operatorId,
            operatorKind: args.selection.operatorKind,
            objective: args.stepTpl.purpose,
          },
          rationale: args.selection.reason,
          decisionId: decision.decisionId,
        },
        { idFactory: options.idFactory, stagedEvents }
      );
      return { decision: decisionWithLinks, recommendationIds: [recommendationId] };
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
