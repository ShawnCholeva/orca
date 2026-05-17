export type PluginCapability = "storage" | "skill.provider" | "agent.adapter";

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: PluginCapability[];
}

export type SkillExtensionPoint = "goal.create";

export interface SkillDescriptor<TInput = unknown, TOutput = unknown> {
  id: string;
  pluginId: string;
  extensionPoint: SkillExtensionPoint;
  title: string;
  description: string;
  invoke(input: TInput, ctx: SkillContext): TOutput;
}

export interface SkillContext {
  now(): string;
}
