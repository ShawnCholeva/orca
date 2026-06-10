import { z } from "zod";
import { AdapterId } from "../adapters/ids.js";
import { WorkflowStepOutputSchema } from "./output-schema.js";

export {
  WorkflowStepOutputSchema,
  WorkflowStepOutputField,
  validateStepOutput,
  type ValidateResult,
} from "./output-schema.js";

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
export const WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES = 8192;
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
export const WORKFLOW_TEMPLATE_MAX_SCOPE_NAME_CHARS = 200;
export const WORKFLOW_GRAPH_MAX_NODES = 64;
export const WORKFLOW_GRAPH_MAX_EDGES = 128;
export const WORKFLOW_GATE_MAX_CONDITION_CHARS = 2048;
export const ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES = 65536;
export const ORCHESTRATION_DIAGNOSTICS_MAX_BYTES = 4096;
export const ORCHESTRATION_HUMAN_REVIEW_MAX_SUMMARY_BYTES = 4096;
export const ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES = 4096;

const Id100 = z.string().min(1).max(100);
const Id = z.string().min(1);
const Score01 = z.number().min(0).max(1);
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
  "memory_update",
  "step_output",
  "interview_turn",
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
  "orca/google"
]);
export type ModelProviderId = z.infer<typeof ModelProviderId>;

export function getModelProviderDisplayName(providerId: ModelProviderId): string {
  switch (providerId) {
    case "orca/anthropic":
      return "Claude";
    case "orca/openai":
      return "OpenAI";
    case "orca/google":
      return "Google";
  }
}

export const OrchestrationTransport = z.enum([
  "one_shot",
  "hidden_interactive",
  "human_review"
]);
export type OrchestrationTransport = z.infer<typeof OrchestrationTransport>;

export const OrchestrationDecisionKind = z.enum([
  "select_operator",
  "score_transition",
  "score_step_result",
  "repair_artifact",
  "run_audit",
  "run_step_skill",
  "synthesize_step_output",
]);
export type OrchestrationDecisionKind = z.infer<typeof OrchestrationDecisionKind>;

export const OrchestrationWorkerState = z.enum([
  "starting",
  "ready",
  "awaiting_input",
  "producing_decision",
  "hung",
  "auth_required",
  "failed",
  "stopped"
]);
export type OrchestrationWorkerState = z.infer<typeof OrchestrationWorkerState>;

export const OrchestrationTransportFailureReason = z.enum([
  "one_shot_unavailable",
  "one_shot_parse_failed",
  "one_shot_rate_limited",
  "interactive_spawn_failed",
  "interactive_hung",
  "interactive_auth_lost",
  "interactive_output_invalid",
  "daemon_restart",
  "proposal_rejected"
]);
export type OrchestrationTransportFailureReason = z.infer<
  typeof OrchestrationTransportFailureReason
>;

export const OrchestrationTransportAttemptStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "rejected",
  "failed",
  "fallback"
]);
export type OrchestrationTransportAttemptStatus = z.infer<
  typeof OrchestrationTransportAttemptStatus
>;

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

export const StepAgentChoice = z
  .object({
    adapterId: AdapterId,
    modelId: z.string().min(1).max(80),
    providerId: ModelProviderId.optional(),
  })
  .strict();
export type StepAgentChoice = z.infer<typeof StepAgentChoice>;

export const WorkflowStepTemplate = z
  .object({
    id: Id100,
    ordinal: z.number().int().nonnegative(),
    name: z.string().min(1).max(100),
    instructions: BoundedString(WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES, "instructions"),
    outputSchema: WorkflowStepOutputSchema,
    agentPreference: z.array(StepAgentChoice).min(1).max(8),
  })
  .strict();
export type WorkflowStepTemplate = z.infer<typeof WorkflowStepTemplate>;

export const WorkflowScope = z.enum(["global", "workspace", "goal"]);
export type WorkflowScope = z.infer<typeof WorkflowScope>;

export const WorkflowGraphNode = z
  .object({
    id: Id100,
    type: z.enum(["step", "gate"]),
    name: z.string().max(100).default(""),
    stepId: Id100.optional(),
    condition: z.string().max(WORKFLOW_GATE_MAX_CONDITION_CHARS).optional(),
  })
  .strict();
export type WorkflowGraphNode = z.infer<typeof WorkflowGraphNode>;

export const WorkflowGraphEdge = z.tuple([Id100, Id100]);
export type WorkflowGraphEdge = z.infer<typeof WorkflowGraphEdge>;

export const WorkflowGraph = z
  .object({
    nodes: z.array(WorkflowGraphNode).max(WORKFLOW_GRAPH_MAX_NODES),
    edges: z.array(WorkflowGraphEdge).max(WORKFLOW_GRAPH_MAX_EDGES),
    positions: z.record(Id100, z.object({ x: z.number(), y: z.number() }).strict()),
  })
  .strict();
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

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
    updatedAt: z.string().datetime(),
    scope: WorkflowScope.default("global"),
    scopeName: z.string().max(WORKFLOW_TEMPLATE_MAX_SCOPE_NAME_CHARS).default(""),
    graph: WorkflowGraph.nullable().default(null),
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

export const WorkflowStepResultStatus = z.enum([
  "completed",
  "failed",
  "blocked",
  "cancelled"
]);
export type WorkflowStepResultStatus = z.infer<typeof WorkflowStepResultStatus>;

export const WorkflowStepResultEvaluationStatus = z.enum(["scored", "failed"]);
export type WorkflowStepResultEvaluationStatus = z.infer<
  typeof WorkflowStepResultEvaluationStatus
>;

export const WorkflowStepResultQuality = z
  .object({
    outputCompleteness: Score01,
    outputCorrectness: Score01,
    instructionAdherence: Score01,
    downstreamReadiness: Score01,
    riskLevel: Score01
  })
  .strict();
export type WorkflowStepResultQuality = z.infer<typeof WorkflowStepResultQuality>;

export const WorkflowStepResultPerformance = z
  .object({
    durationSeconds: z.number().nonnegative(),
    retries: z.number().int().nonnegative(),
    totalTurns: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional()
  })
  .strict();
export type WorkflowStepResultPerformance = z.infer<
  typeof WorkflowStepResultPerformance
>;

export const WorkflowStepResultOutcome = z
  .object({
    reason: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS),
    producedArtifactsCount: z.number().int().nonnegative(),
    blockingIssuesCount: z.number().int().nonnegative(),
    warningsCount: z.number().int().nonnegative(),
    handoffReady: z.boolean()
  })
  .strict();
export type WorkflowStepResultOutcome = z.infer<typeof WorkflowStepResultOutcome>;

export const WorkflowStepResult = z
  .object({
    stepId: Id,
    stepStatus: WorkflowStepResultStatus,
    evaluationStatus: WorkflowStepResultEvaluationStatus,
    successScore: Score01,
    quality: WorkflowStepResultQuality,
    performance: WorkflowStepResultPerformance,
    outcome: WorkflowStepResultOutcome
  })
  .strict();
export type WorkflowStepResult = z.infer<typeof WorkflowStepResult>;

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
    selectedOperatorId: Id100.nullable().optional(),
    selectedProviderId: ModelProviderId.nullable().optional(),
    selectedModelId: z.string().min(1).max(80).nullable().optional(),
    operatorSelectedAt: z.string().datetime().nullable().optional(),
    stepResult: WorkflowStepResult.nullable(),
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

export const InterviewTurn = z
  .object({
    turnIndex: z.number().int().nonnegative(),
    questionDecisionId: Id,
    question: z.string().min(1).max(2000),
    answer: z.string().min(1).max(8192),
    answeredAt: z.string().datetime(),
  })
  .strict();
export type InterviewTurn = z.infer<typeof InterviewTurn>;

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
    supportsTerminal: z.boolean(),
    providerId: ModelProviderId.optional(),
    modelId: z.string().min(1).max(80).optional(),
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

export const WorkflowDecisionTransportSummary = z
  .object({
    attemptId: Id,
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80),
    transport: OrchestrationTransport,
    status: OrchestrationTransportAttemptStatus,
    workerId: z.string().min(1).nullable(),
    humanReviewId: z.string().min(1).nullable()
  })
  .strict();
export type WorkflowDecisionTransportSummary = z.infer<
  typeof WorkflowDecisionTransportSummary
>;

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
    transportSummary: WorkflowDecisionTransportSummary.optional(),
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

export const OrchestrationRequest = z
  .object({
    kind: OrchestrationDecisionKind,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80),
    attemptId: z.string().min(1).optional(),
    adapterId: AdapterId.optional(),
    payload: z
      .unknown()
      .refine(
        (value) => hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES),
        `orchestration request payload must be at most ${ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES} bytes`
      )
  })
  .strict();
export type OrchestrationRequest = z.infer<typeof OrchestrationRequest>;

export const OrchestrationProposalEnvelope = z
  .object({
    orcaProposalVersion: z.literal(1),
    kind: OrchestrationDecisionKind,
    payload: z.unknown()
  })
  .strict();
export type OrchestrationProposalEnvelope = z.infer<
  typeof OrchestrationProposalEnvelope
>;

export const SynthesisRequest = z
  .object({
    sessionResult: BoundedString(
      ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
      "sessionResult"
    ),
    outputSchema: WorkflowStepOutputSchema,
    stepInput: z.unknown(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SynthesisRequest must be at most ${ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES} bytes when serialized`,
      });
    }
  });
export type SynthesisRequest = z.infer<typeof SynthesisRequest>;

export const SynthesisProposal = z
  .object({ output: z.record(z.unknown()) })
  .strict();
export type SynthesisProposal = z.infer<typeof SynthesisProposal>;

export const StepResultScoringFacts = z
  .object({
    stepId: Id,
    stepStatus: WorkflowStepResultStatus,
    performance: WorkflowStepResultPerformance,
    outcome: z
      .object({
        producedArtifactsCount: z.number().int().nonnegative(),
        blockingIssuesCount: z.number().int().nonnegative(),
        warningsCount: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type StepResultScoringFacts = z.infer<typeof StepResultScoringFacts>;

export const StepResultScoringRequest = z
  .object({
    step: z
      .object({
        id: Id,
        templateId: Id100,
        name: z.string().min(1).max(100),
        instructions: BoundedString(
          WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES,
          "instructions"
        ),
        status: WorkflowStepRunStatus
      })
      .strict(),
    goal: z
      .object({
        id: Id,
        description: z.string().max(4000)
      })
      .strict(),
    output: z.record(z.unknown()).nullable(),
    facts: StepResultScoringFacts
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `StepResultScoringRequest must be at most ${ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES} bytes when serialized`,
      });
    }
  });
export type StepResultScoringRequest = z.infer<typeof StepResultScoringRequest>;

export const StepResultScoringProposal = z
  .object({
    successScore: Score01,
    quality: WorkflowStepResultQuality,
    // The model's free-text justification. Kept generous (matching rationale
    // fields) so a verbose-but-valid reason never invalidates a real score; the
    // persisted WorkflowStepResult truncates it to WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
    // via sanitizeStepResultReason.
    reason: z.string().max(2000),
    handoffReady: z.boolean()
  })
  .strict();
export type StepResultScoringProposal = z.infer<typeof StepResultScoringProposal>;

export const StepSkillProposal = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ask"),
    question: z.string().min(1).max(2000),
    rationale: z.string().max(1000).optional(),
  }).strict(),
  z.object({
    action: z.literal("complete"),
    output: z.record(z.unknown()),
    completion: z.object({
      confidence: z.enum(["low", "medium", "high"]),
      assumptions: z.array(z.string().max(500)).max(20),
      openQuestions: z.array(z.string().max(500)).max(20),
      whyComplete: z.string().max(1000),
    }).strict(),
  }).strict(),
]);
export type StepSkillProposal = z.infer<typeof StepSkillProposal>;

export const OrchestrationTransportAttempt = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    kind: OrchestrationDecisionKind,
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80),
    transport: OrchestrationTransport,
    status: OrchestrationTransportAttemptStatus,
    failureReason: OrchestrationTransportFailureReason.nullable(),
    failureMessage: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    diagnostics: BoundedString(
      ORCHESTRATION_DIAGNOSTICS_MAX_BYTES,
      "diagnostics"
    ).nullable(),
    workerId: z.string().min(1).nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    humanReview: z.lazy(() => HumanReviewPayload).optional()
  })
  .strict();
export type OrchestrationTransportAttempt = z.infer<
  typeof OrchestrationTransportAttempt
>;

export const WorkerHookCapabilities = z
  .object({
    providerId: ModelProviderId,
    supportsPromptHooks: z.boolean(),
    supportsStopHooks: z.boolean(),
    supportsStateHooks: z.boolean(),
    detectedAt: z.string().datetime()
  })
  .strict();
export type WorkerHookCapabilities = z.infer<typeof WorkerHookCapabilities>;

export const WorkerHookTrace = z
  .object({
    id: Id,
    workerId: Id,
    hookName: z.string().min(1).max(80),
    status: z.enum(["skipped", "succeeded", "failed"]),
    summary: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();
export type WorkerHookTrace = z.infer<typeof WorkerHookTrace>;

export const OrchestrationWorkerSummary = z
  .object({
    id: Id,
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80),
    state: OrchestrationWorkerState,
    currentGoalId: z.string().min(1).nullable(),
    currentWorkflowRunId: z.string().min(1).nullable(),
    currentAttemptId: z.string().min(1).nullable(),
    failureReason: OrchestrationTransportFailureReason.nullable(),
    failureMessage: z.string().max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS).nullable(),
    healthCheckedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type OrchestrationWorkerSummary = z.infer<
  typeof OrchestrationWorkerSummary
>;

export const OrchestrationWorkerDetail = OrchestrationWorkerSummary.extend({
  hookCapabilities: WorkerHookCapabilities.nullable(),
  hookTraces: z.array(WorkerHookTrace).max(50),
  outputTail: BoundedString(
    ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
    "outputTail"
  ).nullable()
}).strict();
export type OrchestrationWorkerDetail = z.infer<
  typeof OrchestrationWorkerDetail
>;

const HumanReviewChoice = z
  .object({
    id: Id100,
    label: z.string().min(1).max(120),
    description: z.string().max(512).nullable(),
    proposal: OrchestrationProposalEnvelope
  })
  .strict();

export const HumanReviewPayload = z
  .object({
    id: Id,
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: Id,
    kind: OrchestrationDecisionKind,
    providerId: ModelProviderId,
    modelId: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    summary: BoundedString(
      ORCHESTRATION_HUMAN_REVIEW_MAX_SUMMARY_BYTES,
      "summary"
    ),
    choices: z.array(HumanReviewChoice).min(1).max(20),
    createdAt: z.string().datetime()
  })
  .strict();
export type HumanReviewPayload = z.infer<typeof HumanReviewPayload>;

export const SubmitHumanReviewDecisionRequest = z
  .object({
    choiceId: Id100.optional(),
    proposal: OrchestrationProposalEnvelope
  })
  .strict();
export type SubmitHumanReviewDecisionRequest = z.infer<
  typeof SubmitHumanReviewDecisionRequest
>;

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
    guardrails: z.array(WorkflowGuardrailConfig).max(20),
    scope: WorkflowScope.default("global"),
    scopeName: z.string().max(WORKFLOW_TEMPLATE_MAX_SCOPE_NAME_CHARS).default(""),
    graph: WorkflowGraph.nullable().default(null),
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
    template: WorkflowTemplate,
    warnings: z.array(z.string()).default([])
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
    questionDecisionId: Id.optional(),
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

export const ListOrchestrationAttemptsResponse = z
  .object({
    attempts: z.array(OrchestrationTransportAttempt)
  })
  .strict();
export type ListOrchestrationAttemptsResponse = z.infer<
  typeof ListOrchestrationAttemptsResponse
>;

export const ListOrchestrationWorkersResponse = z
  .object({
    workers: z.array(OrchestrationWorkerSummary)
  })
  .strict();
export type ListOrchestrationWorkersResponse = z.infer<
  typeof ListOrchestrationWorkersResponse
>;

export const GetOrchestrationWorkerResponse = z
  .object({
    worker: OrchestrationWorkerDetail
  })
  .strict();
export type GetOrchestrationWorkerResponse = z.infer<
  typeof GetOrchestrationWorkerResponse
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

export const WorkflowTransportAttemptStartedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: Id,
    providerId: ModelProviderId,
    transport: OrchestrationTransport,
    status: OrchestrationTransportAttemptStatus
  })
    .strict()
);
export type WorkflowTransportAttemptStartedEventPayload = z.infer<
  typeof WorkflowTransportAttemptStartedEventPayload
>;

export const WorkflowTransportAttemptFinishedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: Id,
    providerId: ModelProviderId,
    transport: OrchestrationTransport,
    status: OrchestrationTransportAttemptStatus,
    failureReason: OrchestrationTransportFailureReason.optional()
  })
    .strict()
);
export type WorkflowTransportAttemptFinishedEventPayload = z.infer<
  typeof WorkflowTransportAttemptFinishedEventPayload
>;

export const WorkflowTransportFallbackEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: Id,
    providerId: ModelProviderId,
    transport: OrchestrationTransport,
    status: z.literal("fallback"),
    failureReason: OrchestrationTransportFailureReason
  })
    .strict()
);
export type WorkflowTransportFallbackEventPayload = z.infer<
  typeof WorkflowTransportFallbackEventPayload
>;

export const WorkflowWorkerStateChangedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: z.string().min(1).optional(),
    workerId: Id,
    providerId: ModelProviderId,
    transport: z.literal("hidden_interactive"),
    status: OrchestrationWorkerState,
    failureReason: OrchestrationTransportFailureReason.optional()
  })
    .strict()
);
export type WorkflowWorkerStateChangedEventPayload = z.infer<
  typeof WorkflowWorkerStateChangedEventPayload
>;

export const WorkflowHumanReviewRequestedEventPayload = WorkflowEventPayload(
  z.object({
    goalId: Id,
    workflowRunId: Id,
    stepRunId: z.string().min(1).nullable(),
    attemptId: Id,
    providerId: ModelProviderId,
    transport: z.literal("human_review"),
    status: OrchestrationTransportAttemptStatus
  })
    .strict()
);
export type WorkflowHumanReviewRequestedEventPayload = z.infer<
  typeof WorkflowHumanReviewRequestedEventPayload
>;

const M8_WORKFLOW_EVENT_TYPES = [
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
] as const;

const M9_WORKFLOW_EVENT_TYPES = [
  "workflow.transport.attempt_started",
  "workflow.transport.attempt_finished",
  "workflow.transport.fallback",
  "workflow.worker.state_changed",
  "workflow.human_review.requested"
] as const;

export const WorkflowEventType = z.enum([
  ...M8_WORKFLOW_EVENT_TYPES,
  ...M9_WORKFLOW_EVENT_TYPES
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

export const M8EventType = z.enum([
  "goal.orchestrator_model_changed",
  ...M8_WORKFLOW_EVENT_TYPES
]);
export type M8EventType = z.infer<typeof M8EventType>;

export const M9EventType = z.enum([
  "goal.orchestrator_model_changed",
  ...M8_WORKFLOW_EVENT_TYPES,
  ...M9_WORKFLOW_EVENT_TYPES
]);
export type M9EventType = z.infer<typeof M9EventType>;

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
    z.object({ type: z.literal("workflow.validation.skipped"), payload: WorkflowValidationSkippedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.transport.attempt_started"), payload: WorkflowTransportAttemptStartedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.transport.attempt_finished"), payload: WorkflowTransportAttemptFinishedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.transport.fallback"), payload: WorkflowTransportFallbackEventPayload }).strict(),
    z.object({ type: z.literal("workflow.worker.state_changed"), payload: WorkflowWorkerStateChangedEventPayload }).strict(),
    z.object({ type: z.literal("workflow.human_review.requested"), payload: WorkflowHumanReviewRequestedEventPayload }).strict()
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

export const OrchestratorAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paraphrase_agent_message"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("forward_to_agent"), translated: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("answer_user_directly"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("approve_step_complete"), scoring: z.unknown().optional(), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("revise_step"), feedback: z.string().min(1).max(4000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("escalate_to_user"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
]);
export type OrchestratorAction = z.infer<typeof OrchestratorAction>;
