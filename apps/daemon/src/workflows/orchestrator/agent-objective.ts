import type { WorkflowStepTemplate } from "@orca/contracts";

import { augmentInstructionsWithOutputConvention } from "./orca-output.js";

export function buildAgentObjective(
  step: WorkflowStepTemplate,
  ctx: { goal: { intent: string }; stepRun: { id: string } }
): string {
  const header = `Workflow step: ${step.name}\nGoal: ${ctx.goal.intent}\n\n`;
  return augmentInstructionsWithOutputConvention(`${header}${step.instructions}`);
}
