import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = [
  "architecture drift assessed",
  "test gaps assessed",
  "maintainability risks captured",
  "blocking issues identified or ruled out",
  "follow-up tasks created where needed",
];

export const reviewRule: StepRule = {
  stepTemplateId: "review",
  evaluateArtifactSatisfies(artifact, ctx) {
    return nonEmptyArtifact(artifact, "review_report") ? unsatisfied(ctx, CRITERIA) : [];
  },
};
