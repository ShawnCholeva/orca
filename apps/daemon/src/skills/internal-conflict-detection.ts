import type { SkillDescriptor } from "../registry/types.js";

export const internalConflictDetectionSkill: SkillDescriptor = {
  id: "orca/conflict-detection",
  pluginId: "orca.default-skills",
  extensionPoint: "orchestration.conflict-detection",
  version: "0.1.0",
  category: "internal",
  invocation: "daemon-internal",
  title: "Conflict Detection",
  description: "Internal descriptor for deterministic conflict detection diagnostics.",
  invoke() {
    throw new Error("Internal skill descriptor is not directly invokable");
  },
};
