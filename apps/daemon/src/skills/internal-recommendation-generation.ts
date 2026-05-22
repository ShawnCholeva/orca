import type { SkillDescriptor } from "../registry/types.js";

export const internalRecommendationGenerationSkill: SkillDescriptor = {
  id: "orca/recommendation-generation",
  pluginId: "orca.default-skills",
  extensionPoint: "orchestration.recommendation-generation",
  version: "0.1.0",
  category: "internal",
  invocation: "daemon-internal",
  title: "Recommendation Generation",
  description: "Internal descriptor for deterministic recommendation generation diagnostics.",
  invoke() {
    throw new Error("Internal skill descriptor is not directly invokable");
  },
};
