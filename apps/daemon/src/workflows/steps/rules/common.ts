import type { WorkflowArtifact } from "@orca/contracts";
import type { StepRuleContext } from "./types.js";

export function nonEmptyArtifact(
  artifact: WorkflowArtifact,
  type: WorkflowArtifact["type"]
): boolean {
  return artifact.type === type && artifact.body.trim().length > 0;
}

export function unsatisfied(ctx: StepRuleContext, criteria: string[]): string[] {
  return criteria.filter((criterion) => ctx.outstandingExitCriteria.includes(criterion));
}

export function appendSection(
  ctx: StepRuleContext,
  artifactType: WorkflowArtifact["type"],
  heading: string,
  body: string
): string {
  const last = ctx.artifacts.filter((artifact) => artifact.type === artifactType).at(-1);
  const prefix = last?.body.trim() ? `${last.body.trim()}\n\n` : "";
  return `${prefix}## ${heading}\n\n${body.trim()}`;
}
