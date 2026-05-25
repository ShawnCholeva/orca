import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { TaskRole } from "@orca/contracts";

import {
  createTaskInTx,
  ensureDependenciesBelongToGoal,
} from "../../tasks/usecases.js";
import { appendWorkflowEvent } from "../events.js";

export interface PrdSectionToTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  validationSteps: string[];
  role: TaskRole;
  workspaceId?: string;
  dependencies: string[];
}

export function writeIssueBreakdown(
  db: Database.Database,
  now: () => string,
  args: {
    goalId: string;
    workflowRunId: string;
    stepRunId: string;
    tasks: PrdSectionToTask[];
  }
): { taskIds: string[] } {
  const taskIds: string[] = [];

  db.transaction(() => {
    const createdAt = now();
    for (const taskInput of args.tasks) {
      ensureDependenciesBelongToGoal(db, args.goalId, taskInput.dependencies);
      const task = createTaskInTx(db, createdAt, {
        origin: "generator",
        status: "proposed",
        goalId: args.goalId,
        role: taskInput.role,
        title: taskInput.title,
        description: taskInput.description,
        workspaceId: taskInput.workspaceId ?? null,
        dependencies: taskInput.dependencies,
        workflowStepRunId: args.stepRunId,
        acceptanceCriteria: taskInput.acceptanceCriteria.map((text) => ({
          id: randomUUID(),
          text,
        })),
        validationSteps: taskInput.validationSteps.map((text) => ({
          id: randomUUID(),
          text,
          kind: "test",
        })),
      });
      taskIds.push(task.id);
    }

    appendWorkflowEvent(
      db,
      "workflow.task.dag.created",
      {
        goalId: args.goalId,
        workflowRunId: args.workflowRunId,
        stepRunId: args.stepRunId,
        taskIds,
        count: taskIds.length,
      },
      createdAt
    );
  })();

  return { taskIds };
}
