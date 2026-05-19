import { z } from "zod";

export const GoalStatus = z.enum(["active", "archived"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatus,
  autonomyLevel: z.number().int().default(1),
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
  workspaces: z.array(WorkspaceAttachmentInput).optional()
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

export const CreateGoalResponse = z.object({
  goal: Goal
});
export type CreateGoalResponse = z.infer<typeof CreateGoalResponse>;

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
  "decision.archived"
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

export const M5DomainEventType = z.enum([
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
export type M5DomainEventType = z.infer<typeof M5DomainEventType>;

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

export const M3ErrorCode = z.enum([
  "invalid_input",
  "not_found",
  "not_a_directory",
  "not_readable",
  "inspection_timeout",
  "workspace_duplicate",
  "duplicate_workspace_in_request",
  "runtime_misconfigured"
]);
export type M3ErrorCode = z.infer<typeof M3ErrorCode>;

export const M4SessionErrorCode = z.enum([
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
export type M4SessionErrorCode = z.infer<typeof M4SessionErrorCode>;

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

export const AdapterId = z.enum(["shell-manual", "claude-code", "opencode", "codex"]);
export type AdapterId = z.infer<typeof AdapterId>;

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

export const M5Event = z.discriminatedUnion("type", [
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
export type M5Event = z.infer<typeof M5Event>;

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
