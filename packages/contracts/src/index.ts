import { z } from "zod";
import {
  ModelProviderId,
  OperatorKind,
  OrchestratorModelChoice,
  WorkflowArtifactType
} from "./workflows/index.js";
import { AdapterId } from "./adapters/ids.js";

export * from "./workflows/index.js";
export * from "./adapters/ids.js";

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

function hasMaxSerializedBytes(value: unknown, maxBytes: number): boolean {
  return utf8ByteLength(JSON.stringify(value)) <= maxBytes;
}

export const GoalStatus = z.enum(["active", "archived"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatus,
  autonomyLevel: z.number().int().default(1),
  orchestratorProvider: ModelProviderId.nullable().optional(),
  orchestratorModel: z.string().nullable().optional(),
  activeWorkflowRunId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable()
});
export type Goal = z.infer<typeof Goal>;

export const GuidedRefinementInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default("")
});
export type GuidedRefinementInput = z.infer<typeof GuidedRefinementInput>;

export const GuidedRefinementOutput = z.object({
  skillId: z.literal("guided-goal-refinement"),
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  successCriteria: z.array(z.string().min(1).max(200)).max(20),
  constraints: z.array(z.string().min(1).max(200)).max(20),
  assumptions: z.array(z.string().min(1).max(200)).max(20)
});
export type GuidedRefinementOutput = z.infer<typeof GuidedRefinementOutput>;

const WorkspaceAttachmentInput = z.object({
  inputPath: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(100).optional()
});

export const CreateGoalRequest = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  refined: GuidedRefinementOutput.optional(),
  workspaces: z.array(WorkspaceAttachmentInput).optional(),
  orchestratorModel: OrchestratorModelChoice.optional()
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

export const CreateGoalResponse = z.object({
  goal: Goal
});
export type CreateGoalResponse = z.infer<typeof CreateGoalResponse>;

export const CreateGoalAndStartWorkflowRequest = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  workspaces: z.array(WorkspaceAttachmentInput).optional(),
  orchestratorModel: OrchestratorModelChoice.optional(),
  workflowTemplateId: z.string().min(1),
});
export type CreateGoalAndStartWorkflowRequest = z.infer<typeof CreateGoalAndStartWorkflowRequest>;

const BootstrapError = z.object({
  phase: z.enum(["startWorkflowRun", "requestDecision"]),
  message: z.string(),
});

export const CreateGoalAndStartWorkflowResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    goalId: z.string(),
    workflowRunId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    goalId: z.string(),
    workflowRunId: z.string().optional(),
    bootstrapError: BootstrapError,
  }),
]);
export type CreateGoalAndStartWorkflowResponse = z.infer<typeof CreateGoalAndStartWorkflowResponse>;

export const UpdateGoalRequest = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional()
  })
  .refine((data) => data.title !== undefined || data.description !== undefined, {
    message: "at least one of title or description must be provided"
  });
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

export const UpdateGoalResponse = z.object({
  goal: Goal
});
export type UpdateGoalResponse = z.infer<typeof UpdateGoalResponse>;

export const ArchiveGoalResponse = z.object({
  goal: Goal
});
export type ArchiveGoalResponse = z.infer<typeof ArchiveGoalResponse>;

export const ListGoalsResponse = z.object({
  goals: z.array(Goal)
});
export type ListGoalsResponse = z.infer<typeof ListGoalsResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  startedAt: z.string(),
  registries: z
    .object({
      plugins: z.number().int().nonnegative(),
      skills: z.number().int().nonnegative()
    })
    .optional()
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const DomainEventType = z.enum([
  "goal.created",
  "goal.updated",
  "goal.archived",
  "skill.invoked",
  "goal.refined",
  "workspace.attached",
  "workspace.removed",
  "session.created",
  "session.started",
  "session.exited",
  "session.failed",
  "session.stopped",
  "memory.extraction.requested",
  "memory.extraction.started",
  "memory.extraction.completed",
  "memory.extraction.failed",
  "memory.item.created",
  "memory.item.updated",
  "memory.item.promoted",
  "memory.item.archived",
  "decision.created",
  "decision.updated",
  "decision.confirmed",
  "decision.archived",
  "context.assembly.requested",
  "context.assembly.completed",
  "context.assembly.failed",
  "context.package.created",
  "task.generation.requested",
  "task.generated",
  "task.generation.failed",
  "task.created",
  "task.updated",
  "task.split",
  "task.status_changed",
  "task.associated_with_session",
  "task.associated_with_context_package",
  "recommendation.generation.requested",
  "recommendation.generated",
  "recommendation.generation.failed",
  "recommendation.accepted",
  "recommendation.rejected",
  "recommendation.dismissed",
  "recommendation.modified",
  "recommendation.superseded",
  "conflict.detected",
  "conflict.resolved",
  "conflict.dismissed",
  "user.feedback.recorded",
  "orchestrator.message.created",
  "goal.orchestrator_model_changed",
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
  "workflow.validation.skipped",
  "workflow.transport.attempt_started",
  "workflow.transport.attempt_finished",
  "workflow.transport.fallback",
  "workflow.worker.state_changed",
  "workflow.human_review.requested",
  "adapter.execution_modes.changed"
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

export const MemoryDomainEventType = z.enum([
  "memory.extraction.requested",
  "memory.extraction.started",
  "memory.extraction.completed",
  "memory.extraction.failed",
  "memory.item.created",
  "memory.item.updated",
  "memory.item.promoted",
  "memory.item.archived",
  "decision.created",
  "decision.updated",
  "decision.confirmed",
  "decision.archived"
]);
export type MemoryDomainEventType = z.infer<typeof MemoryDomainEventType>;

export const PluginCapability = z.enum([
  "storage",
  "skill.provider",
  "agent.adapter"
]);
export type PluginCapability = z.infer<typeof PluginCapability>;

export const PluginSummary = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  capabilities: z.array(PluginCapability)
});
export type PluginSummary = z.infer<typeof PluginSummary>;

export const SkillExtensionPoint = z.enum(["goal.create", "goal.refine"]);
export type SkillExtensionPoint = z.infer<typeof SkillExtensionPoint>;

export const WorkspaceType = z.enum(["repo", "folder"]);
export type WorkspaceType = z.infer<typeof WorkspaceType>;

export const GitProbe = z.enum(["ok", "unavailable", "errored", "not_a_repo"]);
export type GitProbe = z.infer<typeof GitProbe>;

export const Workspace = z.object({
  id: z.string(),
  goalId: z.string(),
  path: z.string(),
  name: z.string(),
  workspaceType: WorkspaceType,
  branch: z.string().nullable(),
  isDirty: z.boolean().nullable(),
  gitProbe: GitProbe,
  attachedAt: z.string().datetime()
});
export type Workspace = z.infer<typeof Workspace>;

export const GoalRefinement = z.object({
  goalId: z.string(),
  skillId: z.string(),
  successCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  refinedAt: z.string().datetime()
});
export type GoalRefinement = z.infer<typeof GoalRefinement>;

export const RefineGoalRequest = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).default("")
  })
  .strict();
export type RefineGoalRequest = z.infer<typeof RefineGoalRequest>;

export const RefineGoalResponse = z.object({
  draft: GuidedRefinementOutput
});
export type RefineGoalResponse = z.infer<typeof RefineGoalResponse>;

export const InspectWorkspaceRequest = z
  .object({
    inputPath: z.string().min(1).max(1024)
  })
  .strict();
export type InspectWorkspaceRequest = z.infer<typeof InspectWorkspaceRequest>;

export const InspectWorkspacePreview = Workspace.omit({
  id: true,
  goalId: true,
  attachedAt: true
});
export type InspectWorkspacePreview = z.infer<typeof InspectWorkspacePreview>;

export const InspectWorkspaceResponse = z.object({
  preview: InspectWorkspacePreview
});
export type InspectWorkspaceResponse = z.infer<typeof InspectWorkspaceResponse>;

export const AttachWorkspaceRequest = z
  .object({
    inputPath: WorkspaceAttachmentInput.shape.inputPath,
    name: WorkspaceAttachmentInput.shape.name
  })
  .strict();
export type AttachWorkspaceRequest = z.infer<typeof AttachWorkspaceRequest>;

export const AttachWorkspaceResponse = z.object({
  workspace: Workspace
});
export type AttachWorkspaceResponse = z.infer<typeof AttachWorkspaceResponse>;

export const GoalDetailResponse = z.object({
  goal: Goal,
  refinement: GoalRefinement.nullable(),
  workspaces: z.array(Workspace)
});
export type GoalDetailResponse = z.infer<typeof GoalDetailResponse>;

export const GoalWorkspaceErrorCode = z.enum([
  "invalid_input",
  "not_found",
  "not_a_directory",
  "not_readable",
  "inspection_timeout",
  "workspace_duplicate",
  "duplicate_workspace_in_request",
  "runtime_misconfigured"
]);
export type GoalWorkspaceErrorCode = z.infer<typeof GoalWorkspaceErrorCode>;

export const SessionErrorCode = z.enum([
  "goal_not_found",
  "goal_archived",
  "workspace_not_found",
  "workspace_not_attached",
  "workspace_unavailable",
  "adapter_not_found",
  "session_not_found",
  "session_not_startable",
  "session_not_stoppable",
  "invalid_session_state"
]);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

export const GoalMemoryStatus = z.enum(["candidate", "promoted", "archived"]);
export type GoalMemoryStatus = z.infer<typeof GoalMemoryStatus>;

export const GoalMemoryType = z.enum([
  "constraint",
  "success_criterion",
  "assumption",
  "blocker",
  "open_question",
  "validation_result",
  "architecture_note",
  "note"
]);
export type GoalMemoryType = z.infer<typeof GoalMemoryType>;

export const GoalDecisionStatus = z.enum(["proposed", "confirmed", "archived"]);
export type GoalDecisionStatus = z.infer<typeof GoalDecisionStatus>;

export const MemoryExtractionStatus = z.enum(["pending", "running", "succeeded", "failed"]);
export type MemoryExtractionStatus = z.infer<typeof MemoryExtractionStatus>;

export const MemoryExtractionTrigger = z.enum(["terminal_state", "goal_open", "manual"]);
export type MemoryExtractionTrigger = z.infer<typeof MemoryExtractionTrigger>;

export const MemoryExtractionFailureCode = z.enum([
  "invalid_output",
  "timeout",
  "session_not_terminal",
  "output_unavailable",
  "source_truncated",
  "goal_archived",
  "session_archived",
  "daemon_restart",
  "internal_error"
]);
export type MemoryExtractionFailureCode = z.infer<typeof MemoryExtractionFailureCode>;

export const MemorySourceType = z.enum(["refinement", "session", "manual"]);
export type MemorySourceType = z.infer<typeof MemorySourceType>;

export const DecisionSourceType = z.enum(["session", "manual"]);
export type DecisionSourceType = z.infer<typeof DecisionSourceType>;

export const SessionStatus = z.enum([
  "created",
  "starting",
  "running",
  "exited",
  "failed",
  "stopped",
  "archived"
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionFailureReason = z.enum([
  "command_not_found",
  "workspace_unavailable",
  "spawn_failed",
  "daemon_restart",
  "internal_error"
]);
export type SessionFailureReason = z.infer<typeof SessionFailureReason>;


export const ContextRole = z.enum([
  "architect",
  "engineer",
  "reviewer",
  "generalist"
]);
export type ContextRole = z.infer<typeof ContextRole>;

export const ContextPackageStatus = z.enum(["ready"]);
export type ContextPackageStatus = z.infer<typeof ContextPackageStatus>;

export const ContextAssemblyStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed"
]);
export type ContextAssemblyStatus = z.infer<typeof ContextAssemblyStatus>;

export const ContextAssemblyTrigger = z.enum(["prepare", "regenerate", "retry"]);
export type ContextAssemblyTrigger = z.infer<typeof ContextAssemblyTrigger>;

export const ContextAssemblyFailureCode = z.enum([
  "invalid_input",
  "invalid_output",
  "output_too_large",
  "goal_archived",
  "source_missing",
  "delivery_unavailable",
  "internal_error",
  "daemon_restart"
]);
export type ContextAssemblyFailureCode = z.infer<typeof ContextAssemblyFailureCode>;

export const ContextSourceType = z.enum([
  "goal",
  "refinement",
  "workspace",
  "memory_item",
  "decision",
  "session_summary"
]);
export type ContextSourceType = z.infer<typeof ContextSourceType>;

export const ContextSourceReason = z.enum([
  "required",
  "high_confidence",
  "recency",
  "role_match",
  "sibling",
  "objective_hint"
]);
export type ContextSourceReason = z.infer<typeof ContextSourceReason>;

export const AdapterContextDeliveryMode = z.enum([
  "initial_input",
  "context_file",
  "preview_only"
]);
export type AdapterContextDeliveryMode = z.infer<typeof AdapterContextDeliveryMode>;

export const AdapterAvailabilityStatus = z.enum([
  "available",
  "unavailable",
  "unknown"
]);
export type AdapterAvailabilityStatus = z.infer<typeof AdapterAvailabilityStatus>;

export const AdapterSummary = z.object({
  id: AdapterId,
  title: z.string(),
  availability: AdapterAvailabilityStatus,
  detail: z.string().optional()
});
export type AdapterSummary = z.infer<typeof AdapterSummary>;

export const ListAdaptersResponse = z.object({
  adapters: z.array(AdapterSummary)
});
export type ListAdaptersResponse = z.infer<typeof ListAdaptersResponse>;

export const SessionLatestExtraction = z
  .object({
    id: z.string(),
    status: MemoryExtractionStatus,
    requestedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    failureCode: MemoryExtractionFailureCode.nullable(),
    truncated: z.boolean()
  })
  .strict();
export type SessionLatestExtraction = z.infer<typeof SessionLatestExtraction>;

export const SessionSummary = z.object({
  id: z.string(),
  goalId: z.string(),
  workspaceId: z.string(),
  adapterId: AdapterId,
  contextPackageId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  fromRecommendationId: z.string().nullable().optional(),
  workflowStepRunId: z.string().nullable().optional(),
  role: z.string().nullable(),
  title: z.string(),
  status: SessionStatus,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  exitedAt: z.string().datetime().nullable(),
  latestExtraction: SessionLatestExtraction.optional(),
  latestSummaryHeadline: z.string().max(200).nullable().optional()
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionDetail = SessionSummary.extend({
  instruction: z.string().nullable(),
  pid: z.number().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  cwd: z.string().nullable(),
  terminalCols: z.number().nullable(),
  terminalRows: z.number().nullable(),
  exitCode: z.number().nullable(),
  exitSignal: z.string().nullable(),
  failureReason: SessionFailureReason.nullable(),
  failureDetail: z.string().nullable(),
  archivedAt: z.string().datetime().nullable()
});
export type SessionDetail = z.infer<typeof SessionDetail>;

const SessionOutputChunk = z.object({
  seq: z.number().int().nonnegative(),
  byteOffset: z.number().int().nonnegative(),
  dataBase64: z.string()
});

export const SessionOutputSnapshot = z.object({
  sessionId: z.string(),
  firstByteOffset: z.number().int().nonnegative(),
  nextSeq: z.number().int().nonnegative(),
  totalBytesKept: z.number().int().nonnegative(),
  chunks: z.array(SessionOutputChunk)
});
export type SessionOutputSnapshot = z.infer<typeof SessionOutputSnapshot>;

export const CreateSessionRequest = z
  .object({
    workspaceId: z.string().min(1),
    adapterId: AdapterId,
    contextPackageId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    fromRecommendationId: z.string().min(1).optional(),
    workflowStepRunId: z.string().min(1).optional(),
    role: z.string().trim().max(100).optional(),
    instruction: z.string().max(4000).optional(),
    title: z.string().trim().min(1).max(200).optional()
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  session: SessionDetail
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ListSessionsResponse = z.object({
  sessions: z.array(SessionSummary)
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

export const GetSessionResponse = z.object({
  session: SessionDetail,
  output: SessionOutputSnapshot
});
export type GetSessionResponse = z.infer<typeof GetSessionResponse>;

export const StartSessionRequest = z
  .object({
    terminalCols: z.number().int().positive().max(1000),
    terminalRows: z.number().int().positive().max(1000)
  })
  .strict();
export type StartSessionRequest = z.infer<typeof StartSessionRequest>;

export const StartSessionResponse = z.object({
  session: SessionDetail
});
export type StartSessionResponse = z.infer<typeof StartSessionResponse>;

export const StopSessionRequest = z.object({}).strict();
export type StopSessionRequest = z.infer<typeof StopSessionRequest>;

export const StopSessionResponse = z.object({
  session: SessionDetail
});
export type StopSessionResponse = z.infer<typeof StopSessionResponse>;

export const SessionSubscribeFrame = z
  .object({
    type: z.literal("session.subscribe"),
    sessionId: z.string().min(1)
  })
  .strict();
export type SessionSubscribeFrame = z.infer<typeof SessionSubscribeFrame>;

export const SessionUnsubscribeFrame = z
  .object({
    type: z.literal("session.unsubscribe"),
    sessionId: z.string().min(1)
  })
  .strict();
export type SessionUnsubscribeFrame = z.infer<typeof SessionUnsubscribeFrame>;

export const SessionInputFrame = z
  .object({
    type: z.literal("session.input"),
    sessionId: z.string().min(1),
    dataBase64: z.string().min(1)
  })
  .strict();
export type SessionInputFrame = z.infer<typeof SessionInputFrame>;

export const SessionResizeFrame = z
  .object({
    type: z.literal("session.resize"),
    sessionId: z.string().min(1),
    cols: z.number().int().positive().max(1000),
    rows: z.number().int().positive().max(1000)
  })
  .strict();
export type SessionResizeFrame = z.infer<typeof SessionResizeFrame>;

export const SessionOutputFrame = z
  .object({
    type: z.literal("session.output"),
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    byteOffset: z.number().int().nonnegative(),
    dataBase64: z.string()
  })
  .strict();
export type SessionOutputFrame = z.infer<typeof SessionOutputFrame>;

export const SessionErrorFrameCode = z.enum([
  "unknown_session",
  "not_active",
  "invalid_message"
]);
export type SessionErrorFrameCode = z.infer<typeof SessionErrorFrameCode>;

export const SessionErrorFrame = z
  .object({
    type: z.literal("session.error"),
    sessionId: z.string().optional(),
    code: SessionErrorFrameCode,
    message: z.string()
  })
  .strict();
export type SessionErrorFrame = z.infer<typeof SessionErrorFrame>;

export const GoalMemoryItem = z
  .object({
    id: z.string(),
    goalId: z.string(),
    type: GoalMemoryType,
    status: GoalMemoryStatus,
    content: z.string().min(1).max(4000),
    contentHash: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
    sourceType: MemorySourceType,
    sourceId: z.string().nullable(),
    sourceSessionId: z.string().nullable(),
    sourceExtractionId: z.string().nullable(),
    sourceOffsetFirst: z.number().int().nonnegative().nullable(),
    sourceOffsetLast: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    promotedAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable()
  })
  .strict();
export type GoalMemoryItem = z.infer<typeof GoalMemoryItem>;

export const GoalDecision = z
  .object({
    id: z.string(),
    goalId: z.string(),
    title: z.string().min(1).max(200),
    decisionText: z.string().min(1).max(4000),
    rationale: z.string().max(4000).nullable(),
    status: GoalDecisionStatus,
    confirmationRequired: z.boolean(),
    confidence: z.number().min(0).max(1).nullable(),
    sourceType: DecisionSourceType,
    sourceId: z.string().nullable(),
    sourceSessionId: z.string().nullable(),
    sourceExtractionId: z.string().nullable(),
    sourceOffsetFirst: z.number().int().nonnegative().nullable(),
    sourceOffsetLast: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    confirmedAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable()
  })
  .strict();
export type GoalDecision = z.infer<typeof GoalDecision>;

export const SessionMemorySummary = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    goalId: z.string(),
    extractionId: z.string(),
    headline: z.string().min(1).max(200),
    summaryText: z.string().min(1).max(4000),
    truncated: z.boolean(),
    sourceOffsetFirst: z.number().int().nonnegative(),
    sourceOffsetLast: z.number().int().nonnegative(),
    createdAt: z.string().datetime()
  })
  .strict();
export type SessionMemorySummary = z.infer<typeof SessionMemorySummary>;

export const MemoryExtraction = z
  .object({
    id: z.string(),
    goalId: z.string(),
    sessionId: z.string(),
    trigger: MemoryExtractionTrigger,
    status: MemoryExtractionStatus,
    extractorVersion: z.string(),
    sourceFingerprint: z.string(),
    sourceOffsetFirst: z.number().int().nonnegative().nullable(),
    sourceOffsetLast: z.number().int().nonnegative().nullable(),
    summaryId: z.string().nullable(),
    itemCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    promotedCount: z.number().int().nonnegative(),
    failureCode: MemoryExtractionFailureCode.nullable(),
    failureMessage: z.string().max(500).nullable(),
    requestedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();
export type MemoryExtraction = z.infer<typeof MemoryExtraction>;

export const CreateGoalMemoryRequest = z
  .object({
    type: GoalMemoryType,
    content: z.string().trim().min(1).max(4000),
    status: z.enum(["candidate", "promoted"]).default("candidate"),
    confidence: z.number().min(0).max(1).optional()
  })
  .strict();
export type CreateGoalMemoryRequest = z.infer<typeof CreateGoalMemoryRequest>;

export const PatchGoalMemoryRequest = z
  .object({
    type: GoalMemoryType.optional(),
    content: z.string().trim().min(1).max(4000).optional(),
    status: GoalMemoryStatus.optional()
  })
  .strict()
  .refine(
    (data) => data.type !== undefined || data.content !== undefined || data.status !== undefined,
    { message: "at least one of type, content, or status must be provided" }
  );
export type PatchGoalMemoryRequest = z.infer<typeof PatchGoalMemoryRequest>;

export const CreateGoalDecisionRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    decisionText: z.string().trim().min(1).max(4000),
    rationale: z.string().max(4000).optional(),
    status: z.enum(["proposed", "confirmed"]).default("proposed"),
    confidence: z.number().min(0).max(1).optional(),
    confirmationRequired: z.boolean().optional()
  })
  .strict();
export type CreateGoalDecisionRequest = z.infer<typeof CreateGoalDecisionRequest>;

export const PatchGoalDecisionRequest = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    decisionText: z.string().trim().min(1).max(4000).optional(),
    rationale: z.string().max(4000).optional(),
    status: GoalDecisionStatus.optional()
  })
  .strict()
  .refine(
    (data) =>
      data.title !== undefined ||
      data.decisionText !== undefined ||
      data.rationale !== undefined ||
      data.status !== undefined,
    {
      message:
        "at least one of title, decisionText, rationale, or status must be provided"
    }
  );
export type PatchGoalDecisionRequest = z.infer<typeof PatchGoalDecisionRequest>;

const SessionExtractionGoalInput = z
  .object({
    id: z.string(),
    title: z.string().min(1).max(200),
    status: GoalStatus,
    archived: z.boolean()
  })
  .strict();

const SessionExtractionRefinementInput = z
  .object({
    id: z.string(),
    problemStatement: z.string().max(4000).optional(),
    constraints: z.array(z.string().min(1).max(200)).optional(),
    successCriteria: z.array(z.string().min(1).max(200)).optional(),
    stakeholders: z.array(z.string().min(1).max(200)).optional()
  })
  .strict();

const SessionExtractionWorkspaceInput = z
  .object({
    id: z.string(),
    label: z.string().min(1).max(200),
    rootPath: z.string().min(1).max(1024)
  })
  .strict();

const SessionExtractionSessionInput = z
  .object({
    id: z.string(),
    adapterId: AdapterId,
    role: z.string().nullable(),
    instructions: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    terminalReason: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    terminatedAt: z.string().datetime().nullable()
  })
  .strict();

const SessionExtractionOutputTailInput = z
  .object({
    text: z.string(),
    byteOffsetFirst: z.number().int().nonnegative(),
    byteOffsetLast: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();

export const SessionExtractionInput = z
  // Internal-only shared schema: used by daemon extraction plumbing and tests.
  .object({
    goal: SessionExtractionGoalInput,
    refinement: SessionExtractionRefinementInput.nullable(),
    workspaces: z.array(SessionExtractionWorkspaceInput),
    session: SessionExtractionSessionInput,
    outputTail: SessionExtractionOutputTailInput,
    extractorVersion: z.string().min(1)
  })
  .strict();
export type SessionExtractionInput = z.infer<typeof SessionExtractionInput>;

export const MemoryCandidate = z
  .object({
    type: GoalMemoryType,
    content: z.string().trim().min(1).max(4000),
    confidence: z.number().min(0).max(1).optional(),
    confirmationRequired: z.boolean().optional(),
    sourceOffsetFirst: z.number().int().nonnegative().optional(),
    sourceOffsetLast: z.number().int().nonnegative().optional(),
    promoteEligible: z.boolean().default(false)
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const DecisionCandidate = z
  .object({
    title: z.string().trim().min(1).max(200),
    decisionText: z.string().trim().min(1).max(4000),
    rationale: z.string().max(4000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    confirmationRequired: z.boolean().default(true),
    sourceOffsetFirst: z.number().int().nonnegative().optional(),
    sourceOffsetLast: z.number().int().nonnegative().optional()
  })
  .strict();
export type DecisionCandidate = z.infer<typeof DecisionCandidate>;

export const SessionExtractionOutput = z
  // Internal-only shared schema: used by daemon extraction plumbing and tests.
  .object({
    summary: z
      .object({
        headline: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(4000),
        truncated: z.boolean()
      })
      .strict()
      .optional(),
    memoryCandidates: z.array(MemoryCandidate).max(25),
    decisionCandidates: z.array(DecisionCandidate).max(10)
  })
  .strict();
export type SessionExtractionOutput = z.infer<typeof SessionExtractionOutput>;

export const ListGoalMemoryResponse = z
  .object({
    items: z.array(GoalMemoryItem)
  })
  .strict();
export type ListGoalMemoryResponse = z.infer<typeof ListGoalMemoryResponse>;

export const ListGoalDecisionsResponse = z
  .object({
    items: z.array(GoalDecision)
  })
  .strict();
export type ListGoalDecisionsResponse = z.infer<typeof ListGoalDecisionsResponse>;

export const OrchestratorChatRole = z.enum([
  "user",
  "orchestrator",
  "system",
  "agent_paraphrased",
  "internal_thought"
]);
export type OrchestratorChatRole = z.infer<typeof OrchestratorChatRole>;

export const OrchestratorChatMessageKind = z.enum(["message"]);
export type OrchestratorChatMessageKind = z.infer<typeof OrchestratorChatMessageKind>;

export const OrchestratorInternalThoughtKind = z.enum([
  "step_started",
  "thinking",
  "agent_invocation",
  "schema_validation",
  "revise",
  "agent_crash",
  "mark_done_ready"
]);
export type OrchestratorInternalThoughtKind = z.infer<
  typeof OrchestratorInternalThoughtKind
>;

export const OrchestratorChatMessage = z
  .object({
    id: z.string(),
    goalId: z.string(),
    role: OrchestratorChatRole,
    kind: OrchestratorChatMessageKind,
    body: z.string().trim().min(1).max(20_000),
    correlationId: z.string().nullable(),
    rawAgentText: z.string().max(200_000).nullable().optional(),
    whyRationale: z.string().max(4000).nullable().optional(),
    internalKind: OrchestratorInternalThoughtKind.nullable().optional(),
    createdAt: z.string().datetime()
  })
  .strict();
export type OrchestratorChatMessage = z.infer<typeof OrchestratorChatMessage>;

export const ListOrchestratorMessagesResponse = z
  .object({
    messages: z.array(OrchestratorChatMessage)
  })
  .strict();
export type ListOrchestratorMessagesResponse = z.infer<
  typeof ListOrchestratorMessagesResponse
>;

export const CreateOrchestratorMessageRequest = z
  .object({
    body: z.string().trim().min(1).max(4000)
  })
  .strict();
export type CreateOrchestratorMessageRequest = z.infer<
  typeof CreateOrchestratorMessageRequest
>;

export const CreateOrchestratorMessageResponse = z
  .object({
    message: OrchestratorChatMessage,
    reply: OrchestratorChatMessage.nullable()
  })
  .strict();
export type CreateOrchestratorMessageResponse = z.infer<
  typeof CreateOrchestratorMessageResponse
>;

export const GetSessionMemorySummaryResponse = z
  .object({
    summary: SessionMemorySummary.nullable()
  })
  .strict();
export type GetSessionMemorySummaryResponse = z.infer<
  typeof GetSessionMemorySummaryResponse
>;

export const ExtractSessionMemoryResponse = z
  .object({
    extraction: MemoryExtraction
  })
  .strict();
export type ExtractSessionMemoryResponse = z.infer<
  typeof ExtractSessionMemoryResponse
>;

export const MemoryExtractionRequestedEventPayload = z
  .object({
    extractionId: z.string(),
    goalId: z.string(),
    sessionId: z.string(),
    trigger: MemoryExtractionTrigger
  })
  .strict();
export type MemoryExtractionRequestedEventPayload = z.infer<
  typeof MemoryExtractionRequestedEventPayload
>;

export const MemoryExtractionStartedEventPayload = z
  .object({
    extractionId: z.string(),
    goalId: z.string(),
    sessionId: z.string()
  })
  .strict();
export type MemoryExtractionStartedEventPayload = z.infer<
  typeof MemoryExtractionStartedEventPayload
>;

export const MemoryExtractionCompletedEventPayload = z
  .object({
    extractionId: z.string(),
    goalId: z.string(),
    sessionId: z.string(),
    summaryId: z.string().nullable(),
    itemCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    promotedCount: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();
export type MemoryExtractionCompletedEventPayload = z.infer<
  typeof MemoryExtractionCompletedEventPayload
>;

export const MemoryExtractionFailedEventPayload = z
  .object({
    extractionId: z.string(),
    goalId: z.string(),
    sessionId: z.string(),
    failureCode: MemoryExtractionFailureCode
  })
  .strict();
export type MemoryExtractionFailedEventPayload = z.infer<
  typeof MemoryExtractionFailedEventPayload
>;

export const MemoryItemCreatedEventPayload = z
  .object({
    memoryItemId: z.string(),
    goalId: z.string(),
    type: GoalMemoryType,
    status: z.enum(["candidate", "promoted"]),
    sourceType: MemorySourceType,
    sourceSessionId: z.string().nullable(),
    sourceExtractionId: z.string().nullable()
  })
  .strict();
export type MemoryItemCreatedEventPayload = z.infer<
  typeof MemoryItemCreatedEventPayload
>;

export const MemoryItemUpdatedEventPayload = z
  .object({
    memoryItemId: z.string(),
    goalId: z.string(),
    type: GoalMemoryType,
    status: z.enum(["candidate", "promoted"])
  })
  .strict();
export type MemoryItemUpdatedEventPayload = z.infer<
  typeof MemoryItemUpdatedEventPayload
>;

export const MemoryItemPromotedEventPayload = z
  .object({
    memoryItemId: z.string(),
    goalId: z.string(),
    type: GoalMemoryType
  })
  .strict();
export type MemoryItemPromotedEventPayload = z.infer<
  typeof MemoryItemPromotedEventPayload
>;

export const MemoryItemArchivedEventPayload = z
  .object({
    memoryItemId: z.string(),
    goalId: z.string()
  })
  .strict();
export type MemoryItemArchivedEventPayload = z.infer<
  typeof MemoryItemArchivedEventPayload
>;

export const DecisionCreatedEventPayload = z
  .object({
    decisionId: z.string(),
    goalId: z.string(),
    status: z.enum(["proposed", "confirmed"]),
    confirmationRequired: z.boolean(),
    sourceType: DecisionSourceType,
    sourceSessionId: z.string().nullable(),
    sourceExtractionId: z.string().nullable()
  })
  .strict();
export type DecisionCreatedEventPayload = z.infer<typeof DecisionCreatedEventPayload>;

export const DecisionUpdatedEventPayload = z
  .object({
    decisionId: z.string(),
    goalId: z.string(),
    status: z.enum(["proposed", "confirmed"])
  })
  .strict();
export type DecisionUpdatedEventPayload = z.infer<typeof DecisionUpdatedEventPayload>;

export const DecisionConfirmedEventPayload = z
  .object({
    decisionId: z.string(),
    goalId: z.string()
  })
  .strict();
export type DecisionConfirmedEventPayload = z.infer<
  typeof DecisionConfirmedEventPayload
>;

export const DecisionArchivedEventPayload = z
  .object({
    decisionId: z.string(),
    goalId: z.string()
  })
  .strict();
export type DecisionArchivedEventPayload = z.infer<typeof DecisionArchivedEventPayload>;

export const MemoryEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("memory.extraction.requested"),
      payload: MemoryExtractionRequestedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.extraction.started"),
      payload: MemoryExtractionStartedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.extraction.completed"),
      payload: MemoryExtractionCompletedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.extraction.failed"),
      payload: MemoryExtractionFailedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.item.created"),
      payload: MemoryItemCreatedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.item.updated"),
      payload: MemoryItemUpdatedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.item.promoted"),
      payload: MemoryItemPromotedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("memory.item.archived"),
      payload: MemoryItemArchivedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.created"),
      payload: DecisionCreatedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.updated"),
      payload: DecisionUpdatedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.confirmed"),
      payload: DecisionConfirmedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.archived"),
      payload: DecisionArchivedEventPayload
    })
    .strict()
]);
export type MemoryEvent = z.infer<typeof MemoryEvent>;

export const CONTEXT_PACKAGE_MAX_RENDERED_BYTES = 32 * 1024;
export const CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS = 4000;
export const CONTEXT_PACKAGE_MAX_WARNING_COUNT = 10;
export const CONTEXT_PACKAGE_MAX_WARNING_CHARS = 200;
export const CONTEXT_PACKAGE_MAX_SOURCE_COUNT = 60;

export const ContextSourceRef = z
  .object({
    type: ContextSourceType,
    id: z.string(),
    sourceSessionId: z.string().nullable().optional(),
    label: z.string().min(1).max(64),
    reason: ContextSourceReason,
    marker: z.string().min(1).max(64)
  })
  .strict();
export type ContextSourceRef = z.infer<typeof ContextSourceRef>;

export const ContextPackage = z
  .object({
    id: z.string(),
    goalId: z.string(),
    supersedesPackageId: z.string().nullable().optional(),
    adapterId: AdapterId,
    workspaceId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    fromRecommendationId: z.string().nullable().optional(),
    workflowStepRunId: z.string().nullable().optional(),
    role: ContextRole,
    objective: z.string().max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
    status: ContextPackageStatus,
    renderedContext: z
      .string()
      .refine(
        (value) => utf8ByteLength(value) <= CONTEXT_PACKAGE_MAX_RENDERED_BYTES,
        `renderedContext must be at most ${CONTEXT_PACKAGE_MAX_RENDERED_BYTES} bytes`
      ),
    renderedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(CONTEXT_PACKAGE_MAX_RENDERED_BYTES),
    estimatedTokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sparse: z.boolean(),
    sourceCount: z.number().int().nonnegative(),
    sources: z.array(ContextSourceRef).max(CONTEXT_PACKAGE_MAX_SOURCE_COUNT),
    warnings: z
      .array(z.string().max(CONTEXT_PACKAGE_MAX_WARNING_CHARS))
      .max(CONTEXT_PACKAGE_MAX_WARNING_COUNT),
    sourceFingerprint: z.string(),
    assemblerVersion: z.string(),
    createdAt: z.string().datetime()
  })
  .strict();
export type ContextPackage = z.infer<typeof ContextPackage>;

export const ContextAssembly = z
  .object({
    id: z.string(),
    goalId: z.string(),
    packageId: z.string().nullable().optional(),
    replacePackageId: z.string().nullable().optional(),
    adapterId: AdapterId,
    workspaceId: z.string().nullable().optional(),
    role: ContextRole,
    objectiveHash: z.string(),
    sourceFingerprint: z.string(),
    assemblerVersion: z.string(),
    requestFingerprint: z.string(),
    status: ContextAssemblyStatus,
    trigger: ContextAssemblyTrigger,
    failureCode: ContextAssemblyFailureCode.nullable().optional(),
    failureMessage: z.string().max(256).nullable().optional(),
    requestedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional()
  })
  .strict();
export type ContextAssembly = z.infer<typeof ContextAssembly>;

export const CreateContextPackageRequest = z
  .object({
    adapterId: AdapterId,
    role: ContextRole,
    objective: z.string().trim().min(1).max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
    workspaceId: z.string().min(1).optional(),
    replacePackageId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    fromRecommendationId: z.string().min(1).optional(),
    workflowStepRunId: z.string().min(1).optional()
  })
  .strict();
export type CreateContextPackageRequest = z.infer<typeof CreateContextPackageRequest>;

export const ListContextPackagesQuery = z
  .object({
    sessionId: z.string().min(1).optional(),
    adapterId: AdapterId.optional(),
    limit: z.coerce.number().int().positive().max(50).default(20)
  })
  .strict();
export type ListContextPackagesQuery = z.infer<typeof ListContextPackagesQuery>;

export const CreateContextPackageResponse = z
  .object({
    package: ContextPackage.nullable(),
    assembly: ContextAssembly,
    reused: z.boolean()
  })
  .strict()
  .refine(
    (value) => (value.package === null ? value.assembly.status === "failed" : true),
    { message: "package can be null only when assembly.status is failed" }
  );
export type CreateContextPackageResponse = z.infer<typeof CreateContextPackageResponse>;

export const ListContextPackagesResponse = z
  .object({
    packages: z.array(ContextPackage),
    assemblies: z.array(ContextAssembly)
  })
  .strict();
export type ListContextPackagesResponse = z.infer<typeof ListContextPackagesResponse>;

export const GetContextPackageResponse = z
  .object({
    package: ContextPackage
  })
  .strict();
export type GetContextPackageResponse = z.infer<typeof GetContextPackageResponse>;

export const ContextAssemblyRequestedEventPayload = z
  .object({
    assemblyId: z.string(),
    goalId: z.string(),
    adapterId: AdapterId,
    role: ContextRole
  })
  .strict();
export type ContextAssemblyRequestedEventPayload = z.infer<
  typeof ContextAssemblyRequestedEventPayload
>;

export const ContextAssemblyCompletedEventPayload = z
  .object({
    assemblyId: z.string(),
    goalId: z.string(),
    packageId: z.string(),
    sourceCount: z.number().int().nonnegative(),
    renderedBytes: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();
export type ContextAssemblyCompletedEventPayload = z.infer<
  typeof ContextAssemblyCompletedEventPayload
>;

export const ContextAssemblyFailedEventPayload = z
  .object({
    assemblyId: z.string(),
    goalId: z.string(),
    failureCode: ContextAssemblyFailureCode
  })
  .strict();
export type ContextAssemblyFailedEventPayload = z.infer<
  typeof ContextAssemblyFailedEventPayload
>;

export const ContextPackageCreatedEventPayload = z
  .object({
    packageId: z.string(),
    goalId: z.string(),
    adapterId: AdapterId,
    role: ContextRole,
    taskId: z.string().nullable().optional(),
    fromRecommendationId: z.string().nullable().optional(),
    sourceCount: z.number().int().nonnegative(),
    renderedBytes: z.number().int().nonnegative()
  })
  .strict();
export type ContextPackageCreatedEventPayload = z.infer<
  typeof ContextPackageCreatedEventPayload
>;

export const ContextEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("context.assembly.requested"),
      payload: ContextAssemblyRequestedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("context.assembly.completed"),
      payload: ContextAssemblyCompletedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("context.assembly.failed"),
      payload: ContextAssemblyFailedEventPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("context.package.created"),
      payload: ContextPackageCreatedEventPayload
    })
    .strict()
]);
export type ContextEvent = z.infer<typeof ContextEvent>;

export const SessionCreatedEventPayload = z
  .object({
    sessionId: z.string(),
    goalId: z.string(),
    workspaceId: z.string(),
    adapterId: AdapterId,
    contextPackageId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    fromRecommendationId: z.string().nullable().optional()
  })
  .strict();
export type SessionCreatedEventPayload = z.infer<typeof SessionCreatedEventPayload>;

export const ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS = 256;
export const ORCHESTRATION_TASK_MAX_TITLE_CHARS = 256;
export const ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS = 8 * 1024;
export const ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA = 20;
export const ORCHESTRATION_TASK_MAX_VALIDATION_STEPS = 20;
export const ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS = 256;
export const ORCHESTRATION_TASK_MAX_SOURCES = 32;
export const ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS = 256;
export const ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS = 4 * 1024;
export const ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES = 4 * 1024;
export const ORCHESTRATION_RECOMMENDATION_MAX_SOURCES = 32;
export const ORCHESTRATION_CONFLICT_MAX_DESCRIPTION_CHARS = 1024;
export const ORCHESTRATION_CONFLICT_MAX_RESOLUTION_NOTE_CHARS = 4 * 1024;
export const ORCHESTRATION_FEEDBACK_MAX_NOTE_CHARS = 2 * 1024;
export const ORCHESTRATION_SOURCE_REF_MAX_REASON_CHARS = 128;
export const ORCHESTRATION_EVENT_MAX_PAYLOAD_BYTES = 4 * 1024;

export const GenerationLifecycleStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed"
]);
export type GenerationLifecycleStatus = z.infer<typeof GenerationLifecycleStatus>;

export const OrchestrationFailureCode = z.enum([
  "invalid_input",
  "invalid_output",
  "provider_error",
  "daemon_restart",
  "goal_archived",
  "sparse_input",
  "internal_error"
]);
export type OrchestrationFailureCode = z.infer<typeof OrchestrationFailureCode>;

export const TriggerKind = z.enum([
  "manual",
  "refinement_applied",
  "session_completed",
  "session_summary_created",
  "session_summary_updated",
  "memory_promoted",
  "memory_canonical",
  "decision_confirmed",
  "decision_confirmation_required",
  "context_package_created",
  "task_created",
  "task_status_changed",
  "conflict_detected",
  "user_feedback_recorded"
]);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const TaskRole = z.enum([
  "architect",
  "engineer",
  "reviewer",
  "qa",
  "generalist"
]);
export type TaskRole = z.infer<typeof TaskRole>;

export const TaskStatus = z.enum([
  "proposed",
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "archived"
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskOrigin = z.enum(["user", "generator", "recommendation"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const TaskSourceRefType = z.enum([
  "refinement",
  "memory_item",
  "decision",
  "session_summary",
  "context_package",
  "recommendation"
]);
export type TaskSourceRefType = z.infer<typeof TaskSourceRefType>;

export const TaskSourceRef = z
  .object({
    type: TaskSourceRefType,
    id: z.string().min(1),
    reason: z.string().max(ORCHESTRATION_SOURCE_REF_MAX_REASON_CHARS).optional()
  })
  .strict();
export type TaskSourceRef = z.infer<typeof TaskSourceRef>;

export const TaskAcceptanceCriterion = z
  .object({
    id: z.string(),
    text: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS)
  })
  .strict();
export type TaskAcceptanceCriterion = z.infer<typeof TaskAcceptanceCriterion>;

export const TaskValidationStepKind = z.enum(["manual", "test", "review", "qa"]);
export type TaskValidationStepKind = z.infer<typeof TaskValidationStepKind>;

export const TaskValidationStep = z
  .object({
    id: z.string(),
    text: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS),
    kind: TaskValidationStepKind
  })
  .strict();
export type TaskValidationStep = z.infer<typeof TaskValidationStep>;

export const TaskFieldKey = z.enum([
  "title",
  "description",
  "role",
  "workspaceId",
  "status",
  "acceptanceCriteria",
  "validationSteps",
  "dependencies",
  "sources",
  "parentTaskId",
  "archivedAt"
]);
export type TaskFieldKey = z.infer<typeof TaskFieldKey>;

export const Task = z
  .object({
    id: z.string(),
    goalId: z.string(),
    parentTaskId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    role: TaskRole,
    status: TaskStatus,
    origin: TaskOrigin,
    title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS),
    description: z.string().max(ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS),
    acceptanceCriteria: z
      .array(TaskAcceptanceCriterion)
      .max(ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA),
    validationSteps: z.array(TaskValidationStep).max(ORCHESTRATION_TASK_MAX_VALIDATION_STEPS),
    dependencies: z.array(z.string().min(1)),
    sources: z.array(TaskSourceRef).max(ORCHESTRATION_TASK_MAX_SOURCES),
    generationId: z.string().nullable(),
    workflowStepRunId: z.string().nullable().optional(),
    fingerprint: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable()
  })
  .strict();
export type Task = z.infer<typeof Task>;

export const TaskGenerationTrigger = z.enum(["manual", "refinement_applied"]);
export type TaskGenerationTrigger = z.infer<typeof TaskGenerationTrigger>;

export const TaskGeneration = z
  .object({
    id: z.string(),
    goalId: z.string(),
    trigger: TaskGenerationTrigger,
    triggerSourceId: z.string().nullable(),
    generatorId: z.string(),
    generatorVersion: z.string(),
    inputFingerprint: z.string(),
    requestFingerprint: z.string(),
    status: GenerationLifecycleStatus,
    failureCode: OrchestrationFailureCode.nullable(),
    failureMessage: z
      .string()
      .max(ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS)
      .nullable(),
    sparse: z.boolean(),
    requestedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();
export type TaskGeneration = z.infer<typeof TaskGeneration>;

export const RecommendationType = z.enum([
  "create_session",
  "continue_session",
  "review_output",
  "refine_goal",
  "split_task",
  "run_validation",
  "resolve_conflict",
  "update_plan",
  "ask_user",
  "mark_complete",
  "pause_work",
  "advance_workflow_step",
  "launch_workflow_session",
  "complete_workflow_run",
  "mark_artifact_satisfied",
  "request_user_input"
]);
export type RecommendationType = z.infer<typeof RecommendationType>;

export const RecommendationStatus = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "dismissed",
  "modified",
  "superseded"
]);
export type RecommendationStatus = z.infer<typeof RecommendationStatus>;

export const RecommendationSource = z.enum([
  "deterministic_provider",
  "user_modified"
]);
export type RecommendationSource = z.infer<typeof RecommendationSource>;

export const RecommendationSourceRefType = z.enum([
  "goal",
  "refinement",
  "workspace",
  "task",
  "memory_item",
  "decision",
  "session_summary",
  "session",
  "context_package",
  "conflict"
]);
export type RecommendationSourceRefType = z.infer<typeof RecommendationSourceRefType>;

export const RecommendationSourceRef = z
  .object({
    type: RecommendationSourceRefType,
    id: z.string().min(1),
    reason: z.string().max(ORCHESTRATION_SOURCE_REF_MAX_REASON_CHARS).optional()
  })
  .strict();
export type RecommendationSourceRef = z.infer<typeof RecommendationSourceRef>;

export const RecommendationFeedbackAction = z.enum([
  "accept",
  "reject",
  "dismiss",
  "modify"
]);
export type RecommendationFeedbackAction = z.infer<
  typeof RecommendationFeedbackAction
>;

const RecommendationActionRole = z.enum([
  "architect",
  "engineer",
  "reviewer",
  "qa",
  "generalist"
]);
type RecommendationActionRole = z.infer<typeof RecommendationActionRole>;

export const RefinementFieldKey = z.enum([
  "objective",
  "success_criteria",
  "constraints",
  "scope_notes",
  "assumptions"
]);
export type RefinementFieldKey = z.infer<typeof RefinementFieldKey>;

export const ProposedActionKind = RecommendationType;
export type ProposedActionKind = z.infer<typeof ProposedActionKind>;

export const ProposedAction = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("create_session"),
        adapterId: AdapterId,
        workspaceId: z.string().min(1).optional(),
        role: RecommendationActionRole,
        objective: z.string().trim().min(1).max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
        contextPackageId: z.string().min(1).optional(),
        contextRequest: z
          .object({
            adapterId: AdapterId,
            role: ContextRole,
            objective: z
              .string()
              .trim()
              .min(1)
              .max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
            workspaceId: z.string().min(1).optional()
          })
          .strict()
          .optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("continue_session"),
        sessionId: z.string().min(1)
      })
      .strict(),
    z
      .object({
        kind: z.literal("review_output"),
        sessionId: z.string().min(1),
        reviewerRole: z.enum(["reviewer", "qa"]).optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("refine_goal"),
        missingFields: z.array(RefinementFieldKey).min(1).max(20)
      })
      .strict(),
    z
      .object({
        kind: z.literal("split_task"),
        taskId: z.string().min(1),
        suggestedChildren: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS),
                role: TaskRole.optional()
              })
              .strict()
          )
          .min(1)
          .max(20)
      })
      .strict(),
    z
      .object({
        kind: z.literal("run_validation"),
        taskId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        suggestedRole: z.enum(["reviewer", "qa"]),
        objective: z.string().trim().min(1).max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS)
      })
      .strict(),
    z
      .object({
        kind: z.literal("resolve_conflict"),
        conflictId: z.string().min(1),
        suggestedResolutionNote: z
          .string()
          .max(ORCHESTRATION_CONFLICT_MAX_RESOLUTION_NOTE_CHARS)
          .optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("update_plan"),
        taskId: z.string().min(1),
        suggestedStatus: TaskStatus.optional(),
        addAcceptanceCriteria: z
          .array(z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS))
          .max(ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA)
          .optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal("ask_user"),
        question: z.string().trim().min(1).max(1024)
      })
      .strict(),
    z
      .object({
        kind: z.literal("mark_complete"),
        taskId: z.string().min(1)
      })
      .strict(),
    z
      .object({
        kind: z.literal("pause_work"),
        reason: z.string().trim().min(1).max(1024),
        relatedTaskIds: z.array(z.string().min(1)).max(20)
      })
      .strict(),
    z
      .object({
        kind: z.literal("advance_workflow_step"),
        workflowRunId: z.string().min(1),
        workflowStepRunId: z.string().min(1),
        toStepTemplateId: z.string().min(1).max(100)
      })
      .strict(),
    z
      .object({
        kind: z.literal("launch_workflow_session"),
        workflowStepRunId: z.string().min(1),
        operatorId: z.string().min(1).max(100),
        operatorKind: OperatorKind,
        objective: z.string().trim().min(1).max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS)
      })
      .strict(),
    z
      .object({
        kind: z.literal("complete_workflow_run"),
        workflowRunId: z.string().min(1),
        workflowStepRunId: z.string().min(1)
      })
      .strict(),
    z
      .object({
        kind: z.literal("mark_artifact_satisfied"),
        workflowStepRunId: z.string().min(1),
        artifactType: WorkflowArtifactType
      })
      .strict(),
    z
      .object({
        kind: z.literal("request_user_input"),
        workflowStepRunId: z.string().min(1),
        question: z.string().trim().min(1).max(1024)
      })
      .strict()
  ])
  .superRefine((value, ctx) => {
    if (
      value.kind === "run_validation" &&
      value.taskId === undefined &&
      value.sessionId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run_validation requires taskId or sessionId"
      });
    }

    if (!hasMaxSerializedBytes(value, ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `proposedAction must be at most ${ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES} bytes when serialized`
      });
    }
  });
export type ProposedAction = z.infer<typeof ProposedAction>;

export const RecommendationFieldKey = z.enum([
  "title",
  "rationale",
  "proposedAction",
  "status",
  "source",
  "supersededById"
]);
export type RecommendationFieldKey = z.infer<typeof RecommendationFieldKey>;

export const Recommendation = z
  .object({
    id: z.string(),
    goalId: z.string(),
    type: RecommendationType,
    status: RecommendationStatus,
    source: RecommendationSource,
    title: z.string().trim().min(1).max(ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS),
    rationale: z.string().max(ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS),
    proposedAction: ProposedAction,
    confidence: z.number().min(0).max(1),
    sources: z.array(RecommendationSourceRef).max(ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
    relatedTaskId: z.string().nullable(),
    relatedSessionId: z.string().nullable(),
    relatedContextPackageId: z.string().nullable(),
    relatedConflictId: z.string().nullable(),
    generationId: z.string().nullable(),
    workflowStepRunId: z.string().nullable().optional(),
    fingerprint: z.string(),
    supersededById: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type Recommendation = z.infer<typeof Recommendation>;

export const RecommendationGeneration = z
  .object({
    id: z.string(),
    goalId: z.string(),
    trigger: TriggerKind,
    triggerSourceId: z.string().nullable(),
    providerId: z.string(),
    providerVersion: z.string(),
    inputFingerprint: z.string(),
    requestFingerprint: z.string(),
    status: GenerationLifecycleStatus,
    failureCode: OrchestrationFailureCode.nullable(),
    failureMessage: z
      .string()
      .max(ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS)
      .nullable(),
    sparse: z.boolean(),
    requestedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();
export type RecommendationGeneration = z.infer<typeof RecommendationGeneration>;

export const RecommendationFeedback = z
  .object({
    id: z.string(),
    goalId: z.string(),
    recommendationId: z.string(),
    action: RecommendationFeedbackAction,
    note: z.string().max(ORCHESTRATION_FEEDBACK_MAX_NOTE_CHARS).nullable(),
    modifiedPayloadJson: z
      .string()
      .max(ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES)
      .nullable(),
    createdAt: z.string().datetime()
  })
  .strict();
export type RecommendationFeedback = z.infer<typeof RecommendationFeedback>;

export const ConflictType = z.enum([
  "workspace_overlap",
  "contradictory_decisions",
  "reviewer_rejection",
  "blocker_reported",
  "unresolved_question"
]);
export type ConflictType = z.infer<typeof ConflictType>;

export const ConflictSeverity = z.enum(["info", "warning", "blocker"]);
export type ConflictSeverity = z.infer<typeof ConflictSeverity>;

export const ConflictStatus = z.enum(["open", "resolved", "dismissed"]);
export type ConflictStatus = z.infer<typeof ConflictStatus>;

export const ConflictSourceRefType = z.enum([
  "session",
  "workspace",
  "task",
  "decision",
  "memory_item",
  "session_summary"
]);
export type ConflictSourceRefType = z.infer<typeof ConflictSourceRefType>;

export const ConflictSourceRef = z
  .object({
    type: ConflictSourceRefType,
    id: z.string().min(1),
    role: z.enum(["subject_a", "subject_b", "context"]).optional()
  })
  .strict();
export type ConflictSourceRef = z.infer<typeof ConflictSourceRef>;

export const Conflict = z
  .object({
    id: z.string(),
    goalId: z.string(),
    conflictType: ConflictType,
    severity: ConflictSeverity,
    status: ConflictStatus,
    title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS),
    description: z.string().max(ORCHESTRATION_CONFLICT_MAX_DESCRIPTION_CHARS),
    sources: z.array(ConflictSourceRef).max(ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
    fingerprint: z.string(),
    resolutionNote: z
      .string()
      .max(ORCHESTRATION_CONFLICT_MAX_RESOLUTION_NOTE_CHARS)
      .nullable(),
    detectedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable()
  })
  .strict();
export type Conflict = z.infer<typeof Conflict>;

export const OrchestrationEventType = z.enum([
  "task.generation.requested",
  "task.generated",
  "task.generation.failed",
  "task.created",
  "task.updated",
  "task.split",
  "task.status_changed",
  "task.associated_with_session",
  "task.associated_with_context_package",
  "recommendation.generation.requested",
  "recommendation.generated",
  "recommendation.generation.failed",
  "recommendation.accepted",
  "recommendation.rejected",
  "recommendation.dismissed",
  "recommendation.modified",
  "recommendation.superseded",
  "conflict.detected",
  "conflict.resolved",
  "conflict.dismissed",
  "user.feedback.recorded"
]);
export type OrchestrationEventType = z.infer<typeof OrchestrationEventType>;

export const TaskGenerationRequestedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    trigger: TaskGenerationTrigger,
    triggerSourceId: z.string().nullable()
  })
  .strict();
export type TaskGenerationRequestedPayload = z.infer<
  typeof TaskGenerationRequestedPayload
>;

export const TaskGeneratedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    taskIds: z.array(z.string()),
    count: z.number().int().nonnegative(),
    sparse: z.boolean()
  })
  .strict();
export type TaskGeneratedPayload = z.infer<typeof TaskGeneratedPayload>;

export const TaskGenerationFailedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    failureCode: OrchestrationFailureCode
  })
  .strict();
export type TaskGenerationFailedPayload = z.infer<typeof TaskGenerationFailedPayload>;

export const TaskCreatedPayload = z
  .object({
    taskId: z.string(),
    goalId: z.string(),
    status: TaskStatus,
    role: TaskRole,
    workspaceId: z.string().nullable(),
    origin: TaskOrigin,
    generationId: z.string().nullable()
  })
  .strict();
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayload>;

export const TaskUpdatedPayload = z
  .object({
    taskId: z.string(),
    goalId: z.string(),
    changedFields: z.array(TaskFieldKey)
  })
  .strict();
export type TaskUpdatedPayload = z.infer<typeof TaskUpdatedPayload>;

export const TaskSplitPayload = z
  .object({
    parentTaskId: z.string(),
    childTaskIds: z.array(z.string()),
    goalId: z.string()
  })
  .strict();
export type TaskSplitPayload = z.infer<typeof TaskSplitPayload>;

export const TaskStatusChangedReason = z.enum([
  "user",
  "recommendation_accepted",
  "session_associated"
]);
export type TaskStatusChangedReason = z.infer<typeof TaskStatusChangedReason>;

export const TaskStatusChangedPayload = z
  .object({
    taskId: z.string(),
    goalId: z.string(),
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    reason: TaskStatusChangedReason
  })
  .strict();
export type TaskStatusChangedPayload = z.infer<typeof TaskStatusChangedPayload>;

export const TaskAssociatedWithSessionPayload = z
  .object({
    taskId: z.string(),
    goalId: z.string(),
    sessionId: z.string()
  })
  .strict();
export type TaskAssociatedWithSessionPayload = z.infer<
  typeof TaskAssociatedWithSessionPayload
>;

export const TaskAssociatedWithContextPackagePayload = z
  .object({
    taskId: z.string(),
    goalId: z.string(),
    contextPackageId: z.string()
  })
  .strict();
export type TaskAssociatedWithContextPackagePayload = z.infer<
  typeof TaskAssociatedWithContextPackagePayload
>;

export const RecommendationGenerationRequestedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    trigger: TriggerKind,
    triggerSourceId: z.string().nullable()
  })
  .strict();
export type RecommendationGenerationRequestedPayload = z.infer<
  typeof RecommendationGenerationRequestedPayload
>;

export const RecommendationGeneratedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    recommendationIds: z.array(z.string()),
    supersededIds: z.array(z.string()),
    count: z.number().int().nonnegative(),
    sparse: z.boolean()
  })
  .strict();
export type RecommendationGeneratedPayload = z.infer<
  typeof RecommendationGeneratedPayload
>;

export const RecommendationGenerationFailedPayload = z
  .object({
    generationId: z.string(),
    goalId: z.string(),
    failureCode: OrchestrationFailureCode
  })
  .strict();
export type RecommendationGenerationFailedPayload = z.infer<
  typeof RecommendationGenerationFailedPayload
>;

export const RecommendationAcceptedPayload = z
  .object({
    recommendationId: z.string(),
    goalId: z.string(),
    type: RecommendationType
  })
  .strict();
export type RecommendationAcceptedPayload = z.infer<
  typeof RecommendationAcceptedPayload
>;

export const RecommendationRejectedPayload = z
  .object({
    recommendationId: z.string(),
    goalId: z.string(),
    type: RecommendationType
  })
  .strict();
export type RecommendationRejectedPayload = z.infer<
  typeof RecommendationRejectedPayload
>;

export const RecommendationDismissedPayload = z
  .object({
    recommendationId: z.string(),
    goalId: z.string(),
    type: RecommendationType
  })
  .strict();
export type RecommendationDismissedPayload = z.infer<
  typeof RecommendationDismissedPayload
>;

export const RecommendationModifiedPayload = z
  .object({
    recommendationId: z.string(),
    goalId: z.string(),
    changedFields: z.array(RecommendationFieldKey)
  })
  .strict();
export type RecommendationModifiedPayload = z.infer<
  typeof RecommendationModifiedPayload
>;

export const RecommendationSupersededPayload = z
  .object({
    recommendationId: z.string(),
    goalId: z.string(),
    bySupersedingId: z.string().nullable(),
    reason: z.enum(["duplicate", "source_archived", "manual"])
  })
  .strict();
export type RecommendationSupersededPayload = z.infer<
  typeof RecommendationSupersededPayload
>;

export const ConflictDetectedPayload = z
  .object({
    conflictId: z.string(),
    goalId: z.string(),
    conflictType: ConflictType,
    severity: ConflictSeverity
  })
  .strict();
export type ConflictDetectedPayload = z.infer<typeof ConflictDetectedPayload>;

export const ConflictResolvedPayload = z
  .object({
    conflictId: z.string(),
    goalId: z.string(),
    resolution: z.literal("resolved")
  })
  .strict();
export type ConflictResolvedPayload = z.infer<typeof ConflictResolvedPayload>;

export const ConflictDismissedPayload = z
  .object({
    conflictId: z.string(),
    goalId: z.string(),
    resolution: z.literal("dismissed")
  })
  .strict();
export type ConflictDismissedPayload = z.infer<typeof ConflictDismissedPayload>;

export const UserFeedbackRecordedPayload = z
  .object({
    feedbackId: z.string(),
    goalId: z.string(),
    recommendationId: z.string(),
    action: RecommendationFeedbackAction
  })
  .strict();
export type UserFeedbackRecordedPayload = z.infer<typeof UserFeedbackRecordedPayload>;

export const OrchestrationEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("task.generation.requested"),
      payload: TaskGenerationRequestedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.generated"),
      payload: TaskGeneratedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.generation.failed"),
      payload: TaskGenerationFailedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.created"),
      payload: TaskCreatedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.updated"),
      payload: TaskUpdatedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.split"),
      payload: TaskSplitPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.status_changed"),
      payload: TaskStatusChangedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.associated_with_session"),
      payload: TaskAssociatedWithSessionPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("task.associated_with_context_package"),
      payload: TaskAssociatedWithContextPackagePayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.generation.requested"),
      payload: RecommendationGenerationRequestedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.generated"),
      payload: RecommendationGeneratedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.generation.failed"),
      payload: RecommendationGenerationFailedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.accepted"),
      payload: RecommendationAcceptedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.rejected"),
      payload: RecommendationRejectedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.dismissed"),
      payload: RecommendationDismissedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.modified"),
      payload: RecommendationModifiedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("recommendation.superseded"),
      payload: RecommendationSupersededPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("conflict.detected"),
      payload: ConflictDetectedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("conflict.resolved"),
      payload: ConflictResolvedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("conflict.dismissed"),
      payload: ConflictDismissedPayload
    })
    .strict(),
  z
    .object({
      type: z.literal("user.feedback.recorded"),
      payload: UserFeedbackRecordedPayload
    })
    .strict()
]).superRefine((event, ctx) => {
  if (!hasMaxSerializedBytes(event.payload, ORCHESTRATION_EVENT_MAX_PAYLOAD_BYTES)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: `orchestration event payload must be at most ${ORCHESTRATION_EVENT_MAX_PAYLOAD_BYTES} bytes when serialized`
    });
  }
});
export type OrchestrationEvent = z.infer<typeof OrchestrationEvent>;

export const TaskGenerationRequest = z
  .object({
    trigger: z.literal("manual")
  })
  .strict();
export type TaskGenerationRequest = z.infer<typeof TaskGenerationRequest>;

export const TaskGenerationResponse = z
  .object({
    generation: TaskGeneration
  })
  .strict();
export type TaskGenerationResponse = z.infer<typeof TaskGenerationResponse>;

export const ListTasksQuery = z
  .object({
    status: TaskStatus.optional(),
    workspaceId: z.string().min(1).optional(),
    role: TaskRole.optional(),
    parentTaskId: z.string().min(1).optional(),
    includeArchived: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().positive().max(200).default(50),
    cursor: z.string().min(1).optional()
  })
  .strict();
export type ListTasksQuery = z.infer<typeof ListTasksQuery>;

export const ListTasksResponse = z
  .object({
    tasks: z.array(Task),
    generations: z.array(TaskGeneration)
  })
  .strict();
export type ListTasksResponse = z.infer<typeof ListTasksResponse>;

export const TaskDraftValidationStep = z
  .object({
    text: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS),
    kind: TaskValidationStepKind.default("manual")
  })
  .strict();
export type TaskDraftValidationStep = z.infer<typeof TaskDraftValidationStep>;

export const CreateTaskRequest = z
  .object({
    title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS),
    description: z.string().max(ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS).default(""),
    role: TaskRole,
    workspaceId: z.string().min(1).nullable().default(null),
    parentTaskId: z.string().min(1).nullable().default(null),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS))
      .max(ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA)
      .default([]),
    validationSteps: z
      .array(TaskDraftValidationStep)
      .max(ORCHESTRATION_TASK_MAX_VALIDATION_STEPS)
      .default([]),
    dependencies: z.array(z.string().min(1)).default([]),
    sources: z.array(TaskSourceRef).max(ORCHESTRATION_TASK_MAX_SOURCES).default([]),
    workflowStepRunId: z.string().min(1).optional()
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTaskResponse = z
  .object({
    task: Task
  })
  .strict();
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;

export const UpdateTaskRequest = z
  .object({
    title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS).optional(),
    description: z.string().max(ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS).optional(),
    role: TaskRole.optional(),
    workspaceId: z.string().min(1).nullable().optional(),
    status: TaskStatus.optional(),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS))
      .max(ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA)
      .optional(),
    validationSteps: z
      .array(TaskDraftValidationStep)
      .max(ORCHESTRATION_TASK_MAX_VALIDATION_STEPS)
      .optional(),
    dependencies: z.array(z.string().min(1)).optional(),
    sources: z.array(TaskSourceRef).max(ORCHESTRATION_TASK_MAX_SOURCES).optional()
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.role !== undefined ||
      value.workspaceId !== undefined ||
      value.status !== undefined ||
      value.acceptanceCriteria !== undefined ||
      value.validationSteps !== undefined ||
      value.dependencies !== undefined ||
      value.sources !== undefined,
    { message: "at least one updatable task field must be provided" }
  );
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

export const UpdateTaskResponse = z
  .object({
    task: Task
  })
  .strict();
export type UpdateTaskResponse = z.infer<typeof UpdateTaskResponse>;

export const SplitTaskChildInput = z
  .object({
    title: z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_TITLE_CHARS),
    description: z.string().max(ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS).default(""),
    role: TaskRole.default("engineer"),
    workspaceId: z.string().min(1).nullable().optional(),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS))
      .max(ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA)
      .default([]),
    validationSteps: z
      .array(TaskDraftValidationStep)
      .max(ORCHESTRATION_TASK_MAX_VALIDATION_STEPS)
      .default([]),
    dependencies: z.array(z.string().min(1)).default([]),
    sources: z.array(TaskSourceRef).max(ORCHESTRATION_TASK_MAX_SOURCES).default([])
  })
  .strict();
export type SplitTaskChildInput = z.infer<typeof SplitTaskChildInput>;

export const SplitTaskRequest = z
  .object({
    children: z.array(SplitTaskChildInput).min(1).max(20),
    setParentStatus: z.literal("blocked").optional()
  })
  .strict();
export type SplitTaskRequest = z.infer<typeof SplitTaskRequest>;

export const SplitTaskResponse = z
  .object({
    parentTask: Task,
    childTasks: z.array(Task)
  })
  .strict();
export type SplitTaskResponse = z.infer<typeof SplitTaskResponse>;

export const AssociateTaskSessionRequest = z
  .object({
    sessionId: z.string().min(1)
  })
  .strict();
export type AssociateTaskSessionRequest = z.infer<typeof AssociateTaskSessionRequest>;

export const AssociateTaskSessionResponse = z
  .object({
    task: Task
  })
  .strict();
export type AssociateTaskSessionResponse = z.infer<typeof AssociateTaskSessionResponse>;

export const RecommendationGenerationRequest = z
  .object({
    trigger: z.literal("manual")
  })
  .strict();
export type RecommendationGenerationRequest = z.infer<
  typeof RecommendationGenerationRequest
>;

export const RecommendationGenerationResponse = z
  .object({
    generation: RecommendationGeneration
  })
  .strict();
export type RecommendationGenerationResponse = z.infer<
  typeof RecommendationGenerationResponse
>;

export const ListRecommendationsQuery = z
  .object({
    status: RecommendationStatus.optional(),
    type: RecommendationType.optional(),
    relatedTaskId: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    cursor: z.string().min(1).optional(),
    includeGenerations: z.coerce.boolean().default(true)
  })
  .strict();
export type ListRecommendationsQuery = z.infer<typeof ListRecommendationsQuery>;

export const ListRecommendationsResponse = z
  .object({
    recommendations: z.array(Recommendation),
    generations: z.array(RecommendationGeneration)
  })
  .strict();
export type ListRecommendationsResponse = z.infer<typeof ListRecommendationsResponse>;

export const GetRecommendationResponse = z
  .object({
    recommendation: Recommendation,
    feedback: z.array(RecommendationFeedback)
  })
  .strict();
export type GetRecommendationResponse = z.infer<typeof GetRecommendationResponse>;

export const RecommendationFeedbackRequest = z
  .object({
    note: z.string().max(ORCHESTRATION_FEEDBACK_MAX_NOTE_CHARS).optional()
  })
  .strict();
export type RecommendationFeedbackRequest = z.infer<
  typeof RecommendationFeedbackRequest
>;

export const AcceptRecommendationResponse = z
  .object({
    recommendation: Recommendation,
    proposedAction: ProposedAction,
    feedback: RecommendationFeedback
  })
  .strict();
export type AcceptRecommendationResponse = z.infer<
  typeof AcceptRecommendationResponse
>;

export const RejectRecommendationResponse = z
  .object({
    recommendation: Recommendation,
    feedback: RecommendationFeedback
  })
  .strict();
export type RejectRecommendationResponse = z.infer<typeof RejectRecommendationResponse>;

export const DismissRecommendationResponse = z
  .object({
    recommendation: Recommendation,
    feedback: RecommendationFeedback
  })
  .strict();
export type DismissRecommendationResponse = z.infer<
  typeof DismissRecommendationResponse
>;

export const ModifyRecommendationRequest = z
  .object({
    title: z.string().trim().min(1).max(ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS).optional(),
    rationale: z.string().max(ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS).optional(),
    proposedAction: ProposedAction.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.rationale !== undefined ||
      value.proposedAction !== undefined,
    { message: "at least one modifiable recommendation field must be provided" }
  );
export type ModifyRecommendationRequest = z.infer<
  typeof ModifyRecommendationRequest
>;

export const ModifyRecommendationResponse = z
  .object({
    recommendation: Recommendation,
    feedback: RecommendationFeedback
  })
  .strict();
export type ModifyRecommendationResponse = z.infer<
  typeof ModifyRecommendationResponse
>;

export const ListConflictsQuery = z
  .object({
    status: ConflictStatus.default("open"),
    severity: ConflictSeverity.optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    cursor: z.string().min(1).optional()
  })
  .strict();
export type ListConflictsQuery = z.infer<typeof ListConflictsQuery>;

export const ListConflictsResponse = z
  .object({
    conflicts: z.array(Conflict)
  })
  .strict();
export type ListConflictsResponse = z.infer<typeof ListConflictsResponse>;

export const ResolveConflictRequest = z
  .object({
    resolution: z.enum(["resolved", "dismissed"]),
    note: z.string().max(ORCHESTRATION_CONFLICT_MAX_RESOLUTION_NOTE_CHARS).optional()
  })
  .strict();
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;

export const ResolveConflictResponse = z
  .object({
    conflict: Conflict
  })
  .strict();
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponse>;

export const SelectableMemory = z
  .object({
    id: z.string(),
    type: GoalMemoryType,
    status: GoalMemoryStatus,
    content: z.string().min(1).max(4000),
    contentHash: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
    sourceSessionId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type SelectableMemory = z.infer<typeof SelectableMemory>;

export const SelectableDecision = z
  .object({
    id: z.string(),
    title: z.string().min(1).max(200),
    decisionText: z.string().min(1).max(4000),
    rationale: z.string().max(4000).nullable(),
    status: GoalDecisionStatus,
    confirmationRequired: z.boolean(),
    confidence: z.number().min(0).max(1).nullable(),
    sourceSessionId: z.string().nullable(),
    createdAt: z.string().datetime(),
    confirmedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type SelectableDecision = z.infer<typeof SelectableDecision>;

export const SelectableSummary = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    headline: z.string().min(1).max(200),
    summaryText: z.string().min(1).max(4000),
    truncated: z.boolean(),
    createdAt: z.string().datetime()
  })
  .strict();
export type SelectableSummary = z.infer<typeof SelectableSummary>;

export const ContextSection = z
  .object({
    kind: z.enum([
      "objective",
      "refinement",
      "workspace",
      "memory",
      "decisions",
      "sibling_summaries",
      "notes"
    ]),
    title: z.string().min(1).max(200),
    body: z.string(),
    markers: z.array(z.string().min(1).max(64))
  })
  .strict();
export type ContextSection = z.infer<typeof ContextSection>;

const ContextAssemblyGoalInput = z
  .object({
    id: z.string(),
    title: z.string().min(1).max(200),
    status: GoalStatus,
    archivedAt: z.string().datetime().nullable()
  })
  .strict();

const ContextAssemblyRefinementInput = z
  .object({
    id: z.string(),
    version: z.number().int().nonnegative().optional(),
    objective: z.string().max(4000).optional(),
    constraints: z.array(z.string().min(1).max(200)).optional(),
    successCriteria: z.array(z.string().min(1).max(200)).optional(),
    scopeNotes: z.string().max(4000).optional()
  })
  .strict();

const ContextAssemblyWorkspaceInput = z
  .object({
    id: z.string(),
    name: z.string().min(1).max(100),
    pathDisplay: z.string().min(1).max(1024),
    branch: z.string().nullable().optional(),
    dirty: z.boolean().nullable().optional()
  })
  .strict();

const ContextAssemblyBudget = z
  .object({
    maxBytes: z.number().int().positive(),
    perSectionMaxBytes: z.number().int().positive(),
    estimatedTokenBudget: z.number().int().positive()
  })
  .strict();

export const ContextAssemblyInput = z
  // @internal Internal-only shared schema for daemon-local context assembly input.
  .object({
    goal: ContextAssemblyGoalInput,
    refinement: ContextAssemblyRefinementInput.nullable(),
    workspace: ContextAssemblyWorkspaceInput.nullable().optional(),
    role: ContextRole,
    adapterId: AdapterId,
    objective: z.string().max(CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
    memory: z.array(SelectableMemory),
    decisions: z.array(SelectableDecision),
    siblingSummaries: z.array(SelectableSummary),
    budget: ContextAssemblyBudget
  })
  .strict();
export type ContextAssemblyInput = z.infer<typeof ContextAssemblyInput>;

export const ContextAssemblyOutput = z
  // @internal Internal-only shared schema for daemon-local context assembly output.
  .object({
    sections: z.array(ContextSection),
    sources: z.array(ContextSourceRef).max(CONTEXT_PACKAGE_MAX_SOURCE_COUNT),
    warnings: z
      .array(z.string().max(CONTEXT_PACKAGE_MAX_WARNING_CHARS))
      .max(CONTEXT_PACKAGE_MAX_WARNING_COUNT),
    truncated: z.boolean(),
    sparse: z.boolean(),
    estimatedTokens: z.number().int().nonnegative()
  })
  .strict();
export type ContextAssemblyOutput = z.infer<typeof ContextAssemblyOutput>;

export const SkillSummary = z.object({
  id: z.string(),
  pluginId: z.string(),
  extensionPoint: SkillExtensionPoint,
  title: z.string(),
  description: z.string()
});
export type SkillSummary = z.infer<typeof SkillSummary>;

export const ListPluginsResponse = z.object({
  plugins: z.array(PluginSummary)
});
export type ListPluginsResponse = z.infer<typeof ListPluginsResponse>;

export const ListSkillsResponse = z.object({
  skills: z.array(SkillSummary)
});
export type ListSkillsResponse = z.infer<typeof ListSkillsResponse>;

export const DomainEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  type: DomainEventType,
  goalId: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime()
});
export type DomainEvent = z.infer<typeof DomainEvent>;

export const LIST_EVENTS_MAX_LIMIT = 500;

export const ListEventsQuery = z.object({
  sinceSeq: z.coerce.number().int().nonnegative().default(0)
});
export type ListEventsQuery = z.infer<typeof ListEventsQuery>;

export const ListEventsResponse = z.object({
  events: z.array(DomainEvent),
  nextSinceSeq: z.number().int().nonnegative()
});
export type ListEventsResponse = z.infer<typeof ListEventsResponse>;

// ---------- agent readiness ----------

export const AgentReadinessStatus = z.enum([
  "unchecked",
  "ready",
  "missing",
  "needs_auth",
  "misconfigured",
  "failed"
]);
export type AgentReadinessStatus = z.infer<typeof AgentReadinessStatus>;

export const AuthStatus = z.enum(["ready", "needs_auth", "misconfigured"]);
export type AuthStatus = z.infer<typeof AuthStatus>;

export const CheckStep = z.object({
  name: z.enum(["installed", "authenticated"]),
  ok: z.boolean(),
  authStatus: AuthStatus.optional(),
  command: z.string(),
  exitCode: z.number().int().optional(),
  detail: z.string().optional(),
  errorOutput: z.string().optional()
});
export type CheckStep = z.infer<typeof CheckStep>;

export const RepairAction = z
  .object({
    kind: z.enum(["run_command", "install_url"]),
    command: z.string().optional(),
    url: z.string().url().optional(),
    label: z.string(),
    requiresAppRestart: z.boolean().optional()
  })
  .superRefine((v, ctx) => {
    if (v.kind === "run_command" && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "run_command requires command" });
    }
    if (v.kind === "install_url" && !v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "install_url requires url" });
    }
  });
export type RepairAction = z.infer<typeof RepairAction>;

export const AgentReadinessReport = z.object({
  agentId: z.string(),
  status: AgentReadinessStatus,
  steps: z.array(CheckStep),
  repair: RepairAction.optional(),
  checkedAt: z.string().datetime(),
  version: z.string().optional()
});
export type AgentReadinessReport = z.infer<typeof AgentReadinessReport>;

// ---------- agents ----------

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  shortLabel: z.string(),
  description: z.string(),
  swatch: z.string(),
  recommended: z.boolean(),
  connected: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  readiness: AgentReadinessReport.nullish()
});
export type Agent = z.infer<typeof Agent>;

export const ListAgentsResponse = z.object({
  agents: z.array(Agent)
});
export type ListAgentsResponse = z.infer<typeof ListAgentsResponse>;

export const UpdateAgentRequest = z.object({
  connected: z.boolean()
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

export const UpdateAgentResponse = z.object({
  agent: Agent
});
export type UpdateAgentResponse = z.infer<typeof UpdateAgentResponse>;

export const CheckReadinessAllResponse = z.object({
  reports: z.array(AgentReadinessReport)
});
export type CheckReadinessAllResponse = z.infer<typeof CheckReadinessAllResponse>;

export const CheckReadinessOneResponse = z.object({ report: AgentReadinessReport });
export type CheckReadinessOneResponse = z.infer<typeof CheckReadinessOneResponse>;

// ---------- system (environment) readiness ----------
//
// Host-level dependencies Orca itself needs (e.g. tmux for shadow sessions),
// as opposed to per-agent CLIs. Shares the status/step/repair shape with agent
// readiness so the onboarding UI can render and retry them identically.

export const SystemReadinessReport = z.object({
  dependency: z.string(),
  status: AgentReadinessStatus,
  steps: z.array(CheckStep),
  repair: RepairAction.optional(),
  checkedAt: z.string().datetime(),
  version: z.string().optional()
});
export type SystemReadinessReport = z.infer<typeof SystemReadinessReport>;

export const CheckSystemReadinessResponse = z.object({ report: SystemReadinessReport });
export type CheckSystemReadinessResponse = z.infer<typeof CheckSystemReadinessResponse>;

export {
  ExecutionMode,
  EnabledExecutionModeEntry,
  DisabledExecutionModeEntry,
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
} from "./adapters/execution-modes.js";
export type { ValidationResult as AdapterExecutionModeValidation } from "./adapters/execution-modes.js";
