import { z } from "zod";

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

function hasMaxSerializedBytes(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && utf8ByteLength(serialized) <= maxBytes;
  } catch {
    return false;
  }
}

export const WORKFLOW_TEMPLATE_MAX_NAME_CHARS = 100;
export const WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES = 2048;
export const WORKFLOW_STEP_MAX_PURPOSE_BYTES = 1024;
export const WORKFLOW_GUARDRAIL_MAX_LABEL_CHARS = 100;
export const WORKFLOW_GUARDRAIL_MAX_CONFIG_BYTES = 2048;
export const WORKFLOW_ARTIFACT_MAX_TITLE_CHARS = 256;
export const WORKFLOW_ARTIFACT_MAX_BODY_BYTES = 65536;
export const WORKFLOW_DECISION_MAX_REASON_BYTES = 1024;
export const WORKFLOW_OPERATOR_SELECTION_MAX_REASON_BYTES = 2048;
export const WORKFLOW_DECISION_MAX_INFLUENCES = 32;
export const WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES = 8;
export const WORKFLOW_EVENT_MAX_PAYLOAD_BYTES = 4096;
export const WORKFLOW_FAILURE_MAX_MESSAGE_CHARS = 256;

const Id100 = z.string().min(1).max(100);
const Id = z.string().min(1);
const BoundedString = (maxBytes: number, label: string) =>
  z.string().refine(
    (value) => utf8ByteLength(value) <= maxBytes,
    `${label} must be at most ${maxBytes} bytes`
  );

function WorkflowEventPayload<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
  return schema.superRefine((payload, ctx) => {
    if (!hasMaxSerializedBytes(payload, WORKFLOW_EVENT_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workflow event payload must be at most ${WORKFLOW_EVENT_MAX_PAYLOAD_BYTES} bytes when serialized`
      });
    }
  });
}

export const WorkflowStepGateType = z.enum([
  "automated",
  "human-approval",
  "human-input",
  "validation"
]);
export type WorkflowStepGateType = z.infer<typeof WorkflowStepGateType>;

export const WorkflowArtifactType = z.enum([
  "goal_brief",
  "open_questions",
  "research_summary",
  "prd",
  "issue_breakdown",
  "implementation_result",
  "test_report",
  "qa_report",
  "review_report",
  "final_summary",
  "memory_update"
]);
export type WorkflowArtifactType = z.infer<typeof WorkflowArtifactType>;

export const WorkflowRunStatus = z.enum([
  "active",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowStepRunStatus = z.enum([
  "pending",
  "active",
  "blocked",
  "passed",
  "failed",
  "skipped"
]);
export type WorkflowStepRunStatus = z.infer<typeof WorkflowStepRunStatus>;

export const OperatorKind = z.enum(["agent", "model", "human"]);
export type OperatorKind = z.infer<typeof OperatorKind>;

export const ModelProviderId = z.enum([
  "orca/anthropic",
  "orca/openai",
  "orca/google-gemini"
]);
export type ModelProviderId = z.infer<typeof ModelProviderId>;

export const WorkflowDecisionType = z.enum([
  "start_workflow",
  "advance_step",
  "select_operator",
  "request_artifact",
  "request_user_input",
  "evaluate_exit_criteria",
  "evaluate_guardrail",
  "mark_run_complete",
  "block_run"
]);
export type WorkflowDecisionType = z.infer<typeof WorkflowDecisionType>;

export const WorkflowInfluenceKind = z.enum([
  "workflow_step",
  "guardrail",
  "artifact",
  "task_state",
  "operator_readiness",
  "user_input",
  "memory",
  "decision",
  "session_summary"
]);
export type WorkflowInfluenceKind = z.infer<typeof WorkflowInfluenceKind>;

export const WorkflowInfluenceEffect = z.enum([
  "required",
  "blocked",
  "preferred",
  "disallowed",
  "satisfied",
  "missing"
]);
export type WorkflowInfluenceEffect = z.infer<typeof WorkflowInfluenceEffect>;

export const GuardrailKind = z.enum([
  "approval_required",
  "allowed_operators",
  "risk_rule",
  "validation_rule",
  "context_rule",
  "concurrency_rule",
  "cost_speed_preference"
]);
export type GuardrailKind = z.infer<typeof GuardrailKind>;

export const GuardrailEvaluationResult = z.enum([
  "allow",
  "deny",
  "require_approval"
]);
export type GuardrailEvaluationResult = z.infer<typeof GuardrailEvaluationResult>;

export const WorkflowGuardrailConfig = z
  .object({
    id: Id100,
    kind: GuardrailKind,
    label: z.string().min(1).max(WORKFLOW_GUARDRAIL_MAX_LABEL_CHARS),
    configJson: z
      .unknown()
      .refine(
        (value) => hasMaxSerializedBytes(value, WORKFLOW_GUARDRAIL_MAX_CONFIG_BYTES),
        "guardrail config exceeds 2 KiB"
      )
  })
  .strict();
export type WorkflowGuardrailConfig = z.infer<typeof WorkflowGuardrailConfig>;

export const WorkflowStepTemplate = z
  .object({
    id: Id100,
    ordinal: z.number().int().nonnegative(),
    name: z.string().min(1).max(100),
    purpose: BoundedString(WORKFLOW_STEP_MAX_PURPOSE_BYTES, "purpose"),
    requiredInputs: z.array(WorkflowArtifactType).max(20),
    requiredOutputs: z.array(WorkflowArtifactType).max(20),
    gateType: WorkflowStepGateType,
    recommendedCapabilities: z.array(z.string().min(1).max(80)).max(20),
    validationExpectations: z.array(z.string().min(1).max(256)).max(20),
    exitCriteria: z.array(z.string().min(1).max(256)).max(20),
    recommendedOperatorIds: z.array(Id100).max(10)
  })
  .strict();
export type WorkflowStepTemplate = z.infer<typeof WorkflowStepTemplate>;

export const WorkflowTemplate = z
  .object({
    id: Id100,
    name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS),
    description: BoundedString(
      WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES,
      "description"
    ),
    version: z.number().int().nonnegative(),
    isBuiltIn: z.boolean(),
    isLocked: z.boolean(),
    steps: z.array(WorkflowStepTemplate).min(1).max(20),
    guardrails: z.array(WorkflowGuardrailConfig).max(20),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;

export const WorkflowRun = z
  .object({
    id: Id,
    goalId: Id,
    templateId: Id100,
    templateVersion: z.number().int().nonnegative(),
    status: WorkflowRunStatus,
    currentStepRunId: z.string().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    blockedReason: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable()
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRun>;

export const WorkflowStepRun = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: Id,
    stepTemplateId: Id100,
    ordinal: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    status: WorkflowStepRunStatus,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    blockedReason: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    satisfiedExitCriteria: z.array(z.string().min(1).max(256)).max(20),
    outstandingExitCriteria: z.array(z.string().min(1).max(256)).max(20)
  })
  .strict();
export type WorkflowStepRun = z.infer<typeof WorkflowStepRun>;

export const WorkflowArtifact = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: z.string().nullable(),
    stepRunId: z.string().nullable(),
    type: WorkflowArtifactType,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_MAX_TITLE_CHARS),
    body: BoundedString(WORKFLOW_ARTIFACT_MAX_BODY_BYTES, "body"),
    source: z.enum(["user", "agent", "orchestrator", "system"]),
    linkedSessionId: z.string().nullable(),
    linkedTaskId: z.string().nullable(),
    linkedContextPackageId: z.string().nullable(),
    createdAt: z.string().datetime()
  })
  .strict();
export type WorkflowArtifact = z.infer<typeof WorkflowArtifact>;

export const OperatorSelection = z
  .object({
    operatorId: Id100,
    operatorKind: OperatorKind,
    reason: BoundedString(WORKFLOW_OPERATOR_SELECTION_MAX_REASON_BYTES, "reason"),
    requiredCapabilities: z.array(z.string().min(1).max(80)).max(20),
    alternativesConsidered: z
      .array(Id100)
      .max(WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES),
    confidence: z.number().min(0).max(1),
    requiresUserApproval: z.boolean()
  })
  .strict();
export type OperatorSelection = z.infer<typeof OperatorSelection>;

export const OperatorDescriptor = z
  .object({
    id: Id100,
    kind: OperatorKind,
    displayName: z.string().min(1).max(100),
    capabilities: z.array(z.string().min(1).max(80)).max(20),
    ready: z.boolean(),
    notReadyReason: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).optional(),
    supportsRepoEditing: z.boolean(),
    supportsTerminal: z.boolean()
  })
  .strict();
export type OperatorDescriptor = z.infer<typeof OperatorDescriptor>;

export const WorkflowDecisionInfluence = z
  .object({
    kind: WorkflowInfluenceKind,
    id: Id100,
    label: z.string().min(1).max(128),
    effect: WorkflowInfluenceEffect
  })
  .strict();
export type WorkflowDecisionInfluence = z.infer<typeof WorkflowDecisionInfluence>;

export const WorkflowDecisionTrace = z
  .object({
    decisionId: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().nullable(),
    decisionType: WorkflowDecisionType,
    selectedAction: z.string().max(200),
    reason: BoundedString(WORKFLOW_DECISION_MAX_REASON_BYTES, "reason"),
    influencedBy: z
      .array(WorkflowDecisionInfluence)
      .max(WORKFLOW_DECISION_MAX_INFLUENCES),
    alternativesConsidered: z
      .array(z.string().max(200))
      .max(WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES)
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    operatorSelectionJson: OperatorSelection.optional(),
    createdAt: z.string().datetime()
  })
  .strict();
export type WorkflowDecisionTrace = z.infer<typeof WorkflowDecisionTrace>;

const ModelInfo = z
  .object({
    id: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
    capabilities: z.array(z.string().min(1).max(80)).max(20)
  })
  .strict();

export const ModelProviderInfo = z
  .object({
    id: ModelProviderId,
    displayName: z.string().min(1).max(80),
    available: z.boolean(),
    reason: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).optional(),
    models: z.array(ModelInfo).max(20)
  })
  .strict();
export type ModelProviderInfo = z.infer<typeof ModelProviderInfo>;

export const OrchestratorModelChoice = z
  .object({
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80)
  })
  .strict();
export type OrchestratorModelChoice = z.infer<typeof OrchestratorModelChoice>;

export const WorkflowGuardrailEvaluation = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().nullable(),
    guardrailId: Id100,
    guardrailKind: GuardrailKind,
    decisionId: z.string().nullable(),
    result: GuardrailEvaluationResult,
    message: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    createdAt: z.string().datetime()
  })
  .strict();
export type WorkflowGuardrailEvaluation = z.infer<
  typeof WorkflowGuardrailEvaluation
>;

export const WorkflowLlmCallStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed"
]);
export type WorkflowLlmCallStatus = z.infer<typeof WorkflowLlmCallStatus>;

export const ProviderFailureCode = z.enum([
  "missing_api_key",
  "provider_error",
  "invalid_output",
  "rate_limited",
  "timeout",
  "internal_error",
  "daemon_restart"
]);
export type ProviderFailureCode = z.infer<typeof ProviderFailureCode>;

export const WorkflowLlmCall = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: z.string().nullable(),
    stepRunId: z.string().nullable(),
    decisionId: z.string().nullable(),
    providerId: ModelProviderId,
    providerVersion: z.string().min(1).max(80),
    model: z.string().min(1).max(80),
    usageTokensInput: z.number().int().nonnegative().nullable(),
    usageTokensOutput: z.number().int().nonnegative().nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    status: WorkflowLlmCallStatus,
    failureCode: ProviderFailureCode.nullable(),
    failureMessage: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    createdAt: z.string().datetime()
  })
  .strict();
export type WorkflowLlmCall = z.infer<typeof WorkflowLlmCall>;

const CreateWorkflowStepTemplate = WorkflowStepTemplate.omit({
  ordinal: true
})
  .extend({
    ordinal: z.number().int().nonnegative().optional()
  })
  .strict();

export const ListWorkflowTemplatesResponse = z
  .object({
    templates: z.array(WorkflowTemplate)
  })
  .strict();
export type ListWorkflowTemplatesResponse = z.infer<
  typeof ListWorkflowTemplatesResponse
>;

export const GetWorkflowTemplateResponse = z
  .object({
    template: WorkflowTemplate
  })
  .strict();
export type GetWorkflowTemplateResponse = z.infer<
  typeof GetWorkflowTemplateResponse
>;

export const CreateWorkflowTemplateRequest = z
  .object({
    name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS),
    description: BoundedString(
      WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES,
      "description"
    ),
    steps: z.array(CreateWorkflowStepTemplate).min(1).max(20),
    guardrails: z.array(WorkflowGuardrailConfig).max(20)
  })
  .strict();
export type CreateWorkflowTemplateRequest = z.infer<
  typeof CreateWorkflowTemplateRequest
>;

export const UpdateWorkflowTemplateRequest = CreateWorkflowTemplateRequest;
export type UpdateWorkflowTemplateRequest = z.infer<
  typeof UpdateWorkflowTemplateRequest
>;

export const WorkflowTemplateResponse = z
  .object({
    template: WorkflowTemplate
  })
  .strict();
export type WorkflowTemplateResponse = z.infer<typeof WorkflowTemplateResponse>;

export const DuplicateWorkflowTemplateRequest = z
  .object({
    sourceTemplateId: Id100,
    name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS)
  })
  .strict();
export type DuplicateWorkflowTemplateRequest = z.infer<
  typeof DuplicateWorkflowTemplateRequest
>;

export const StartWorkflowRunRequest = z
  .object({
    goalId: Id,
    templateId: Id100
  })
  .strict();
export type StartWorkflowRunRequest = z.infer<typeof StartWorkflowRunRequest>;

export const WorkflowRunResponse = z
  .object({
    run: WorkflowRun
  })
  .strict();
export type WorkflowRunResponse = z.infer<typeof WorkflowRunResponse>;

export const ListWorkflowRunsResponse = z
  .object({
    runs: z.array(WorkflowRun)
  })
  .strict();
export type ListWorkflowRunsResponse = z.infer<
  typeof ListWorkflowRunsResponse
>;

export const WorkflowStepRunResponse = z
  .object({
    stepRun: WorkflowStepRun
  })
  .strict();
export type WorkflowStepRunResponse = z.infer<typeof WorkflowStepRunResponse>;

export const SubmitWorkflowUserInputRequest = z
  .object({
    stepRunId: Id,
    answerText: z.string().max(8192).optional(),
    satisfiedExitCriteria: z.array(z.string().min(1).max(256)).max(20).optional(),
    artifactInputs: z
      .array(
        z
          .object({
            type: WorkflowArtifactType,
            title: z.string().min(1).max(WORKFLOW_ARTIFACT_MAX_TITLE_CHARS),
            body: BoundedString(WORKFLOW_ARTIFACT_MAX_BODY_BYTES, "body")
          })
          .strict()
      )
      .max(10)
      .optional()
  })
  .strict();
export type SubmitWorkflowUserInputRequest = z.infer<
  typeof SubmitWorkflowUserInputRequest
>;

export const RequestNextOrchestratorDecisionRequest = z
  .object({
    workflowRunId: Id
  })
  .strict();
export type RequestNextOrchestratorDecisionRequest = z.infer<
  typeof RequestNextOrchestratorDecisionRequest
>;

export const NextOrchestratorDecisionResponse = z
  .object({
    decision: WorkflowDecisionTrace,
    recommendationIds: z.array(Id).max(5)
  })
  .strict();
export type NextOrchestratorDecisionResponse = z.infer<
  typeof NextOrchestratorDecisionResponse
>;

export const ListWorkflowDecisionsResponse = z
  .object({
    decisions: z.array(WorkflowDecisionTrace)
  })
  .strict();
export type ListWorkflowDecisionsResponse = z.infer<
  typeof ListWorkflowDecisionsResponse
>;

export const WorkflowDecisionResponse = z
  .object({
    decision: WorkflowDecisionTrace
  })
  .strict();
export type WorkflowDecisionResponse = z.infer<typeof WorkflowDecisionResponse>;

export const CreateWorkflowArtifactRequest = z
  .object({
    workflowRunId: z.string().min(1).nullable().optional(),
    stepRunId: z.string().min(1).nullable().optional(),
    type: WorkflowArtifactType,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_MAX_TITLE_CHARS),
    body: BoundedString(WORKFLOW_ARTIFACT_MAX_BODY_BYTES, "body"),
    source: z.enum(["user", "agent", "orchestrator", "system"]),
    linkedSessionId: z.string().min(1).nullable().optional(),
    linkedTaskId: z.string().min(1).nullable().optional(),
    linkedContextPackageId: z.string().min(1).nullable().optional()
  })
  .strict();
export type CreateWorkflowArtifactRequest = z.infer<
  typeof CreateWorkflowArtifactRequest
>;

export const WorkflowArtifactResponse = z
  .object({
    artifact: WorkflowArtifact
  })
  .strict();
export type WorkflowArtifactResponse = z.infer<typeof WorkflowArtifactResponse>;

export const ListWorkflowArtifactsResponse = z
  .object({
    artifacts: z.array(WorkflowArtifact)
  })
  .strict();
export type ListWorkflowArtifactsResponse = z.infer<
  typeof ListWorkflowArtifactsResponse
>;

export const ListOperatorsResponse = z
  .object({
    operators: z.array(OperatorDescriptor)
  })
  .strict();
export type ListOperatorsResponse = z.infer<typeof ListOperatorsResponse>;

export const ListModelProvidersResponse = z
  .object({
    providers: z.array(ModelProviderInfo)
  })
  .strict();
export type ListModelProvidersResponse = z.infer<
  typeof ListModelProvidersResponse
>;

export const UpdateGoalOrchestratorModelRequest = OrchestratorModelChoice;
export type UpdateGoalOrchestratorModelRequest = z.infer<
  typeof UpdateGoalOrchestratorModelRequest
>;

export const UpdateGoalOrchestratorModelResponse = z
  .object({
    goalId: Id,
    orchestratorProvider: ModelProviderId,
    orchestratorModel: z.string().min(1).max(80)
  })
  .strict();
export type UpdateGoalOrchestratorModelResponse = z.infer<
  typeof UpdateGoalOrchestratorModelResponse
>;

const WorkflowRunLifecyclePayload = z
  .object({
    goalId: Id,
    workflowRunId: Id,
    templateId: Id100.optional(),
    templateVersion: z.number().int().nonnegative().optional(),
    resumed: z.boolean().optional(),
    stepRunId: z.string().min(1).optional(),
    failureCode: z.string().min(1).max(80).optional()
  })
  .strict();

export const GoalOrchestratorModelChangedEventPayload = WorkflowEventPayload(
  z.object({
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80)
  })
    .strict()
);
export type GoalOrchestratorModelChangedEventPayload = z.infer<
  typeof GoalOrchestratorModelChangedEventPayload
>;

const WorkflowTemplateVersionEventPayload = z
  .object({
    templateId: Id100,
    version: z.number().int().nonnegative()
  })
  .strict();
export const WorkflowTemplateCreatedEventPayload = WorkflowEventPayload(
  WorkflowTemplateVersionEventPayload
);
export type WorkflowTemplateCreatedEventPayload = z.infer<
  typeof WorkflowTemplateCreatedEventPayload
>;

export const WorkflowTemplateUpdatedEventPayload =
  WorkflowEventPayload(WorkflowTemplateVersionEventPayload);
export type WorkflowTemplateUpdatedEventPayload = z.infer<
  typeof WorkflowTemplateUpdatedEventPayload
>;

export const WorkflowTemplateDuplicatedEventPayload = WorkflowEventPayload(
  z.object({
    templateId: Id100,
    sourceTemplateId: Id100
  })
    .strict()
);
export type WorkflowTemplateDuplicatedEventPayload = z.infer<
  typeof WorkflowTemplateDuplicatedEventPayload
>;

export const WorkflowRunStartedEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunStartedEventPayload = z.infer<
  typeof WorkflowRunStartedEventPayload
>;
export const WorkflowRunPausedEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunPausedEventPayload = z.infer<
  typeof WorkflowRunPausedEventPayload
>;
export const WorkflowRunBlockedEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunBlockedEventPayload = z.infer<
  typeof WorkflowRunBlockedEventPayload
>;
export const WorkflowRunCompletedEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunCompletedEventPayload = z.infer<
  typeof WorkflowRunCompletedEventPayload
>;
export const WorkflowRunFailedEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunFailedEventPayload = z.infer<
  typeof WorkflowRunFailedEventPayload
>;
export const WorkflowRunCancelledEventPayload = WorkflowEventPayload(
  WorkflowRunLifecyclePayload
);
export type WorkflowRunCancelledEventPayload = z.infer<
  typeof WorkflowRunCancelledEventPayload
>;

export const WorkflowStepStartedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    stepTemplateId: Id100,
    ordinal: z.number().int().nonnegative()
  })
    .strict()
);
export type WorkflowStepStartedEventPayload = z.infer<
  typeof WorkflowStepStartedEventPayload
>;

const WorkflowStepTerminalPayload = z
  .object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    stepTemplateId: Id100.optional(),
    ordinal: z.number().int().nonnegative().optional(),
    failureCode: z.string().min(1).max(80).optional()
  })
  .strict();

export const WorkflowStepCompletedEventPayload = WorkflowEventPayload(
  WorkflowStepTerminalPayload
);
export type WorkflowStepCompletedEventPayload = z.infer<
  typeof WorkflowStepCompletedEventPayload
>;
export const WorkflowStepBlockedEventPayload = WorkflowEventPayload(
  WorkflowStepTerminalPayload
);
export type WorkflowStepBlockedEventPayload = z.infer<
  typeof WorkflowStepBlockedEventPayload
>;
export const WorkflowStepSkippedEventPayload = WorkflowEventPayload(
  WorkflowStepTerminalPayload
);
export type WorkflowStepSkippedEventPayload = z.infer<
  typeof WorkflowStepSkippedEventPayload
>;
export const WorkflowStepFailedEventPayload = WorkflowEventPayload(
  WorkflowStepTerminalPayload
);
export type WorkflowStepFailedEventPayload = z.infer<
  typeof WorkflowStepFailedEventPayload
>;

export const WorkflowArtifactCreatedEventPayload = WorkflowEventPayload(
  z.object({
    artifactId: Id,
    goalId: Id,
    workflowRunId: z.string().nullable(),
    stepRunId: z.string().nullable(),
    type: WorkflowArtifactType,
    bodyBytes: z.number().int().nonnegative().max(WORKFLOW_ARTIFACT_MAX_BODY_BYTES)
  })
    .strict()
);
export type WorkflowArtifactCreatedEventPayload = z.infer<
  typeof WorkflowArtifactCreatedEventPayload
>;

export const WorkflowGuardrailEvaluatedEventPayload = WorkflowEventPayload(
  z.object({
    guardrailEvaluationId: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().nullable(),
    guardrailId: Id100,
    guardrailKind: GuardrailKind,
    result: GuardrailEvaluationResult
  })
    .strict()
);
export type WorkflowGuardrailEvaluatedEventPayload = z.infer<
  typeof WorkflowGuardrailEvaluatedEventPayload
>;

export const WorkflowOperatorSelectedEventPayload = WorkflowEventPayload(
  z.object({
    decisionId: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    operatorId: Id100,
    operatorKind: OperatorKind,
    source: z.enum(["llm", "fallback"]),
    requiresApproval: z.boolean()
  })
    .strict()
);
export type WorkflowOperatorSelectedEventPayload = z.infer<
  typeof WorkflowOperatorSelectedEventPayload
>;

export const WorkflowDecisionRequestedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    stepTemplateId: Id100
  })
    .strict()
);
export type WorkflowDecisionRequestedEventPayload = z.infer<
  typeof WorkflowDecisionRequestedEventPayload
>;

export const WorkflowDecisionRecordedEventPayload = WorkflowEventPayload(
  z.object({
    decisionId: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().nullable(),
    decisionType: WorkflowDecisionType,
    influencedByCount: z.number().int().nonnegative().max(WORKFLOW_DECISION_MAX_INFLUENCES)
  })
    .strict()
);
export type WorkflowDecisionRecordedEventPayload = z.infer<
  typeof WorkflowDecisionRecordedEventPayload
>;

export const WorkflowUserInputRequestedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    decisionId: z.string().min(1).optional(),
    recommendationId: z.string().min(1).optional()
  })
    .strict()
);
export type WorkflowUserInputRequestedEventPayload = z.infer<
  typeof WorkflowUserInputRequestedEventPayload
>;

export const WorkflowUserInputSubmittedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    answerBytes: z.number().int().nonnegative().max(8192).optional(),
    artifactIds: z.array(Id).max(10).optional(),
    satisfiedExitCriteriaCount: z.number().int().nonnegative().max(20).optional()
  })
    .strict()
);
export type WorkflowUserInputSubmittedEventPayload = z.infer<
  typeof WorkflowUserInputSubmittedEventPayload
>;

const WorkflowRecommendationCreatedEventPayloadBase = z
  .object({
    recommendationId: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: Id,
    type: z.string().min(1).max(80),
    decisionId: z.string().min(1).optional()
  })
  .strict();
export const WorkflowRecommendationCreatedEventPayload = WorkflowEventPayload(
  WorkflowRecommendationCreatedEventPayloadBase
);
export type WorkflowRecommendationCreatedEventPayload = z.infer<
  typeof WorkflowRecommendationCreatedEventPayload
>;

export const WorkflowRecommendationAcceptedEventPayload =
  WorkflowEventPayload(
    WorkflowRecommendationCreatedEventPayloadBase.omit({ decisionId: true }).extend({
      workflowRunId: Id.optional(),
      stepRunId: Id.optional()
    })
  );
export type WorkflowRecommendationAcceptedEventPayload = z.infer<
  typeof WorkflowRecommendationAcceptedEventPayload
>;

export const WorkflowRecommendationRejectedEventPayload =
  WorkflowEventPayload(
    WorkflowRecommendationCreatedEventPayloadBase.omit({ decisionId: true }).extend({
      workflowRunId: Id.optional(),
      stepRunId: Id.optional()
    })
  );
export type WorkflowRecommendationRejectedEventPayload = z.infer<
  typeof WorkflowRecommendationRejectedEventPayload
>;

export const WorkflowTaskDagCreatedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id.optional(),
    workflowRunId: Id,
    stepRunId: Id,
    taskIds: z.array(Id).max(50),
    count: z.number().int().nonnegative().max(50)
  })
    .strict()
);
export type WorkflowTaskDagCreatedEventPayload = z.infer<
  typeof WorkflowTaskDagCreatedEventPayload
>;

export const WorkflowTaskDagUpdatedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id.optional(),
    workflowRunId: Id,
    stepRunId: Id,
    taskIds: z.array(Id).max(50),
    count: z.number().int().nonnegative().max(50),
    changedFields: z.array(z.string().min(1).max(80)).max(20)
  })
    .strict()
);
export type WorkflowTaskDagUpdatedEventPayload = z.infer<
  typeof WorkflowTaskDagUpdatedEventPayload
>;

const WorkflowValidationEventPayloadBase = z
  .object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    validationId: z.string().min(1).optional(),
    failureCode: z.string().min(1).max(80).optional()
  })
  .strict();

export const WorkflowValidationRunEventPayload = WorkflowEventPayload(
  WorkflowValidationEventPayloadBase
);
export type WorkflowValidationRunEventPayload = z.infer<
  typeof WorkflowValidationRunEventPayload
>;
export const WorkflowValidationPassedEventPayload = WorkflowEventPayload(
  WorkflowValidationEventPayloadBase
);
export type WorkflowValidationPassedEventPayload = z.infer<
  typeof WorkflowValidationPassedEventPayload
>;
export const WorkflowValidationFailedEventPayload = WorkflowEventPayload(
  WorkflowValidationEventPayloadBase
);
export type WorkflowValidationFailedEventPayload = z.infer<
  typeof WorkflowValidationFailedEventPayload
>;
export const WorkflowValidationSkippedEventPayload = WorkflowEventPayload(
  WorkflowValidationEventPayloadBase
);
export type WorkflowValidationSkippedEventPayload = z.infer<
  typeof WorkflowValidationSkippedEventPayload
>;

export const WorkflowEventType = z.enum([
  "workflow.template.created",
  "workflow.template.updated",
  "workflow.template.duplicated",
  "workflow.run.started",
  "workflow.run.paused",
  "workflow.run.blocked",
  "workflow.run.completed",
  "workflow.run.failed",
  "workflow.run.cancelled",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.blocked",
  "workflow.step.skipped",
  "workflow.step.failed",
  "workflow.artifact.created",
  "workflow.guardrail.evaluated",
  "workflow.operator.selected",
  "workflow.decision.requested",
  "workflow.decision.recorded",
  "workflow.user.input.requested",
  "workflow.user.input.submitted",
  "workflow.recommendation.created",
  "workflow.recommendation.accepted",
  "workflow.recommendation.rejected",
  "workflow.task.dag.created",
  "workflow.task.dag.updated",
  "workflow.validation.run",
  "workflow.validation.passed",
  "workflow.validation.failed",
  "workflow.validation.skipped"
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

export const M8EventType = z.enum([
  "goal.orchestrator_model_changed",
  ...WorkflowEventType.options
]);
export type M8EventType = z.infer<typeof M8EventType>;

export const WorkflowEvent = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("workflow.template.created"), payload: WorkflowTemplateCreatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.template.updated"), payload: WorkflowTemplateUpdatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.template.duplicated"), payload: WorkflowTemplateDuplicatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.started"), payload: WorkflowRunStartedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.paused"), payload: WorkflowRunPausedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.blocked"), payload: WorkflowRunBlockedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.completed"), payload: WorkflowRunCompletedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.failed"), payload: WorkflowRunFailedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.run.cancelled"), payload: WorkflowRunCancelledEventPayload }).strict(),
    z.object({ type: z.literal("workflow.step.started"), payload: WorkflowStepStartedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.step.completed"), payload: WorkflowStepCompletedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.step.blocked"), payload: WorkflowStepBlockedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.step.skipped"), payload: WorkflowStepSkippedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.step.failed"), payload: WorkflowStepFailedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.artifact.created"), payload: WorkflowArtifactCreatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.guardrail.evaluated"), payload: WorkflowGuardrailEvaluatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.operator.selected"), payload: WorkflowOperatorSelectedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.decision.requested"), payload: WorkflowDecisionRequestedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.decision.recorded"), payload: WorkflowDecisionRecordedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.user.input.requested"), payload: WorkflowUserInputRequestedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.user.input.submitted"), payload: WorkflowUserInputSubmittedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.recommendation.created"), payload: WorkflowRecommendationCreatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.recommendation.accepted"), payload: WorkflowRecommendationAcceptedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.recommendation.rejected"), payload: WorkflowRecommendationRejectedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.task.dag.created"), payload: WorkflowTaskDagCreatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.task.dag.updated"), payload: WorkflowTaskDagUpdatedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.validation.run"), payload: WorkflowValidationRunEventPayload }).strict(),
    z.object({ type: z.literal("workflow.validation.passed"), payload: WorkflowValidationPassedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.validation.failed"), payload: WorkflowValidationFailedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.validation.skipped"), payload: WorkflowValidationSkippedEventPayload }).strict()
  ])
  .superRefine((event, ctx) => {
    if (!hasMaxSerializedBytes(event.payload, WORKFLOW_EVENT_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workflow event payload must be at most ${WORKFLOW_EVENT_MAX_PAYLOAD_BYTES} bytes when serialized`
      });
    }
  });
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
