import type Database from "better-sqlite3";
import {
  type DomainEvent,
  type ModelProviderId,
  type OperatorKind,
  type WorkflowArtifactType,
  type WorkflowDecisionTrace,
  type WorkflowGuardrailConfig,
  type WorkflowStepTemplate,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import {
  evaluateAllGuardrailsInTx,
  evaluateGuardrail,
  type GuardrailContext,
  type GuardrailResult,
} from "../guardrails/evaluator.js";
import type {
  OperatorSelectionTransportAttempt,
  OperatorSelector,
} from "../operators/selector.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { stepRules, type StepRuleContext } from "../steps/rules/index.js";
import { markStepBlocked, recordExitCriteriaSatisfaction } from "../steps/usecases.js";
import { getTemplateById } from "../templates/projection.js";
import {
  decisionFingerprint,
  getDecisionById,
  linkTransportAttemptDecisionInTx,
  recordDecisionInTx,
} from "../decisions/usecases.js";
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
  constructor(private readonly operatorSelector: Pick<OperatorSelector, "select">) {}

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
    let stepRun = readStepRun(db, run.currentStepRunId);
    if (stepRun.status !== "active") throw new OrchestratorRunNotActiveError(workflowRunId);
    const stepTpl = template.steps.find((step) => step.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorStepNotFoundError(stepRun.id);
    let artifacts = listArtifactsForRun(db, workflowRunId);
    stepRun = applyDeterministicRuleSatisfaction(db, now, stepRun, artifacts);
    const goal = readGoal(db, run.goalId);
    stepRun = applyGoalContextSatisfaction(db, now, stepRun, goal, workflowRunId, options.idFactory);
    artifacts = listArtifactsForRun(db, workflowRunId);
    const outstanding = parseOutstanding(stepRun);
    const missing = missingInputs(stepTpl, artifacts);

    if (missing.length > 0) {
      return this.commitMissingInputDecision(db, now, run.goalId, workflowRunId, stepRun, stepTpl, missing, options);
    }

    if (outstanding.length === 0) {
      const nextStepTpl = template.steps.find((step) => step.ordinal === stepRun.ordinal + 1);
      return this.commitSatisfiedExitDecision(
        db,
        now,
        run.goalId,
        workflowRunId,
        stepRun,
        stepTpl,
        nextStepTpl,
        options
      );
    }

    if (stepTpl.gateType === "human-input") {
      return this.commitUserInputDecision(db, now, run.goalId, workflowRunId, stepRun, stepTpl, outstanding, options);
    }

    const result = await this.operatorSelector.select(db, now, {
      goalId: run.goalId,
      workflowRunId,
      stepRunId: stepRun.id,
      stepName: stepTpl.id,
      stepPurpose: stepTpl.purpose,
      recommendedCapabilities: stepTpl.recommendedCapabilities,
      recommendedOperatorIds: stepTpl.recommendedOperatorIds,
      guardrails: template.guardrails,
      orchestratorProvider: goal.orchestrator_provider,
      orchestratorModel: goal.orchestrator_model,
    });

    const guardCtx: GuardrailContext = {
      goalId: run.goalId,
      workflowRunId,
      stepRunId: stepRun.id,
      stepTemplateId: stepTpl.id,
      candidateAction: {
        kind: "launch_workflow_session",
        operatorId: result.selection.operatorId,
      },
    };
    const guardResults = pureGuardrailResults(template.guardrails, guardCtx);
    const denied = guardResults.find((guardrail) => guardrail.result === "deny");
    const requiresApproval =
      result.selection.requiresUserApproval ||
      guardResults.some((guardrail) => guardrail.result === "require_approval");

    return this.commitOperatorDecision(
      db,
      now,
      {
        goalId: run.goalId,
        workflowRunId,
        stepRun,
        stepTpl,
        guardrails: template.guardrails,
        guardCtx,
        guardResults,
        denied,
        requiresApproval,
        selection: result.selection,
        source: result.source,
        transportAttempt: result.transportAttempt,
      },
      options
    );
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
    outstanding: string[],
    options: RequestNextDecisionOptions
  ): { decision: WorkflowDecisionTrace; recommendationIds: string[] } {
    const stagedEvents: DomainEvent[] = [];
    const rule = stepRules[stepTpl.id];
    const ctx = ruleContext(stepRun, listArtifactsForRun(db, workflowRunId));
    const nextQuestion = rule?.nextQuestion?.(ctx);
    const question = (nextQuestion?.question ?? stepTpl.purpose).slice(0, 1024);
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
          influencedBy: outstanding.map((criterion) => ({
            kind: "workflow_step" as const,
            id: stepTpl.id,
            label: criterion,
            effect: "required" as const,
          })),
          inputFingerprint: decisionFingerprint({
            runId: workflowRunId,
            stepRunId: stepRun.id,
            decisionType: "request_user_input",
            payload: outstanding,
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
