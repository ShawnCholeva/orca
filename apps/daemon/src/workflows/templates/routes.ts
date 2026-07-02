import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateWorkflowTemplateRequest,
  DuplicateWorkflowTemplateRequest,
  GetWorkflowTemplateResponse,
  InstallBuiltInTemplatesRequest,
  InstallBuiltInTemplatesResponse,
  ListBuiltInTemplateCatalogResponse,
  ListWorkflowTemplatesResponse,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateResponse,
} from "@orca/contracts";
import type { WorkflowStepTemplate } from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { getTemplateById, listTemplates } from "./projection.js";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import { builtInCatalogSummaries } from "./catalog.js";
import {
  createCustomTemplate,
  duplicateTemplate,
  installBuiltInTemplates,
  UnknownBuiltInTemplateError,
  WorkflowTemplateLockedError,
  WorkflowTemplateNotFoundError,
  type WorkflowTemplateUsecaseCtx,
  updateCustomTemplate,
} from "./usecases.js";
import { validateGraph, validateSchemaReferences, validateDelegationAcyclic } from "../graph/validate-graph.js";
import { effectiveGraph } from "../graph/graph-routing.js";

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

  server.get("/v1/workflow-templates/catalog", async () => {
    return ListBuiltInTemplateCatalogResponse.parse({ catalog: builtInCatalogSummaries() });
  });

  server.post("/v1/workflow-templates/install", async (request, reply) => {
    const parsed = InstallBuiltInTemplatesRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    try {
      const templates = installBuiltInTemplates(createUsecaseCtx(deps), parsed.data.ids);
      reply.status(201);
      return InstallBuiltInTemplatesResponse.parse({ templates });
    } catch (error) {
      if (error instanceof UnknownBuiltInTemplateError) {
        reply.status(400);
        return apiError(error.code, error.message);
      }
      throw error;
    }
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

    {
      const steps = normalizeStepsForValidation(parsed.data.steps);
      const graph = effectiveGraph(parsed.data.graph ?? null, steps);
      const resolveChild = (id: string) => getTemplateById(deps.db, id);
      const issues = [
        ...validateGraph(graph, steps, { resolveChild }),
        ...validateSchemaReferences(graph, steps),
      ];
      if (issues.length > 0) {
        reply.status(400);
        return { error: "invalid_graph", issues };
      }
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

    {
      const steps = normalizeStepsForValidation(parsed.data.steps);
      const graph = effectiveGraph(parsed.data.graph ?? null, steps);
      const resolveChild = (childId: string) => getTemplateById(deps.db, childId);
      const issues = [
        ...validateGraph(graph, steps, { resolveChild }),
        ...validateSchemaReferences(graph, steps),
      ];
      if (issues.length > 0) {
        reply.status(400);
        return { error: "invalid_graph", issues };
      }
      // Acyclic delegation check: build a proposed template view using the
      // update request data and the existing template id, then verify no cycle.
      const acyclicIssues = validateDelegationAcyclic(resolveChild, { id, graph });
      if (acyclicIssues.length > 0) {
        reply.status(400);
        return { error: "invalid_graph", issues: acyclicIssues };
      }
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

function normalizeStepsForValidation(
  steps: CreateWorkflowTemplateRequest["steps"]
): WorkflowStepTemplate[] {
  return steps.map((s, i) => ({ ...s, ordinal: s.ordinal ?? i })) as WorkflowStepTemplate[];
}
