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
  "session.stopped"
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

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
  exitedAt: z.string().datetime().nullable()
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
