import type { WorkflowStepTemplate } from "@orca/contracts";

import { augmentInstructionsWithOutputConvention } from "./orca-output.js";
import { successCriteriaBlock } from "./success-criteria-prompt.js";

export function buildAgentObjective(
  step: WorkflowStepTemplate,
  ctx: { goal: { intent: string; successCriteria?: string[] }; stepRun: { id: string } }
): string {
  const header =
    `Workflow step: ${step.name}\nGoal: ${ctx.goal.intent}\n\n` +
    successCriteriaBlock(ctx.goal.successCriteria);
  return augmentInstructionsWithOutputConvention(`${header}${step.instructions}`);
}
