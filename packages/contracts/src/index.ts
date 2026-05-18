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
  "workspace.removed"
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
