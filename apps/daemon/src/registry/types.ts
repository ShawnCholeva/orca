export type PluginCapability = "storage" | "skill.provider" | "agent.adapter";

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: PluginCapability[];
}

type SkillExtensionPoint =
  | "goal.create"
  | "goal.refine"
  | "orchestration.recommendation-generation"
  | "orchestration.task-generation"
  | "orchestration.conflict-detection";
export type PublicSkillExtensionPoint = "goal.create" | "goal.refine";

type SkillCategory = "public" | "internal";
type SkillInvocation = "http" | "daemon-internal";

export interface SkillDescriptor<TInput = unknown, TOutput = unknown> {
  id: string;
  pluginId: string;
  extensionPoint: SkillExtensionPoint;
  version?: string;
  category?: SkillCategory;
  invocation?: SkillInvocation;
  title: string;
  description: string;
  invoke(input: TInput, ctx: SkillContext): TOutput;
}

export type PublicSkillDescriptor<TInput = unknown, TOutput = unknown> = SkillDescriptor<
  TInput,
  TOutput
> & {
  extensionPoint: PublicSkillExtensionPoint;
  category?: "public";
};

interface SkillContext {
  now(): string;
}
