import type { FastifyInstance } from "fastify";
import { CreateGoalAndStartWorkflowRequest } from "@orca/contracts";
import type { Goal, OrchestratorModelChoice, WorkflowRun } from "@orca/contracts";
import { ValidationError, DuplicateWorkspaceInRequestError, DuplicateDocumentInRequestError } from "../goals.js";
import { WorkspaceInspectionError } from "../workspaces/errors.js";
import { DocumentSnapshotError } from "../goal-documents/snapshot.js";

// Injected functions allow clean unit-testing without a real DB.
export interface GoalBootstrapRouteDeps {
  createGoalFn: (input: {
    title: string;
    intent: string;
    successCriteria?: string[];
    workspaces?: { inputPath: string; name?: string }[];
    documents?: { kind: "file" | "url"; ref: string; name?: string }[];
    orchestratorModel?: OrchestratorModelChoice;
  }) => Promise<Goal>;
  startWorkflowRunFn: (args: { goalId: string; templateId: string }) => WorkflowRun;
  spawnOrchestratorSessionFn: (goalId: string, runId: string) => Promise<string>;
  startWorkflowFirstStepFn: (goalId: string, runId: string) => Promise<void>;
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

    const { title, intent, successCriteria, workspaces, documents, orchestratorModel, workflowTemplateId } = parsed.data;

    // Phase 1: create the goal — any failure propagates as a normal HTTP error
    let goal: Goal;
    try {
      goal = await deps.createGoalFn({ title, intent, successCriteria, workspaces, documents, orchestratorModel });
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.status(400);
        return { error: "validation_failed", issues: err.issues };
      }
      if (err instanceof DuplicateWorkspaceInRequestError || err instanceof DuplicateDocumentInRequestError) {
        reply.status(400);
        return apiError(err.code, err.message);
      }
      if (err instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(err));
        return apiError(err.code, err.message);
      }
      if (err instanceof DocumentSnapshotError) {
        reply.status(err.code === "url_fetch_timeout" ? 504 : 400);
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

    // Phase 3: spawn orchestrator-LLM session + start first step's agent — failure returns partial-success body
    try {
      await deps.spawnOrchestratorSessionFn(goalId, workflowRunId);
      await deps.startWorkflowFirstStepFn(goalId, workflowRunId);
    } catch (err) {
      reply.status(201);
      return {
        ok: false,
        goalId,
        workflowRunId,
        bootstrapError: {
          phase: "startFirstStep",
          message: err instanceof Error ? err.message : "Failed to start first step",
        },
      };
    }

    reply.status(201);
    return { ok: true, goalId, workflowRunId };
  });
}
