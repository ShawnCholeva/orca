import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  ListWorkflowRunsResponse,
  StartWorkflowRunRequest,
  WorkflowRunResponse,
} from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { getWorkflowRunById, listWorkflowRunsForGoal } from "./projection.js";
import {
  ActiveWorkflowRunExistsError,
  cancelWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
  WorkflowGoalNotFoundError,
  WorkflowRunInvalidTransitionError,
  WorkflowRunNotFoundError,
  WorkflowTemplateNotFoundError,
  type WorkflowRunUsecaseCtx,
} from "./usecases.js";

export interface WorkflowRunRouteDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

interface GoalRow {
  id: string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function createUsecaseCtx(deps: WorkflowRunRouteDeps): WorkflowRunUsecaseCtx {
  return {
    db: deps.db,
    bus: deps.bus,
    now: deps.now,
    idFactory: deps.idFactory,
  };
}

export function registerWorkflowRunRoutes(
  server: FastifyInstance,
  deps: WorkflowRunRouteDeps
): void {
  const getGoal = deps.db.prepare<[string], GoalRow>("SELECT id FROM goals WHERE id = ?");

  function goalExists(goalId: string): boolean {
    return !!getGoal.get(goalId);
  }

  function runForGoalOr404(goalId: string, runId: string) {
    const run = getWorkflowRunById(deps.db, runId);
    if (!run || run.goalId !== goalId) return null;
    return run;
  }

  server.post("/v1/goals/:goalId/workflow-runs", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = StartWorkflowRunRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    if (parsed.data.goalId !== goalId) {
      reply.status(400);
      return apiError("validation_failed", "goalId in body must match route goalId");
    }

    try {
      const run = startWorkflowRun(createUsecaseCtx(deps), {
        goalId,
        templateId: parsed.data.templateId,
      });
      reply.status(201);
      return WorkflowRunResponse.parse({ run });
    } catch (error) {
      if (error instanceof WorkflowGoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowTemplateNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof ActiveWorkflowRunExistsError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.get("/v1/goals/:goalId/workflow-runs", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    if (!goalExists(goalId)) {
      reply.status(404);
      return apiError("goal_not_found", `Goal not found: ${goalId}`);
    }
    return ListWorkflowRunsResponse.parse({
      runs: listWorkflowRunsForGoal(deps.db, goalId),
    });
  });

  server.get("/v1/goals/:goalId/workflow-runs/:id", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const run = runForGoalOr404(goalId, id);
    if (!run) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowRunResponse.parse({ run });
  });

  server.post("/v1/goals/:goalId/workflow-runs/:id/pause", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    if (!runForGoalOr404(goalId, id)) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }

    try {
      const run = pauseWorkflowRun(createUsecaseCtx(deps), id);
      return WorkflowRunResponse.parse({ run });
    } catch (error) {
      if (error instanceof WorkflowRunNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowRunInvalidTransitionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post("/v1/goals/:goalId/workflow-runs/:id/resume", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    if (!runForGoalOr404(goalId, id)) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }

    try {
      const run = resumeWorkflowRun(createUsecaseCtx(deps), id);
      return WorkflowRunResponse.parse({ run });
    } catch (error) {
      if (error instanceof WorkflowRunNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowRunInvalidTransitionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post("/v1/goals/:goalId/workflow-runs/:id/cancel", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    if (!runForGoalOr404(goalId, id)) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${id}`
      );
    }

    try {
      const run = cancelWorkflowRun(createUsecaseCtx(deps), id);
      return WorkflowRunResponse.parse({ run });
    } catch (error) {
      if (error instanceof WorkflowRunNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowRunInvalidTransitionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
