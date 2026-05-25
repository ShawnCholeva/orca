import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateWorkflowArtifactRequest,
  ListWorkflowArtifactsResponse,
  WorkflowArtifactResponse,
  WorkflowArtifactType,
} from "@orca/contracts";

import { redactSecrets } from "../../memory/normalize.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { createArtifact, getArtifact, listArtifactsForGoal, listArtifactsForRun } from "./usecases.js";

export interface WorkflowArtifactRouteDeps {
  db: Database.Database;
  now?: () => string;
  idFactory?: () => string;
}

interface GoalRow {
  id: string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerWorkflowArtifactRoutes(
  server: FastifyInstance,
  deps: WorkflowArtifactRouteDeps
): void {
  const getGoal = deps.db.prepare<[string], GoalRow>("SELECT id FROM goals WHERE id = ?");

  function goalExists(goalId: string): boolean {
    return !!getGoal.get(goalId);
  }

  server.post("/v1/goals/:goalId/workflow-artifacts", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = CreateWorkflowArtifactRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    if (!goalExists(goalId)) {
      reply.status(404);
      return apiError("goal_not_found", `Goal not found: ${goalId}`);
    }

    const artifact = createArtifact(
      deps.db,
      deps.now ?? (() => new Date().toISOString()),
      {
        goalId,
        workflowRunId: parsed.data.workflowRunId ?? null,
        stepRunId: parsed.data.stepRunId ?? null,
        type: parsed.data.type,
        title: redactSecrets(parsed.data.title).slice(0, 256),
        body: redactSecrets(parsed.data.body),
        source: parsed.data.source,
        linkedSessionId: parsed.data.linkedSessionId ?? null,
        linkedTaskId: parsed.data.linkedTaskId ?? null,
        linkedContextPackageId: parsed.data.linkedContextPackageId ?? null,
      },
      deps.idFactory
    );

    reply.status(201);
    return WorkflowArtifactResponse.parse({ artifact });
  });

  server.get("/v1/goals/:goalId/workflow-artifacts", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    if (!goalExists(goalId)) {
      reply.status(404);
      return apiError("goal_not_found", `Goal not found: ${goalId}`);
    }

    const { type } = request.query as { type?: string };
    if (type !== undefined) {
      const parsedType = WorkflowArtifactType.safeParse(type);
      if (!parsedType.success) {
        reply.status(400);
        return { error: "validation_failed", issues: parsedType.error.issues };
      }
      return ListWorkflowArtifactsResponse.parse({
        artifacts: listArtifactsForGoal(deps.db, goalId, parsedType.data),
      });
    }

    return ListWorkflowArtifactsResponse.parse({
      artifacts: listArtifactsForGoal(deps.db, goalId),
    });
  });

  server.get("/v1/goals/:goalId/workflow-runs/:runId/artifacts", async (request, reply) => {
    const { goalId, runId } = request.params as { goalId: string; runId: string };
    const run = getWorkflowRunById(deps.db, runId);
    if (!run || run.goalId !== goalId) {
      reply.status(404);
      return apiError(
        "workflow_run_not_found",
        `Workflow run not found for goal ${goalId}: ${runId}`
      );
    }

    return ListWorkflowArtifactsResponse.parse({
      artifacts: listArtifactsForRun(deps.db, runId),
    });
  });

  server.get("/v1/goals/:goalId/workflow-artifacts/:id", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const artifact = getArtifact(deps.db, id);
    if (!artifact || artifact.goalId !== goalId) {
      reply.status(404);
      return apiError(
        "workflow_artifact_not_found",
        `Workflow artifact not found for goal ${goalId}: ${id}`
      );
    }

    return WorkflowArtifactResponse.parse({ artifact });
  });
}
