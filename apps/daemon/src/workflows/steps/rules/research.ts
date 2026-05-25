import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = [
  "relevant files and systems identified",
  "current implementation summarized",
  "dependencies and risks captured",
  "unknowns captured",
  "likely implementation area and module boundaries identified",
];

export const researchRule: StepRule = {
  stepTemplateId: "research",
  evaluateArtifactSatisfies(artifact, ctx) {
    return nonEmptyArtifact(artifact, "research_summary") ? unsatisfied(ctx, CRITERIA) : [];
  },
};
