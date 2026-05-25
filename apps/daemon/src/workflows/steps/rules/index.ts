import type { StepRule } from "./types.js";
import { intakeRule } from "./intake.js";
import { researchRule } from "./research.js";
import { prdRule } from "./prd.js";
import { issueBreakdownRule } from "./issue_breakdown.js";
import { executionRule } from "./execution.js";
import { qaRule } from "./qa.js";
import { reviewRule } from "./review.js";
import { doneRule } from "./done.js";

export const stepRules: Record<string, StepRule> = {
  intake: intakeRule,
  research: researchRule,
  prd: prdRule,
  issue_breakdown: issueBreakdownRule,
  execution: executionRule,
  qa: qaRule,
  review: reviewRule,
  done: doneRule,
};

export type { StepRule, StepRuleContext } from "./types.js";
