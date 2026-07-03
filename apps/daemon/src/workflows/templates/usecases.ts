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
import { BUILTIN_TEMPLATE_CATALOG, BUILTIN_TEMPLATE_IDS, type BuiltInTemplateDefinition } from "./catalog.js";

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
        "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json, inputs_json) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        req.graph ? JSON.stringify(req.graph) : null,
        JSON.stringify(req.inputs ?? [])
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
        "UPDATE workflow_templates SET name = ?, description = ?, version = version + 1, steps_json = ?, guardrails_json = ?, updated_at = ?, scope = ?, scope_name = ?, graph_json = ?, inputs_json = ? WHERE id = ?"
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
        JSON.stringify(req.inputs ?? []),
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
        "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, category, graph_json, inputs_json) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        source.category,
        source.graph ? JSON.stringify(source.graph) : null,
        JSON.stringify(source.inputs ?? [])
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

export class UnknownBuiltInTemplateError extends Error {
  readonly code = "unknown_builtin_template" as const;

  constructor(id: string) {
    super(`Unknown built-in template: ${id}`);
    this.name = "UnknownBuiltInTemplateError";
  }
}

// Version-guarded upsert of one built-in definition. Emits created/updated.
function upsertBuiltInTemplate(
  ctx: WorkflowTemplateUsecaseCtx,
  def: BuiltInTemplateDefinition,
): WorkflowTemplate {
  const now = ctx.now?.() ?? new Date().toISOString();
  const existing = getTemplateById(ctx.db, def.id);
  if (existing && existing.version >= def.version) return existing;

  const stepsJson = JSON.stringify(def.steps);
  const guardrailsJson = JSON.stringify(def.guardrails);
  const graphJson = def.graph ? JSON.stringify(def.graph) : null;
  const inputsJson = JSON.stringify(def.inputs ?? []);

  const staged = ctx.db.transaction(() => {
    if (existing) {
      ctx.db.prepare(
        "UPDATE workflow_templates SET name = ?, description = ?, version = ?, is_built_in = 1, is_locked = 1, steps_json = ?, guardrails_json = ?, graph_json = ?, inputs_json = ?, scope = 'global', scope_name = '', category = ?, updated_at = ? WHERE id = ?"
      ).run(def.name, def.description, def.version, stepsJson, guardrailsJson, graphJson, inputsJson, def.category, now, def.id);
      const event = appendWorkflowEvent(ctx.db, "workflow.template.updated", { templateId: def.id, version: def.version }, now, ctx.idFactory);
      return [event];
    }
    ctx.db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, category, graph_json, inputs_json) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'global', '', ?, ?, ?)"
    ).run(def.id, def.name, def.description, def.version, stepsJson, guardrailsJson, now, now, def.category, graphJson, inputsJson);
    const event = appendWorkflowEvent(ctx.db, "workflow.template.created", { templateId: def.id, version: def.version }, now, ctx.idFactory);
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return getTemplateById(ctx.db, def.id)!;
}

export function installBuiltInTemplates(
  ctx: WorkflowTemplateUsecaseCtx,
  ids: string[],
): WorkflowTemplate[] {
  for (const id of ids) {
    if (!BUILTIN_TEMPLATE_IDS.has(id)) throw new UnknownBuiltInTemplateError(id);
  }
  const wanted = new Set(ids);
  return BUILTIN_TEMPLATE_CATALOG
    .filter((d) => wanted.has(d.id))
    .map((d) => upsertBuiltInTemplate(ctx, d));
}

// Boot upgrade: bring already-installed built-ins up to their current catalog
// version. Version-guarded (no-op when already current) and selection-respecting:
// only upgrades built-ins already present in the DB — never installs ones the user
// didn't select, and never resurrects deleted ones.
export function upgradeInstalledBuiltInTemplates(ctx: WorkflowTemplateUsecaseCtx): void {
  const installed = new Set(
    (
      ctx.db
        .prepare("SELECT id FROM workflow_templates WHERE is_built_in = 1")
        .all() as { id: string }[]
    ).map((r) => r.id)
  );
  for (const def of BUILTIN_TEMPLATE_CATALOG) {
    if (installed.has(def.id)) upsertBuiltInTemplate(ctx, def);
  }
}

// Boot cleanup: drop built-ins no longer in the catalog that have no runs.
export function reconcileBuiltInTemplates(db: Database.Database): void {
  const placeholders = BUILTIN_TEMPLATE_CATALOG.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM workflow_templates
     WHERE is_built_in = 1
       AND id NOT IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_runs.template_id = workflow_templates.id)`
  ).run(...BUILTIN_TEMPLATE_CATALOG.map((d) => d.id));
}
