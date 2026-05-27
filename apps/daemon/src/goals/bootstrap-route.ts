import type { FastifyInstance } from "fastify";
import { CreateGoalAndStartWorkflowRequest } from "@orca/contracts";
import type { Goal, OrchestratorModelChoice, WorkflowRun } from "@orca/contracts";
import { ValidationError, DuplicateWorkspaceInRequestError } from "../goals.js";
import { WorkspaceInspectionError } from "../workspaces/errors.js";

// Injected functions allow clean unit-testing without a real DB.
export interface GoalBootstrapRouteDeps {
  createGoalFn: (input: {
    title: string;
    description: string;
    workspaces?: { inputPath: string; name?: string }[];
    orchestratorModel?: OrchestratorModelChoice;
  }) => Promise<Goal>;
  startWorkflowRunFn: (args: { goalId: string; templateId: string }) => WorkflowRun;
  requestNextDecisionFn: (goalId: string, runId: string) => Promise<unknown>;
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function inspectionStatus(err: WorkspaceInspectionError): number {
  return err.code === "inspection_timeout" ? 504 : 400;
}

export function registerGoalBootstrapRoute(
  server: FastifyInstance,
  deps: GoalBootstrapRouteDeps
): void {
  server.post("/v1/goals/create-and-start-workflow", async (request, reply) => {
    const parsed = CreateGoalAndStartWorkflowRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    const { title, description, workspaces, orchestratorModel, workflowTemplateId } = parsed.data;

    // Phase 1: create the goal — any failure propagates as a normal HTTP error
    let goal: Goal;
    try {
      goal = await deps.createGoalFn({ title, description, workspaces, orchestratorModel });
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.status(400);
        return { error: "validation_failed", issues: err.issues };
      }
      if (err instanceof DuplicateWorkspaceInRequestError) {
        reply.status(400);
        return apiError(err.code, err.message);
      }
      if (err instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(err));
        return apiError(err.code, err.message);
      }
      throw err;
    }

    const goalId = goal.id;

    // Phase 2: start workflow run — failure returns partial-success body
    let run: WorkflowRun;
    try {
      run = deps.startWorkflowRunFn({ goalId, templateId: workflowTemplateId });
    } catch (err) {
      reply.status(201);
      return {
        ok: false,
        goalId,
        bootstrapError: {
          phase: "startWorkflowRun",
          message: err instanceof Error ? err.message : "Failed to start workflow run",
        },
      };
    }

    const workflowRunId = run.id;

    // Phase 3: request first orchestrator decision — failure returns partial-success body
    try {
      await deps.requestNextDecisionFn(goalId, workflowRunId);
    } catch (err) {
      reply.status(201);
      return {
        ok: false,
        goalId,
        workflowRunId,
        bootstrapError: {
          phase: "requestDecision",
          message: err instanceof Error ? err.message : "Failed to request orchestrator decision",
        },
      };
    }

    reply.status(201);
    return { ok: true, goalId, workflowRunId };
  });
}
