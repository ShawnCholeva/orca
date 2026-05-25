import { z } from "zod";
import { TaskRole } from "@orca/contracts";

import { writeIssueBreakdown } from "../../orchestrator/issue-breakdown.js";
import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = [
  "work split into clear tasks",
  "dependencies explicit",
  "first vertical slice reaches user/test-visible behavior where possible",
  "validation expectations exist",
  "suggested role or capabilities exist for each task",
];

const TaskInput = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4096).default(""),
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
    validationSteps: z.array(z.string().min(1).max(1000)).max(20).default([]),
    role: TaskRole.default("engineer"),
    workspaceId: z.string().min(1).max(200).optional(),
    dependencies: z.array(z.string().min(1).max(200)).max(20).default([]),
  })
  .strict();

const IssueBreakdownBody = z.union([
  z.array(TaskInput).min(1).max(50),
  z.object({ tasks: z.array(TaskInput).min(1).max(50) }).strict().transform((value) => value.tasks),
]);

function parseTasks(body: string): z.infer<typeof TaskInput>[] {
  const parsed = JSON.parse(body) as unknown;
  return IssueBreakdownBody.parse(parsed);
}

export const issueBreakdownRule: StepRule = {
  stepTemplateId: "issue_breakdown",
  evaluateArtifactSatisfies(artifact, ctx) {
    if (!nonEmptyArtifact(artifact, "issue_breakdown")) return [];
    try {
      parseTasks(artifact.body);
    } catch {
      return [];
    }
    return unsatisfied(ctx, CRITERIA);
  },
  onArtifactCreated({ db, now, artifact, ctx }) {
    if (!nonEmptyArtifact(artifact, "issue_breakdown")) return { satisfiedCriteria: [] };
    const tasks = parseTasks(artifact.body);
    const { taskIds } = writeIssueBreakdown(db, now, {
      goalId: ctx.goalId,
      workflowRunId: ctx.workflowRunId,
      stepRunId: ctx.stepRunId,
      tasks,
    });
    return { satisfiedCriteria: unsatisfied(ctx, CRITERIA), taskIds };
  },
};
