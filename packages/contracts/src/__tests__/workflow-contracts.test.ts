import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CreateGoalRequest,
  CreateContextPackageRequest,
  CreateSessionRequest,
  CreateTaskRequest,
  DomainEventType,
  Goal,
  M8EventType,
  ModelProviderInfo,
  NextOrchestratorDecisionResponse,
  OperatorDescriptor,
  ProposedAction,
  Recommendation,
  RecommendationType,
  Task,
  WorkflowArtifact,
  WorkflowArtifactCreatedEventPayload,
  WorkflowDecisionRecordedEventPayload,
  WorkflowDecisionRequestedEventPayload,
  WorkflowDecisionTrace,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowGuardrailConfig,
  WorkflowGuardrailEvaluatedEventPayload,
  WorkflowGuardrailEvaluation,
  WorkflowLlmCall,
  WorkflowOperatorSelectedEventPayload,
  WorkflowRecommendationAcceptedEventPayload,
  WorkflowRecommendationCreatedEventPayload,
  WorkflowRecommendationRejectedEventPayload,
  WorkflowRun,
  WorkflowRunBlockedEventPayload,
  WorkflowRunCancelledEventPayload,
  WorkflowRunCompletedEventPayload,
  WorkflowRunFailedEventPayload,
  WorkflowRunPausedEventPayload,
  WorkflowRunStartedEventPayload,
  WorkflowStepRun,
  WorkflowStepBlockedEventPayload,
  WorkflowStepCompletedEventPayload,
  WorkflowStepFailedEventPayload,
  WorkflowStepSkippedEventPayload,
  WorkflowStepStartedEventPayload,
  WorkflowTaskDagCreatedEventPayload,
  WorkflowTaskDagUpdatedEventPayload,
  WorkflowTemplate,
  WorkflowTemplateCreatedEventPayload,
  WorkflowTemplateDuplicatedEventPayload,
  WorkflowTemplateUpdatedEventPayload,
  WorkflowUserInputRequestedEventPayload,
  WorkflowUserInputSubmittedEventPayload,
  WorkflowValidationFailedEventPayload,
  WorkflowValidationPassedEventPayload,
  WorkflowValidationRunEventPayload,
  WorkflowValidationSkippedEventPayload,
  WORKFLOW_ARTIFACT_MAX_BODY_BYTES,
  WORKFLOW_EVENT_MAX_PAYLOAD_BYTES,
  WORKFLOW_GUARDRAIL_MAX_CONFIG_BYTES
} from "../index.js";

const now = "2026-01-01T00:00:00.000Z";

function repeat(char: string, count: number): string {
  return char.repeat(count);
}

const step = {
  id: "intake",
  ordinal: 0,
  name: "Intake",
  purpose: "Clarify the goal",
  requiredInputs: [],
  requiredOutputs: ["goal_brief" as const],
  gateType: "human-input" as const,
  recommendedCapabilities: ["planning"],
  validationExpectations: ["Brief is clear"],
  exitCriteria: ["Goal brief exists"],
  recommendedOperatorIds: ["human"]
};

const guardrail = {
  id: "human-approval",
  kind: "approval_required" as const,
  label: "Approval required",
  configJson: { requireApproval: true }
};

const template = {
  id: "orca/engineering",
  name: "Engineering",
  description: "Built-in engineering workflow",
  version: 1,
  isBuiltIn: true,
  isLocked: true,
  steps: [step],
  guardrails: [guardrail],
  createdAt: now,
  updatedAt: now
};

const run = {
  id: "run-1",
  goalId: "goal-1",
  templateId: "orca/engineering",
  templateVersion: 1,
  status: "active" as const,
  currentStepRunId: "step-run-1",
  startedAt: now,
  finishedAt: null,
  blockedReason: null
};

const stepRun = {
  id: "step-run-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepTemplateId: "intake",
  ordinal: 0,
  attempt: 1,
  status: "active" as const,
  startedAt: now,
  finishedAt: null,
  blockedReason: null,
  satisfiedExitCriteria: [],
  outstandingExitCriteria: ["Goal brief exists"]
};

const decision = {
  decisionId: "decision-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-run-1",
  decisionType: "select_operator" as const,
  selectedAction: "select:human",
  reason: "Human input is required",
  influencedBy: [
    {
      kind: "workflow_step" as const,
      id: "intake",
      label: "Intake",
      effect: "required" as const
    }
  ],
  alternativesConsidered: ["agent:shell-manual"],
  confidence: 0.8,
  operatorSelectionJson: {
    operatorId: "human",
    operatorKind: "human" as const,
    reason: "Human input is required",
    requiredCapabilities: ["judgment"],
    alternativesConsidered: ["agent:shell-manual"],
    confidence: 0.8,
    requiresUserApproval: true
  },
  createdAt: now
};

describe("workflow contracts", () => {
  it("parses core M8 entities and endpoint wrappers", () => {
    const artifact = {
      id: "artifact-1",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-run-1",
      type: "goal_brief" as const,
      title: "Goal brief",
      body: "Build the feature",
      source: "user" as const,
      linkedSessionId: null,
      linkedTaskId: null,
      linkedContextPackageId: null,
      createdAt: now
    };

    expect(WorkflowTemplate.parse(template)).toEqual(template);
    expect(WorkflowRun.parse(run)).toEqual(run);
    expect(WorkflowStepRun.parse(stepRun)).toEqual(stepRun);
    expect(WorkflowArtifact.parse(artifact)).toEqual(artifact);
    expect(WorkflowDecisionTrace.parse(decision)).toEqual(decision);
    expect(
      WorkflowGuardrailEvaluation.parse({
        id: "eval-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        guardrailId: "human-approval",
        guardrailKind: "approval_required",
        decisionId: "decision-1",
        result: "require_approval",
        message: "approval required",
        createdAt: now
      })
    ).toBeTruthy();
    expect(
      WorkflowLlmCall.parse({
        id: "call-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        decisionId: "decision-1",
        providerId: "orca/openai",
        providerVersion: "0.1.0",
        model: "gpt-5",
        usageTokensInput: 10,
        usageTokensOutput: 20,
        latencyMs: 50,
        status: "succeeded",
        failureCode: null,
        failureMessage: null,
        createdAt: now
      })
    ).toBeTruthy();
    expect(
      ModelProviderInfo.parse({
        id: "orca/openai",
        displayName: "OpenAI",
        available: true,
        models: [{ id: "gpt-5", displayName: "GPT-5", capabilities: ["reasoning"] }]
      })
    ).toBeTruthy();
    expect(
      OperatorDescriptor.parse({
        id: "human",
        kind: "human",
        displayName: "Human",
        capabilities: ["approval"],
        ready: true,
        supportsRepoEditing: true,
        supportsTerminal: true
      })
    ).toBeTruthy();
    expect(
      NextOrchestratorDecisionResponse.parse({
        decision,
        recommendationIds: ["rec-1"]
      })
    ).toEqual({ decision, recommendationIds: ["rec-1"] });
  });

  it("extends existing M1-M7 contracts only with optional M8 fields", () => {
    expect(
      CreateGoalRequest.parse({
        title: "Goal",
        orchestratorModel: { providerId: "orca/anthropic", modelId: "claude-sonnet-4-6" }
      })
    ).toMatchObject({
      title: "Goal",
      orchestratorModel: { providerId: "orca/anthropic", modelId: "claude-sonnet-4-6" }
    });
    expect(
      Goal.parse({
        id: "goal-1",
        title: "Goal",
        description: "",
        status: "active",
        autonomyLevel: 1,
        orchestratorProvider: "orca/openai",
        orchestratorModel: "gpt-5",
        activeWorkflowRunId: "run-1",
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      })
    ).toBeTruthy();
    expect(
      CreateSessionRequest.parse({
        workspaceId: "ws-1",
        adapterId: "shell-manual",
        workflowStepRunId: "step-run-1"
      })
    ).toMatchObject({ workflowStepRunId: "step-run-1" });
    expect(
      CreateContextPackageRequest.parse({
        adapterId: "shell-manual",
        role: "engineer",
        objective: "Build context",
        workflowStepRunId: "step-run-1"
      })
    ).toMatchObject({ workflowStepRunId: "step-run-1" });
    expect(
      CreateTaskRequest.parse({
        title: "Task",
        role: "engineer",
        workflowStepRunId: "step-run-1"
      })
    ).toMatchObject({ workflowStepRunId: "step-run-1" });
  });

  it("accepts every workflow proposed action and rejects malformed variants", () => {
    const validCases: unknown[] = [
      {
        kind: "advance_workflow_step",
        workflowRunId: "run-1",
        workflowStepRunId: "step-run-1",
        toStepTemplateId: "research"
      },
      {
        kind: "launch_workflow_session",
        workflowStepRunId: "step-run-1",
        operatorId: "agent:shell-manual",
        operatorKind: "agent",
        objective: "Implement the step"
      },
      {
        kind: "complete_workflow_run",
        workflowRunId: "run-1",
        workflowStepRunId: "step-run-1"
      },
      {
        kind: "mark_artifact_satisfied",
        workflowStepRunId: "step-run-1",
        artifactType: "goal_brief"
      },
      {
        kind: "request_user_input",
        workflowStepRunId: "step-run-1",
        question: "What outcome should this optimize for?"
      }
    ];

    for (const input of validCases) {
      expect(ProposedAction.parse(input)).toEqual(input);
    }

    expect(RecommendationType.parse("advance_workflow_step")).toBe(
      "advance_workflow_step"
    );
    expect(() =>
      ProposedAction.parse({
        kind: "launch_workflow_session",
        workflowStepRunId: "step-run-1",
        operatorId: "agent:shell-manual",
        objective: "missing operator kind"
      })
    ).toThrow();
  });

  it("parses content-free workflow events and enforces the 4 KiB payload cap", () => {
    const payloadByType: Record<(typeof WorkflowEventType.options)[number], unknown> = {
      "workflow.template.created": { templateId: "custom/1", version: 1 },
      "workflow.template.updated": { templateId: "custom/1", version: 2 },
      "workflow.template.duplicated": {
        templateId: "custom/2",
        sourceTemplateId: "orca/engineering"
      },
      "workflow.run.started": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        templateId: "orca/engineering",
        templateVersion: 1
      },
      "workflow.run.paused": { goalId: "goal-1", workflowRunId: "run-1" },
      "workflow.run.blocked": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        failureCode: "daemon_restart"
      },
      "workflow.run.completed": { goalId: "goal-1", workflowRunId: "run-1" },
      "workflow.run.failed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        failureCode: "provider_error"
      },
      "workflow.run.cancelled": { goalId: "goal-1", workflowRunId: "run-1" },
      "workflow.step.started": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        stepTemplateId: "intake",
        ordinal: 0
      },
      "workflow.step.completed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        stepTemplateId: "intake"
      },
      "workflow.step.blocked": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1"
      },
      "workflow.step.skipped": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1"
      },
      "workflow.step.failed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        failureCode: "invalid_output"
      },
      "workflow.artifact.created": {
        artifactId: "artifact-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        type: "goal_brief",
        bodyBytes: 128
      },
      "workflow.guardrail.evaluated": {
        guardrailEvaluationId: "eval-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        guardrailId: "approval",
        guardrailKind: "approval_required",
        result: "require_approval"
      },
      "workflow.operator.selected": {
        decisionId: "decision-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        operatorId: "human",
        operatorKind: "human",
        source: "fallback",
        requiresApproval: true
      },
      "workflow.decision.requested": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        stepTemplateId: "intake"
      },
      "workflow.decision.recorded": {
        decisionId: "decision-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        decisionType: "select_operator",
        influencedByCount: 1
      },
      "workflow.user.input.requested": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        recommendationId: "rec-1"
      },
      "workflow.user.input.submitted": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        answerBytes: 32,
        artifactIds: ["artifact-1"],
        satisfiedExitCriteriaCount: 1
      },
      "workflow.recommendation.created": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        type: "launch_workflow_session",
        decisionId: "decision-1"
      },
      "workflow.recommendation.accepted": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        type: "advance_workflow_step"
      },
      "workflow.recommendation.rejected": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        type: "request_user_input"
      },
      "workflow.task.dag.created": {
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        taskIds: ["task-1"],
        count: 1
      },
      "workflow.task.dag.updated": {
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        taskIds: ["task-1"],
        count: 1,
        changedFields: ["status"]
      },
      "workflow.validation.run": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        validationId: "validation-1"
      },
      "workflow.validation.passed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        validationId: "validation-1"
      },
      "workflow.validation.failed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        failureCode: "test_failed"
      },
      "workflow.validation.skipped": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        validationId: "validation-1"
      }
    };

    const parserByType: Record<
      (typeof WorkflowEventType.options)[number],
      z.ZodTypeAny
    > = {
      "workflow.template.created": WorkflowTemplateCreatedEventPayload,
      "workflow.template.updated": WorkflowTemplateUpdatedEventPayload,
      "workflow.template.duplicated": WorkflowTemplateDuplicatedEventPayload,
      "workflow.run.started": WorkflowRunStartedEventPayload,
      "workflow.run.paused": WorkflowRunPausedEventPayload,
      "workflow.run.blocked": WorkflowRunBlockedEventPayload,
      "workflow.run.completed": WorkflowRunCompletedEventPayload,
      "workflow.run.failed": WorkflowRunFailedEventPayload,
      "workflow.run.cancelled": WorkflowRunCancelledEventPayload,
      "workflow.step.started": WorkflowStepStartedEventPayload,
      "workflow.step.completed": WorkflowStepCompletedEventPayload,
      "workflow.step.blocked": WorkflowStepBlockedEventPayload,
      "workflow.step.skipped": WorkflowStepSkippedEventPayload,
      "workflow.step.failed": WorkflowStepFailedEventPayload,
      "workflow.artifact.created": WorkflowArtifactCreatedEventPayload,
      "workflow.guardrail.evaluated": WorkflowGuardrailEvaluatedEventPayload,
      "workflow.operator.selected": WorkflowOperatorSelectedEventPayload,
      "workflow.decision.requested": WorkflowDecisionRequestedEventPayload,
      "workflow.decision.recorded": WorkflowDecisionRecordedEventPayload,
      "workflow.user.input.requested": WorkflowUserInputRequestedEventPayload,
      "workflow.user.input.submitted": WorkflowUserInputSubmittedEventPayload,
      "workflow.recommendation.created": WorkflowRecommendationCreatedEventPayload,
      "workflow.recommendation.accepted": WorkflowRecommendationAcceptedEventPayload,
      "workflow.recommendation.rejected": WorkflowRecommendationRejectedEventPayload,
      "workflow.task.dag.created": WorkflowTaskDagCreatedEventPayload,
      "workflow.task.dag.updated": WorkflowTaskDagUpdatedEventPayload,
      "workflow.validation.run": WorkflowValidationRunEventPayload,
      "workflow.validation.passed": WorkflowValidationPassedEventPayload,
      "workflow.validation.failed": WorkflowValidationFailedEventPayload,
      "workflow.validation.skipped": WorkflowValidationSkippedEventPayload
    };

    for (const type of WorkflowEventType.options) {
      const payload = payloadByType[type];
      expect(WorkflowEvent.parse({ type, payload })).toEqual({ type, payload });
      parserByType[type].parse(payload);
      expect(JSON.stringify(payload).length).toBeLessThanOrEqual(
        WORKFLOW_EVENT_MAX_PAYLOAD_BYTES
      );
      expect(() =>
        WorkflowEvent.parse({
          type,
          payload: { ...(payload as Record<string, unknown>), body: "not allowed" }
        })
      ).toThrow();
    }

    expect(M8EventType.parse("goal.orchestrator_model_changed")).toBe(
      "goal.orchestrator_model_changed"
    );
    expect(DomainEventType.parse("workflow.run.started")).toBe("workflow.run.started");
  });

  it("rejects oversized capped workflow fields", () => {
    expect(() =>
      WorkflowArtifact.parse({
        id: "artifact-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        type: "goal_brief",
        title: "Goal brief",
        body: repeat("x", WORKFLOW_ARTIFACT_MAX_BODY_BYTES + 1),
        source: "user",
        linkedSessionId: null,
        linkedTaskId: null,
        linkedContextPackageId: null,
        createdAt: now
      })
    ).toThrow();

    expect(() =>
      WorkflowGuardrailConfig.parse({
        ...guardrail,
        configJson: { value: repeat("x", WORKFLOW_GUARDRAIL_MAX_CONFIG_BYTES + 1) }
      })
    ).toThrow();

    expect(() =>
      WorkflowTaskDagCreatedEventPayload.parse({
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        taskIds: Array.from({ length: 50 }, (_, i) => `task-${i}-${repeat("x", 100)}`),
        count: 50
      })
    ).toThrow();

    expect(() =>
      WorkflowEvent.parse({
        type: "workflow.task.dag.created",
        payload: {
          workflowRunId: "run-1",
          stepRunId: "step-run-1",
          taskIds: Array.from({ length: 50 }, (_, i) => `task-${i}-${repeat("x", 100)}`),
          count: 50
        }
      })
    ).toThrow();

    expect(() =>
      WorkflowArtifactCreatedEventPayload.parse({
        artifactId: "artifact-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        type: "goal_brief",
        bodyBytes: WORKFLOW_ARTIFACT_MAX_BODY_BYTES + 1
      })
    ).toThrow();
  });

  it("parses workflow-linked task and recommendation rows", () => {
    const task = {
      id: "task-1",
      goalId: "goal-1",
      parentTaskId: null,
      workspaceId: null,
      role: "engineer" as const,
      status: "proposed" as const,
      origin: "generator" as const,
      title: "Implement issue",
      description: "Build the assigned issue",
      acceptanceCriteria: [],
      validationSteps: [],
      dependencies: [],
      sources: [],
      generationId: null,
      workflowStepRunId: "step-run-1",
      fingerprint: "fp-task",
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    const recommendation = {
      id: "rec-1",
      goalId: "goal-1",
      type: "launch_workflow_session" as const,
      status: "proposed" as const,
      source: "deterministic_provider" as const,
      title: "Launch workflow session",
      rationale: "Step is ready for implementation",
      proposedAction: {
        kind: "launch_workflow_session" as const,
        workflowStepRunId: "step-run-1",
        operatorId: "agent:shell-manual",
        operatorKind: "agent" as const,
        objective: "Implement issue"
      },
      confidence: 0.8,
      sources: [],
      relatedTaskId: null,
      relatedSessionId: null,
      relatedContextPackageId: null,
      relatedConflictId: null,
      generationId: null,
      workflowStepRunId: "step-run-1",
      fingerprint: "fp-rec",
      supersededById: null,
      createdAt: now,
      updatedAt: now
    };

    expect(Task.parse(task)).toEqual(task);
    expect(Recommendation.parse(recommendation)).toEqual(recommendation);
  });
});
