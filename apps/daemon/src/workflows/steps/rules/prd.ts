import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = [
  "problem and solution stated",
  "user stories or behavior statements exist",
  "acceptance criteria exist",
  "non-goals exist",
  "implementation and testing decisions captured",
  "definition of done exists",
];

export const prdRule: StepRule = {
  stepTemplateId: "prd",
  evaluateArtifactSatisfies(artifact, ctx) {
    return nonEmptyArtifact(artifact, "prd") ? unsatisfied(ctx, CRITERIA) : [];
  },
};
