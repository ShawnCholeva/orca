import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  SubmitWorkflowUserInputRequest,
  WorkflowStepRunResponse,
} from "@orca/contracts";

import { redactSecrets } from "../../memory/normalize.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent } from "../events.js";
import { getWorkflowStepRunById } from "./projection.js";
import { recordExitCriteriaSatisfaction } from "./usecases.js";

export interface WorkflowStepRouteDeps {
  db: Database.Database;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerWorkflowStepRoutes(
  server: FastifyInstance,
  deps: WorkflowStepRouteDeps
): void {
  const now = deps.now ?? (() => new Date().toISOString());

  function stepForGoal(goalId: string, stepRunId: string) {
    const stepRun = getWorkflowStepRunById(deps.db, stepRunId);
    if (!stepRun || stepRun.goalId !== goalId) return null;
    return stepRun;
  }

  server.get("/v1/goals/:goalId/workflow-step-runs/:id", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const stepRun = stepForGoal(goalId, id);
    if (!stepRun) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowStepRunResponse.parse({ stepRun });
  });

  server.post("/v1/goals/:goalId/workflow-step-runs/:id/submit-input", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const parsed = SubmitWorkflowUserInputRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    if (parsed.data.stepRunId !== id) {
      reply.status(400);
      return apiError("validation_failed", "stepRunId in body must match route id");
    }

    const stepRun = stepForGoal(goalId, id);
    if (!stepRun) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }

    let updatedStep = stepRun;
    if ((parsed.data.satisfiedExitCriteria?.length ?? 0) > 0) {
      updatedStep = recordExitCriteriaSatisfaction(
        deps.db,
        now,
        id,
        parsed.data.satisfiedExitCriteria ?? []
      );
    }

    const artifactIds: string[] = [];
    for (const artifact of parsed.data.artifactInputs ?? []) {
      const created = createArtifact(
        deps.db,
        now,
        {
          goalId,
          workflowRunId: updatedStep.workflowRunId,
          stepRunId: updatedStep.id,
          type: artifact.type,
          title: redactSecrets(artifact.title).slice(0, 256),
          body: redactSecrets(artifact.body),
          source: "user",
          linkedSessionId: null,
          linkedTaskId: null,
          linkedContextPackageId: null,
        },
        deps.idFactory
      );
      artifactIds.push(created.id);
    }

    appendWorkflowEvent(
      deps.db,
      "workflow.user.input.submitted",
      {
        goalId,
        workflowRunId: updatedStep.workflowRunId,
        stepRunId: updatedStep.id,
        answerBytes:
          parsed.data.answerText === undefined
            ? undefined
            : Buffer.byteLength(redactSecrets(parsed.data.answerText), "utf8"),
        artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
      },
      now(),
      deps.idFactory
    );

    const refreshed = getWorkflowStepRunById(deps.db, id);
    if (!refreshed) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowStepRunResponse.parse({ stepRun: refreshed });
  });
}
