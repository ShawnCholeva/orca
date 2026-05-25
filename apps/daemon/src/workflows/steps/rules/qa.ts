import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = [
  "acceptance criteria checked",
  "passing or failing items recorded",
  "bugs or gaps captured",
  "rework required or not required is explicit",
];

export const qaRule: StepRule = {
  stepTemplateId: "qa",
  nextQuestion() {
    return {
      question:
        "Record QA results: acceptance checks, pass/fail items, bugs or gaps, and whether rework is required.",
      optionalChoices: ["No rework required", "Rework required"],
    };
  },
  evaluateUserInputAsArtifact({ answerText }) {
    return {
      artifact: {
        type: "qa_report",
        title: "QA Report",
        body: answerText.trim(),
      },
      satisfiedCriteria: CRITERIA,
    };
  },
  evaluateArtifactSatisfies(artifact, ctx) {
    return nonEmptyArtifact(artifact, "qa_report") ? unsatisfied(ctx, CRITERIA) : [];
  },
};
