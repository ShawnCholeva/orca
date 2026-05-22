import type { SkillDescriptor } from "../registry/types.js";

export const internalTaskGenerationSkill: SkillDescriptor = {
  id: "orca/task-generation",
  pluginId: "orca.default-skills",
  extensionPoint: "orchestration.task-generation",
  version: "0.1.0",
  category: "internal",
  invocation: "daemon-internal",
  title: "Task Generation",
  description: "Internal descriptor for deterministic task generation diagnostics.",
  invoke() {
    throw new Error("Internal skill descriptor is not directly invokable");
  },
};
