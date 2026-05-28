import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateWorkflowTemplateRequest,
  DuplicateWorkflowTemplateRequest,
  GetWorkflowTemplateResponse,
  ListWorkflowTemplatesResponse,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateResponse,
} from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { getTemplateById, listTemplates } from "./projection.js";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import {
  createCustomTemplate,
  duplicateTemplate,
  WorkflowTemplateLockedError,
  WorkflowTemplateNotFoundError,
  type WorkflowTemplateUsecaseCtx,
  updateCustomTemplate,
} from "./usecases.js";

export interface WorkflowTemplateRouteDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function createUsecaseCtx(deps: WorkflowTemplateRouteDeps): WorkflowTemplateUsecaseCtx {
  return {
    db: deps.db,
    bus: deps.bus,
    now: deps.now,
    idFactory: deps.idFactory,
  };
}

export function registerWorkflowTemplateRoutes(
  server: FastifyInstance,
  deps: WorkflowTemplateRouteDeps
): void {
  server.get("/v1/workflow-templates", async () => {
    return ListWorkflowTemplatesResponse.parse({
      templates: listTemplates(deps.db),
    });
  });

  server.get("/v1/workflow-templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = getTemplateById(deps.db, id);
    if (!template) {
      reply.status(404);
      return apiError("workflow_template_not_found", `Workflow template not found: ${id}`);
    }
    return GetWorkflowTemplateResponse.parse({ template });
  });

  server.post("/v1/workflow-templates", async (request, reply) => {
    const parsed = CreateWorkflowTemplateRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    const template = createCustomTemplate(createUsecaseCtx(deps), parsed.data);
    const warnings = validateTemplatePipeline(template.steps);
    reply.status(201);
    return WorkflowTemplateResponse.parse({ template, warnings });
  });

  server.patch("/v1/workflow-templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateWorkflowTemplateRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    try {
      const template = updateCustomTemplate(createUsecaseCtx(deps), id, parsed.data);
      const warnings = validateTemplatePipeline(template.steps);
      return WorkflowTemplateResponse.parse({ template, warnings });
    } catch (error) {
      if (error instanceof WorkflowTemplateNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowTemplateLockedError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post("/v1/workflow-templates/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DuplicateWorkflowTemplateRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    if (parsed.data.sourceTemplateId !== id) {
      reply.status(400);
      return apiError(
        "validation_failed",
        "sourceTemplateId must match route template id"
      );
    }

    try {
      const template = duplicateTemplate(createUsecaseCtx(deps), parsed.data);
      reply.status(201);
      return WorkflowTemplateResponse.parse({ template });
    } catch (error) {
      if (error instanceof WorkflowTemplateNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
