import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CreateGoalRequest,
  CreateContextPackageRequest,
  CreateSessionRequest,
  CreateTaskRequest,
  DomainEventType,
  getModelProviderDisplayName,
  Goal,
  GetOrchestrationWorkerResponse,
  HumanReviewPayload,
  ListOrchestrationAttemptsResponse,
  ListOrchestrationWorkersResponse,
  M8EventType,
  M9EventType,
  ModelProviderInfo,
  NextOrchestratorDecisionResponse,
  OperatorDescriptor,
  OrchestrationDecisionKind,
  OrchestrationProposalEnvelope,
  OrchestrationRequest,
  OrchestrationTransport,
  OrchestrationTransportAttempt,
  OrchestrationTransportAttemptStatus,
  OrchestrationTransportFailureReason,
  OrchestrationWorkerDetail,
  OrchestrationWorkerState,
  ProposedAction,
  Recommendation,
  RecommendationType,
  StepAgentChoice,
  SubmitHumanReviewDecisionRequest,
  Task,
  WorkflowArtifact,
  WorkflowArtifactCreatedEventPayload,
  WorkflowDecisionRecordedEventPayload,
  WorkflowDecisionRequestedEventPayload,
  WorkflowDecisionTrace,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGuardrailConfig,
  WorkflowGuardrailEvaluatedEventPayload,
  WorkflowGuardrailEvaluation,
  WorkflowHumanReviewRequestedEventPayload,
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
  WorkflowStepTemplate,
  WorkflowTaskDagCreatedEventPayload,
  WorkflowTaskDagUpdatedEventPayload,
  WorkflowTemplate,
  WorkflowTemplateCreatedEventPayload,
  WorkflowTemplateDuplicatedEventPayload,
  WorkflowTemplateUpdatedEventPayload,
  WorkflowTransportAttemptFinishedEventPayload,
  WorkflowTransportAttemptStartedEventPayload,
  WorkflowTransportFallbackEventPayload,
  WorkflowUserInputRequestedEventPayload,
  WorkflowUserInputSubmittedEventPayload,
  WorkflowValidationFailedEventPayload,
  WorkflowValidationPassedEventPayload,
  WorkflowValidationRunEventPayload,
  WorkflowValidationSkippedEventPayload,
  WorkflowWorkerStateChangedEventPayload,
  WORKFLOW_ARTIFACT_MAX_BODY_BYTES,
  WORKFLOW_EVENT_MAX_PAYLOAD_BYTES,
  WORKFLOW_GUARDRAIL_MAX_CONFIG_BYTES,
  OrchestratorAction,
  CreateWorkflowTemplateRequest,
} from "../index.js";
import {
  StepResultScoringProposal,
  StepResultScoringRequest,
  WorkflowStepResult,
} from "../workflows/index.js";

const now = "2026-01-01T00:00:00.000Z";

function repeat(char: string, count: number): string {
  return char.repeat(count);
}

const step = {
  id: "intake",
  ordinal: 0,
  name: "Intake",
  instructions: "Clarify the goal and produce a goal brief.",
  outputSchema: [{ key: "goal_brief", type: "string" as const, required: true }],
  agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }]
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
  selectedOperatorId: null,
  selectedProviderId: null,
  selectedModelId: null,
  operatorSelectedAt: null,
  stepResult: null
};

const scoredResult = {
  stepId: "step-run-1",
  stepStatus: "completed",
  evaluationStatus: "scored",
  successScore: 0.92,
  quality: {
    outputCompleteness: 0.95,
    outputCorrectness: 0.9,
    instructionAdherence: 0.88,
    downstreamReadiness: 0.91,
    riskLevel: 0.12
  },
  performance: {
    durationSeconds: 42,
    retries: 1
  },
  outcome: {
    reason: "Output satisfies the step instructions and is ready for the next step.",
    producedArtifactsCount: 1,
    blockingIssuesCount: 0,
    warningsCount: 1,
    handoffReady: true
  }
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
  alternativesConsidered: ["agent:claude-code"],
  confidence: 0.8,
  operatorSelectionJson: {
    operatorId: "human",
    operatorKind: "human" as const,
    reason: "Human input is required",
    requiredCapabilities: ["judgment"],
    alternativesConsidered: ["agent:claude-code"],
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

    expect(WorkflowTemplate.parse(template)).toMatchObject(template);
    expect(WorkflowRun.parse(run)).toEqual(run);
    expect(WorkflowStepRun.parse(stepRun)).toEqual(stepRun);
    expect(
      WorkflowStepRun.parse({
        ...stepRun,
        status: "passed",
        finishedAt: now,
        stepResult: scoredResult
      })
    ).toMatchObject({ stepResult: scoredResult });
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

  it("parses M9 transport, worker, attempt, proposal, and human-review contracts", () => {
    expect(OrchestrationTransport.options).toEqual([
      "one_shot",
      "hidden_interactive",
      "human_review"
    ]);
    expect(OrchestrationDecisionKind.options).toContain("select_operator");
    expect(OrchestrationWorkerState.options).toEqual([
      "starting",
      "ready",
      "awaiting_input",
      "producing_decision",
      "hung",
      "auth_required",
      "failed",
      "stopped"
    ]);
    expect(OrchestrationTransportFailureReason.options).toContain(
      "interactive_output_invalid"
    );
    expect(OrchestrationTransportAttemptStatus.options).toEqual([
      "pending",
      "running",
      "succeeded",
      "rejected",
      "failed",
      "fallback"
    ]);

    const proposal = {
      orcaProposalVersion: 1,
      kind: "select_operator" as const,
      payload: decision.operatorSelectionJson
    };
    expect(OrchestrationProposalEnvelope.parse(proposal)).toEqual(proposal);
    expect(() =>
      OrchestrationProposalEnvelope.parse({
        orcaProposalVersion: 2,
        kind: "select_operator",
        payload: {}
      })
    ).toThrow();

    const request = {
      kind: "select_operator" as const,
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-run-1",
      providerId: "orca/openai" as const,
      modelId: "gpt-5",
      attemptId: "attempt-1",
      payload: { readyOperatorIds: ["human"] }
    };
    expect(OrchestrationRequest.parse(request)).toEqual(request);

    const attempt = {
      id: "attempt-1",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-run-1",
      kind: "select_operator" as const,
      providerId: "orca/openai" as const,
      modelId: "gpt-5",
      transport: "one_shot" as const,
      status: "failed" as const,
      failureReason: "one_shot_parse_failed" as const,
      failureMessage: "invalid envelope",
      diagnostics: "redacted diagnostic summary",
      workerId: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now
    };
    expect(OrchestrationTransportAttempt.parse(attempt)).toEqual(attempt);
    expect(ListOrchestrationAttemptsResponse.parse({ attempts: [attempt] })).toEqual({
      attempts: [attempt]
    });

    const worker = {
      id: "worker-1",
      providerId: "orca/openai" as const,
      modelId: "gpt-5",
      state: "ready" as const,
      currentGoalId: "goal-1",
      currentWorkflowRunId: "run-1",
      currentAttemptId: "attempt-2",
      failureReason: null,
      failureMessage: null,
      healthCheckedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const workerDetail = {
      ...worker,
      hookCapabilities: {
        providerId: "orca/openai" as const,
        supportsPromptHooks: true,
        supportsStopHooks: true,
        supportsStateHooks: false,
        detectedAt: now
      },
      hookTraces: [
        {
          id: "trace-1",
          workerId: "worker-1",
          hookName: "prompt",
          status: "succeeded" as const,
          summary: "hook accepted redacted payload",
          startedAt: now,
          finishedAt: now
        }
      ],
      outputTail: "redacted output tail"
    };
    expect(OrchestrationWorkerDetail.parse(workerDetail)).toEqual(workerDetail);
    expect(ListOrchestrationWorkersResponse.parse({ workers: [worker] })).toEqual({
      workers: [worker]
    });
    expect(GetOrchestrationWorkerResponse.parse({ worker: workerDetail })).toEqual({
      worker: workerDetail
    });

    const humanReview = {
      id: "review-1",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-run-1",
      attemptId: "attempt-3",
      kind: "select_operator" as const,
      providerId: "orca/openai" as const,
      modelId: "gpt-5",
      title: "Choose an operator",
      summary: "Automated transports could not produce a valid proposal.",
      choices: [
        {
          id: "human",
          label: "Human",
          description: "Continue with explicit human supervision.",
          proposal
        }
      ],
      createdAt: now
    };
    const pendingAttempt = {
      ...attempt,
      id: "attempt-3",
      transport: "human_review" as const,
      status: "pending" as const,
      failureReason: null,
      failureMessage: null,
      diagnostics: null,
      humanReview,
    };
    expect(HumanReviewPayload.parse(humanReview)).toEqual(humanReview);
    expect(OrchestrationTransportAttempt.parse(pendingAttempt)).toEqual(pendingAttempt);
    expect(
      SubmitHumanReviewDecisionRequest.parse({
        choiceId: "human",
        proposal
      })
    ).toEqual({ choiceId: "human", proposal });
  });

  it("maps model provider ids to stable product display names", () => {
    expect(getModelProviderDisplayName("orca/anthropic")).toBe("Claude");
    expect(getModelProviderDisplayName("orca/openai")).toBe("OpenAI");
    expect(getModelProviderDisplayName("orca/google")).toBe("Google");
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
        adapterId: "claude-code",
        workflowStepRunId: "step-run-1"
      })
    ).toMatchObject({ workflowStepRunId: "step-run-1" });
    expect(
      CreateContextPackageRequest.parse({
        adapterId: "claude-code",
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
        operatorId: "agent:claude-code",
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
        operatorId: "agent:claude-code",
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
      },
      "workflow.transport.attempt_started": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        attemptId: "attempt-1",
        providerId: "orca/openai",
        transport: "one_shot",
        status: "running"
      },
      "workflow.transport.attempt_finished": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        attemptId: "attempt-1",
        providerId: "orca/openai",
        transport: "one_shot",
        status: "failed",
        failureReason: "one_shot_parse_failed"
      },
      "workflow.transport.fallback": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        attemptId: "attempt-1",
        providerId: "orca/openai",
        transport: "one_shot",
        status: "fallback",
        failureReason: "one_shot_parse_failed"
      },
      "workflow.worker.state_changed": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        attemptId: "attempt-2",
        workerId: "worker-1",
        providerId: "orca/openai",
        transport: "hidden_interactive",
        status: "ready"
      },
      "workflow.human_review.requested": {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        attemptId: "attempt-3",
        providerId: "orca/openai",
        transport: "human_review",
        status: "pending"
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
      "workflow.validation.skipped": WorkflowValidationSkippedEventPayload,
      "workflow.transport.attempt_started": WorkflowTransportAttemptStartedEventPayload,
      "workflow.transport.attempt_finished": WorkflowTransportAttemptFinishedEventPayload,
      "workflow.transport.fallback": WorkflowTransportFallbackEventPayload,
      "workflow.worker.state_changed": WorkflowWorkerStateChangedEventPayload,
      "workflow.human_review.requested": WorkflowHumanReviewRequestedEventPayload
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
    expect(() => M8EventType.parse("workflow.transport.attempt_started")).toThrow();
    expect(M9EventType.parse("workflow.transport.attempt_started")).toBe(
      "workflow.transport.attempt_started"
    );
    expect(DomainEventType.parse("workflow.run.started")).toBe("workflow.run.started");
    expect(DomainEventType.parse("workflow.human_review.requested")).toBe(
      "workflow.human_review.requested"
    );
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
        operatorId: "agent:claude-code",
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

describe("WorkflowStepResult", () => {
  it("accepts a fully scored result", () => {
    expect(WorkflowStepResult.parse(scoredResult)).toEqual(scoredResult);
  });

  it("accepts an explicit evaluation-failed result", () => {
    const result = {
      ...scoredResult,
      evaluationStatus: "failed",
      successScore: 0,
      quality: {
        outputCompleteness: 0,
        outputCorrectness: 0,
        instructionAdherence: 0,
        downstreamReadiness: 0,
        riskLevel: 1
      },
      outcome: {
        ...scoredResult.outcome,
        reason: "step result evaluation failed: evaluation proposal did not validate",
        handoffReady: false
      }
    };
    expect(WorkflowStepResult.parse(result)).toEqual(result);
  });

  it("rejects scores outside 0 through 1", () => {
    const parsed = WorkflowStepResult.safeParse({
      ...scoredResult,
      successScore: 1.2
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing required quality fields", () => {
    const parsed = WorkflowStepResult.safeParse({
      ...scoredResult,
      quality: {
        outputCompleteness: 0.95,
        outputCorrectness: 0.9,
        instructionAdherence: 0.88,
        downstreamReadiness: 0.91
      }
    });
    expect(parsed.success).toBe(false);
  });
});

describe("step result scoring contracts", () => {
  it("accepts scoring requests and proposals", () => {
    const request = {
      step: {
        id: "step-run-1",
        templateId: "execution",
        name: "Execution",
        instructions: "Implement the approved plan.",
        status: "passed"
      },
      goal: {
        id: "goal-1",
        description: "Build the feature."
      },
      output: { summary: "Implemented." },
      facts: {
        stepId: "step-run-1",
        stepStatus: "completed",
        performance: { durationSeconds: 42, retries: 0 },
        outcome: {
          producedArtifactsCount: 1,
          blockingIssuesCount: 0,
          warningsCount: 0
        }
      }
    };

    expect(StepResultScoringRequest.parse(request)).toEqual(request);

    const proposal = {
      successScore: 0.9,
      quality: {
        outputCompleteness: 0.9,
        outputCorrectness: 0.85,
        instructionAdherence: 0.95,
        downstreamReadiness: 0.8,
        riskLevel: 0.1
      },
      reason: "Implementation output is complete enough for downstream QA.",
      handoffReady: true
    };

    expect(StepResultScoringProposal.parse(proposal)).toEqual(proposal);
  });
});

describe("OrchestratorAction", () => {
  it("parses approve_step_complete", () => {
    expect(OrchestratorAction.parse({ kind: "approve_step_complete" })).toBeDefined();
  });
  it("rejects unknown kind", () => {
    expect(() => OrchestratorAction.parse({ kind: "explode" })).toThrow();
  });
});

describe("StepAgentChoice + agentPreference", () => {
  it("StepAgentChoice parses", () => {
    expect(StepAgentChoice.parse({ adapterId: "claude-code", modelId: "claude-haiku-4-5" })).toBeDefined();
  });

  it("WorkflowStepTemplate requires non-empty agentPreference", () => {
    const r = WorkflowStepTemplate.safeParse({
      id: "intake", ordinal: 0, name: "Intake", instructions: "x",
      outputSchema: [], agentPreference: [],
    });
    expect(r.success).toBe(false);
  });

  it("WorkflowStepTemplate accepts valid agentPreference", () => {
    const r = WorkflowStepTemplate.safeParse({
      id: "intake", ordinal: 0, name: "Intake", instructions: "x",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
    });
    expect(r.success).toBe(true);
  });
});

describe("WorkflowScope + WorkflowGraph schemas", () => {
  it("WorkflowTemplate applies defaults for scope/scopeName/graph when fields are omitted (back-compat)", () => {
    const result = WorkflowTemplate.parse(template);
    expect(result.scope).toBe("global");
    expect(result.scopeName).toBe("");
    expect(result.graph).toBeNull();
  });

  it("WorkflowTemplate round-trips with scope/scopeName/graph populated", () => {
    const graph = {
      nodes: [
        { id: "n1", type: "step" as const, name: "Intake step", stepId: "intake" },
        { id: "n2", type: "gate" as const, name: "Quality gate", condition: "output.goal_brief.length > 0" },
      ],
      edges: [["n1", "n2"] as [string, string]],
      positions: {
        n1: { x: 0, y: 0 },
        n2: { x: 200, y: 0 },
      },
    };
    const input = {
      ...template,
      scope: "goal" as const,
      scopeName: "my-workspace/my-goal",
      graph,
    };
    const result = WorkflowTemplate.parse(input);
    expect(result.scope).toBe("goal");
    expect(result.scopeName).toBe("my-workspace/my-goal");
    expect(result.graph).toEqual(graph);
  });

  it("WorkflowGraph rejects more than 64 nodes", () => {
    const nodes = Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, type: "step" as const }));
    expect(() =>
      WorkflowGraph.parse({ nodes, edges: [], positions: {} })
    ).toThrow();
  });

  it("WorkflowGraph rejects more than 128 edges", () => {
    const edges = Array.from({ length: 129 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    expect(() =>
      WorkflowGraph.parse({ nodes: [], edges, positions: {} })
    ).toThrow();
  });

  it("WorkflowGraph accepts exactly 64 nodes and 128 edges (boundary)", () => {
    const nodes = Array.from({ length: 64 }, (_, i) => ({ id: `n${i}`, type: "step" as const }));
    const edges = Array.from({ length: 128 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    const result = WorkflowGraph.parse({ nodes, edges, positions: {} });
    expect(result.nodes).toHaveLength(64);
    expect(result.edges).toHaveLength(128);
  });

  it("WorkflowGraphEdge is a 2-tuple of ids", () => {
    expect(WorkflowGraphEdge.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => WorkflowGraphEdge.parse(["a"])).toThrow();
    expect(() => WorkflowGraphEdge.parse(["a", "b", "c"])).toThrow();
    expect(() => WorkflowGraphEdge.parse(["", "b"])).toThrow();
  });

  it("CreateWorkflowTemplateRequest applies defaults when scope/scopeName/graph are omitted", () => {
    const req = {
      name: "My Workflow",
      description: "A test workflow",
      steps: [{
        id: "intake",
        name: "Intake",
        instructions: "Clarify the goal.",
        outputSchema: [{ key: "goal_brief", type: "string" as const, required: true }],
        agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
      }],
      guardrails: [],
    };
    const result = CreateWorkflowTemplateRequest.parse(req);
    expect(result.scope).toBe("global");
    expect(result.scopeName).toBe("");
    expect(result.graph).toBeNull();
  });

  it("CreateWorkflowTemplateRequest accepts scope/scopeName/graph when provided", () => {
    const req = {
      name: "Scoped Workflow",
      description: "A scoped test workflow",
      steps: [{
        id: "intake",
        name: "Intake",
        instructions: "Clarify the goal.",
        outputSchema: [{ key: "goal_brief", type: "string" as const, required: true }],
        agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
      }],
      guardrails: [],
      scope: "workspace" as const,
      scopeName: "my-workspace",
      graph: null,
    };
    const result = CreateWorkflowTemplateRequest.parse(req);
    expect(result.scope).toBe("workspace");
    expect(result.scopeName).toBe("my-workspace");
    expect(result.graph).toBeNull();
  });

  it("WorkflowTemplate rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      WorkflowTemplate.parse({ ...template, unknownField: "not allowed" })
    ).toThrow();
  });
});
