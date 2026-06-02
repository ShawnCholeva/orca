import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type CreateWorkflowTemplateRequest,
  type DuplicateWorkflowTemplateRequest,
  type UpdateWorkflowTemplateRequest,
  type WorkflowTemplate,
} from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import { getTemplateById } from "./projection.js";

export interface WorkflowTemplateUsecaseCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export class WorkflowTemplateNotFoundError extends Error {
  readonly code = "workflow_template_not_found" as const;

  constructor(id: string) {
    super(`Workflow template not found: ${id}`);
    this.name = "WorkflowTemplateNotFoundError";
  }
}

export class WorkflowTemplateLockedError extends Error {
  readonly code = "workflow_template_locked" as const;

  constructor(id: string) {
    super(`Workflow template is locked: ${id}`);
    this.name = "WorkflowTemplateLockedError";
  }
}

function normalizeSteps(
  steps: CreateWorkflowTemplateRequest["steps"] | UpdateWorkflowTemplateRequest["steps"]
): WorkflowTemplate["steps"] {
  return steps.map((step, index) => ({
    ...step,
    ordinal: step.ordinal ?? index,
  }));
}

export function createCustomTemplate(
  ctx: WorkflowTemplateUsecaseCtx,
  req: CreateWorkflowTemplateRequest
): WorkflowTemplate {
  const now = ctx.now?.() ?? new Date().toISOString();
  const templateId = `custom/${(ctx.idFactory ?? randomUUID)()}`;
  const steps = normalizeSteps(req.steps);
  const staged = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        templateId,
        req.name,
        req.description,
        JSON.stringify(steps),
        JSON.stringify(req.guardrails),
        now,
        now,
        req.scope ?? "global",
        req.scopeName ?? "",
        req.graph ? JSON.stringify(req.graph) : null
      );
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.template.created",
      { templateId, version: 1 },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return getTemplateById(ctx.db, templateId)!;
}

export function updateCustomTemplate(
  ctx: WorkflowTemplateUsecaseCtx,
  id: string,
  req: UpdateWorkflowTemplateRequest
): WorkflowTemplate {
  const existing = getTemplateById(ctx.db, id);
  if (!existing) throw new WorkflowTemplateNotFoundError(id);
  if (existing.isBuiltIn || existing.isLocked) throw new WorkflowTemplateLockedError(id);

  const now = ctx.now?.() ?? new Date().toISOString();
  const steps = normalizeSteps(req.steps);
  const staged = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "UPDATE workflow_templates SET name = ?, description = ?, version = version + 1, steps_json = ?, guardrails_json = ?, updated_at = ?, scope = ?, scope_name = ?, graph_json = ? WHERE id = ?"
      )
      .run(
        req.name,
        req.description,
        JSON.stringify(steps),
        JSON.stringify(req.guardrails),
        now,
        req.scope ?? "global",
        req.scopeName ?? "",
        req.graph ? JSON.stringify(req.graph) : null,
        id
      );
    const next = getTemplateById(ctx.db, id)!;
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.template.updated",
      { templateId: id, version: next.version },
      now,
      ctx.idFactory
    );
    return [next, event] as const;
  })();

  publishStagedWorkflowEvents(ctx.bus, [staged[1]]);
  return staged[0];
}

export function duplicateTemplate(
  ctx: WorkflowTemplateUsecaseCtx,
  req: DuplicateWorkflowTemplateRequest
): WorkflowTemplate {
  const source = getTemplateById(ctx.db, req.sourceTemplateId);
  if (!source) throw new WorkflowTemplateNotFoundError(req.sourceTemplateId);

  const now = ctx.now?.() ?? new Date().toISOString();
  const templateId = `custom/${(ctx.idFactory ?? randomUUID)()}`;
  const staged = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        templateId,
        req.name,
        source.description,
        JSON.stringify(source.steps),
        JSON.stringify(source.guardrails),
        now,
        now,
        source.scope,
        source.scopeName,
        source.graph ? JSON.stringify(source.graph) : null
      );
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.template.duplicated",
      { templateId, sourceTemplateId: source.id },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return getTemplateById(ctx.db, templateId)!;
}
