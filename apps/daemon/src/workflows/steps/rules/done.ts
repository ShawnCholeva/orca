import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const FINAL_SUMMARY_CRITERIA = [
  "final result summarized",
  "follow-up work captured",
  "goal marked complete or left active with explicit remaining work",
];

const MEMORY_UPDATE_CRITERIA = ["important decisions captured"];

export const doneRule: StepRule = {
  stepTemplateId: "done",
  evaluateArtifactSatisfies(artifact, ctx) {
    if (nonEmptyArtifact(artifact, "final_summary")) {
      return unsatisfied(ctx, FINAL_SUMMARY_CRITERIA);
    }
    if (nonEmptyArtifact(artifact, "memory_update")) {
      return unsatisfied(ctx, MEMORY_UPDATE_CRITERIA);
    }
    return [];
  },
};
