import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type DomainEvent,
  type WorkflowRun,
} from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { redactSecrets } from "../../memory/normalize.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import { createInitialStep } from "../steps/usecases.js";
import { getTemplateById } from "../templates/projection.js";
import { getWorkflowRunById } from "./projection.js";

const ACTIVE_WORKFLOW_RUN_STATUSES = ["active", "paused", "blocked"] as const;

export interface WorkflowRunUsecaseCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export class WorkflowGoalNotFoundError extends Error {
  readonly code = "goal_not_found" as const;

  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "WorkflowGoalNotFoundError";
  }
}

export class WorkflowRunNotFoundError extends Error {
  readonly code = "workflow_run_not_found" as const;

  constructor(runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "WorkflowRunNotFoundError";
  }
}

export class WorkflowTemplateNotFoundError extends Error {
  readonly code = "workflow_template_not_found" as const;

  constructor(templateId: string) {
    super(`Workflow template not found: ${templateId}`);
    this.name = "WorkflowTemplateNotFoundError";
  }
}

export class ActiveWorkflowRunExistsError extends Error {
  readonly code = "workflow_active_run_exists" as const;

  constructor(goalId: string) {
    super(`Active workflow run already exists for goal: ${goalId}`);
    this.name = "ActiveWorkflowRunExistsError";
  }
}

export class WorkflowRunInvalidTransitionError extends Error {
  readonly code = "workflow_run_invalid_transition" as const;

  constructor(runId: string, fromStatus: string, action: string) {
    super(`Workflow run ${runId} cannot ${action} from status ${fromStatus}`);
    this.name = "WorkflowRunInvalidTransitionError";
  }
}

function nowIso(ctx: WorkflowRunUsecaseCtx): string {
  return ctx.now?.() ?? new Date().toISOString();
}

function requireRun(db: Database.Database, runId: string): WorkflowRun {
  const run = getWorkflowRunById(db, runId);
  if (!run) throw new WorkflowRunNotFoundError(runId);
  return run;
}

function ensureGoalExists(db: Database.Database, goalId: string): void {
  const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId) as
    | { id: string }
    | undefined;
  if (!goal) throw new WorkflowGoalNotFoundError(goalId);
}

function sanitizeBlockedReason(reason: string): string {
  return redactSecrets(reason.trim()).slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
}

function assertTransition(
  run: WorkflowRun,
  allowedFrom: readonly string[],
  action: string
): void {
  if (!allowedFrom.includes(run.status)) {
    throw new WorkflowRunInvalidTransitionError(run.id, run.status, action);
  }
}

export function startWorkflowRun(
  ctx: WorkflowRunUsecaseCtx,
  args: { goalId: string; templateId: string }
): WorkflowRun {
  const now = nowIso(ctx);
  const template = getTemplateById(ctx.db, args.templateId);
  if (!template) throw new WorkflowTemplateNotFoundError(args.templateId);
  const idFactory = ctx.idFactory ?? randomUUID;
  const runId = idFactory();

  const staged = ctx.db.transaction(() => {
    const stagedEvents: DomainEvent[] = [];
    ensureGoalExists(ctx.db, args.goalId);
    const existingActive = ctx.db
      .prepare(
        "SELECT id FROM workflow_runs WHERE goal_id = ? AND status IN ('active','paused','blocked') LIMIT 1"
      )
      .get(args.goalId) as { id: string } | undefined;
    if (existingActive) throw new ActiveWorkflowRunExistsError(args.goalId);

    ctx.db
      .prepare(
        "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?, NULL)"
      )
      .run(runId, args.goalId, args.templateId, template.version, now);
    ctx.db
      .prepare("UPDATE goals SET active_workflow_run_id = ? WHERE id = ?")
      .run(runId, args.goalId);

    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.started",
      {
        goalId: args.goalId,
        workflowRunId: runId,
        templateId: args.templateId,
        templateVersion: template.version,
        status: "active",
      },
      now,
      ctx.idFactory
    );
    stagedEvents.push(event);
    createInitialStep(ctx.db, () => now, runId, {
      idFactory: ctx.idFactory,
      stagedEvents,
    });
    return stagedEvents;
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}

export function pauseWorkflowRun(
  ctx: WorkflowRunUsecaseCtx,
  runId: string
): WorkflowRun {
  const now = nowIso(ctx);
  const staged = ctx.db.transaction(() => {
    const run = requireRun(ctx.db, runId);
    assertTransition(run, ["active"], "pause");
    ctx.db
      .prepare("UPDATE workflow_runs SET status = 'paused' WHERE id = ?")
      .run(runId);
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.paused",
      { goalId: run.goalId, workflowRunId: runId, status: "paused" },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}

export function resumeWorkflowRun(
  ctx: WorkflowRunUsecaseCtx,
  runId: string
): WorkflowRun {
  const now = nowIso(ctx);
  const staged = ctx.db.transaction(() => {
    const run = requireRun(ctx.db, runId);
    assertTransition(run, ["paused", "blocked"], "resume");
    ctx.db
      .prepare(
        "UPDATE workflow_runs SET status = 'active', blocked_reason = NULL WHERE id = ?"
      )
      .run(runId);
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.started",
      { goalId: run.goalId, workflowRunId: runId, status: "active", resumed: true },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}

export function cancelWorkflowRun(
  ctx: WorkflowRunUsecaseCtx,
  runId: string
): WorkflowRun {
  const now = nowIso(ctx);
  const staged = ctx.db.transaction(() => {
    const run = requireRun(ctx.db, runId);
    assertTransition(run, ACTIVE_WORKFLOW_RUN_STATUSES, "cancel");
    ctx.db
      .prepare(
        "UPDATE workflow_runs SET status = 'cancelled', finished_at = ? WHERE id = ?"
      )
      .run(now, runId);
    ctx.db
      .prepare(
        "UPDATE goals SET active_workflow_run_id = NULL WHERE id = ? AND active_workflow_run_id = ?"
      )
      .run(run.goalId, runId);
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.cancelled",
      { goalId: run.goalId, workflowRunId: runId, status: "cancelled" },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}

export function completeWorkflowRun(
  ctx: WorkflowRunUsecaseCtx,
  runId: string
): WorkflowRun {
  const now = nowIso(ctx);
  const staged = ctx.db.transaction(() => {
    const run = requireRun(ctx.db, runId);
    assertTransition(run, ["active"], "complete");
    ctx.db
      .prepare(
        "UPDATE workflow_runs SET status = 'completed', finished_at = ?, current_node_id = NULL, current_node_kind = NULL WHERE id = ?"
      )
      .run(now, runId);
    ctx.db
      .prepare(
        "UPDATE goals SET active_workflow_run_id = NULL WHERE id = ? AND active_workflow_run_id = ?"
      )
      .run(run.goalId, runId);
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.completed",
      { goalId: run.goalId, workflowRunId: runId, status: "completed" },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}

export function markWorkflowRunBlocked(
  ctx: WorkflowRunUsecaseCtx,
  runId: string,
  reason: string
): WorkflowRun {
  const now = nowIso(ctx);
  const staged = ctx.db.transaction(() => {
    const run = requireRun(ctx.db, runId);
    assertTransition(run, ["active"], "mark blocked");
    ctx.db
      .prepare("UPDATE workflow_runs SET status = 'blocked', blocked_reason = ? WHERE id = ?")
      .run(sanitizeBlockedReason(reason), runId);
    const event = appendWorkflowEvent(
      ctx.db,
      "workflow.run.blocked",
      { goalId: run.goalId, workflowRunId: runId, status: "blocked" },
      now,
      ctx.idFactory
    );
    return [event];
  })();

  publishStagedWorkflowEvents(ctx.bus, staged);
  return requireRun(ctx.db, runId);
}
