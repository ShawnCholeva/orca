import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DomainEvent, WorkflowStepRun as WorkflowStepRunT } from "@orca/contracts";
import { WORKFLOW_FAILURE_MAX_MESSAGE_CHARS, WorkflowStepRun } from "@orca/contracts";
import { redactSecrets } from "../../memory/normalize.js";
import { appendWorkflowEvent } from "../events.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { getTemplateById } from "../templates/projection.js";

interface WorkflowStepRunRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  attempt: number;
  status: string;
  satisfied_exit_criteria_json: string;
  outstanding_exit_criteria_json: string;
  blocked_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  fingerprint: string;
}

export class WorkflowStepNotFoundError extends Error {
  readonly code = "workflow_step_run_not_found" as const;

  constructor(stepRunId: string) {
    super(`Workflow step run not found: ${stepRunId}`);
    this.name = "WorkflowStepNotFoundError";
  }
}

export class WorkflowStepInvalidTransitionError extends Error {
  readonly code = "workflow_step_invalid_transition" as const;

  constructor(stepRunId: string, fromStatus: string, action: string) {
    super(`Workflow step run ${stepRunId} cannot ${action} from status ${fromStatus}`);
    this.name = "WorkflowStepInvalidTransitionError";
  }
}

export class WorkflowStepExitCriteriaIncompleteError extends Error {
  readonly code = "workflow_step_exit_criteria_incomplete" as const;

  constructor(stepRunId: string) {
    super(`Workflow step run ${stepRunId} has outstanding exit criteria`);
    this.name = "WorkflowStepExitCriteriaIncompleteError";
  }
}

interface StepEventOptions {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
}

function sanitizeReason(reason: string): string {
  return redactSecrets(reason.trim()).slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
}

export function stepFingerprint(
  runId: string,
  stepTemplateId: string,
  attempt: number
): string {
  return createHash("sha256")
    .update(`${runId}:${stepTemplateId}:${attempt}`)
    .digest("hex");
}

function readStep(db: Database.Database, id: string): WorkflowStepRunT {
  const row = db
    .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
    .get(id) as WorkflowStepRunRow | undefined;
  if (!row) throw new WorkflowStepNotFoundError(id);
  return WorkflowStepRun.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepTemplateId: row.step_template_id,
    ordinal: row.ordinal,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
    satisfiedExitCriteria: JSON.parse(row.satisfied_exit_criteria_json) as string[],
    outstandingExitCriteria: JSON.parse(row.outstanding_exit_criteria_json) as string[],
  });
}

function readStepRow(db: Database.Database, id: string): WorkflowStepRunRow {
  const row = db
    .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
    .get(id) as WorkflowStepRunRow | undefined;
  if (!row) throw new WorkflowStepNotFoundError(id);
  return row;
}

function emitEvent(
  db: Database.Database,
  type:
    | "workflow.step.started"
    | "workflow.step.completed"
    | "workflow.step.blocked"
    | "workflow.step.failed"
    | "workflow.step.skipped"
    | "workflow.run.completed",
  payload: Record<string, unknown>,
  now: string,
  options?: StepEventOptions
): void {
  const event = appendWorkflowEvent(db, type, payload, now, options?.idFactory);
  options?.stagedEvents?.push(event);
}

function insertStep(
  db: Database.Database,
  now: () => string,
  goalId: string,
  runId: string,
  templateStepId: string,
  ordinal: number,
  attempt: number,
  exitCriteria: string[],
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  const id = randomUUID();
  const timestamp = now();
  const fingerprint = stepFingerprint(runId, templateStepId, attempt);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', ?, NULL, ?, NULL, ?)"
  ).run(
    id,
    goalId,
    runId,
    templateStepId,
    ordinal,
    attempt,
    JSON.stringify(exitCriteria),
    timestamp,
    fingerprint
  );
  db.prepare("UPDATE workflow_runs SET current_step_run_id = ? WHERE id = ?").run(id, runId);
  emitEvent(
    db,
    "workflow.step.started",
    {
      goalId,
      workflowRunId: runId,
      stepRunId: id,
      stepTemplateId: templateStepId,
      ordinal,
      attempt,
    },
    timestamp,
    eventOptions
  );
  return readStep(db, id);
}

export function createInitialStep(
  db: Database.Database,
  now: () => string,
  workflowRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  const run = getWorkflowRunById(db, workflowRunId);
  if (!run) throw new Error("run_not_found");
  const template = getTemplateById(db, run.templateId);
  if (!template) throw new Error("template_not_found");
  const first = template.steps.find((step) => step.ordinal === 0);
  if (!first) throw new Error("template_missing_initial_step");
  return insertStep(
    db,
    now,
    run.goalId,
    workflowRunId,
    first.id,
    first.ordinal,
    1,
    first.exitCriteria,
    eventOptions
  );
}

export function recordExitCriteriaSatisfaction(
  db: Database.Database,
  _now: () => string,
  stepRunId: string,
  satisfied: string[]
): WorkflowStepRunT {
  return db.transaction(() => {
    const row = readStepRow(db, stepRunId);
    const current = JSON.parse(row.satisfied_exit_criteria_json) as string[];
    const outstanding = JSON.parse(row.outstanding_exit_criteria_json) as string[];
    const allowed = new Set([...current, ...outstanding]);
    const toApply = satisfied.filter((criterion) => allowed.has(criterion));
    const updatedSatisfied = Array.from(new Set([...current, ...toApply]));
    const updatedOutstanding = outstanding.filter(
      (criterion) => !updatedSatisfied.includes(criterion)
    );
    db.prepare(
      "UPDATE workflow_step_runs SET satisfied_exit_criteria_json = ?, outstanding_exit_criteria_json = ? WHERE id = ?"
    ).run(
      JSON.stringify(updatedSatisfied),
      JSON.stringify(updatedOutstanding),
      stepRunId
    );
    return readStep(db, stepRunId);
  })();
}

export function advanceToNextStep(
  db: Database.Database,
  now: () => string,
  currentStepRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT | null {
  return db.transaction(() => {
    const current = readStep(db, currentStepRunId);
    if (current.status !== "active") {
      throw new WorkflowStepInvalidTransitionError(
        currentStepRunId,
        current.status,
        "advance"
      );
    }
    if (current.outstandingExitCriteria.length > 0) {
      throw new WorkflowStepExitCriteriaIncompleteError(currentStepRunId);
    }

    const run = getWorkflowRunById(db, current.workflowRunId);
    if (!run) throw new Error("run_not_found");
    const template = getTemplateById(db, run.templateId);
    if (!template) throw new Error("template_not_found");

    const timestamp = now();
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'passed', finished_at = ?, blocked_reason = NULL WHERE id = ?"
    ).run(timestamp, currentStepRunId);
    emitEvent(
      db,
      "workflow.step.completed",
      {
        goalId: current.goalId,
        workflowRunId: current.workflowRunId,
        stepRunId: currentStepRunId,
        stepTemplateId: current.stepTemplateId,
        ordinal: current.ordinal,
      },
      timestamp,
      eventOptions
    );

    const next = template.steps.find((step) => step.ordinal === current.ordinal + 1);
    if (!next) {
      db.prepare(
        "UPDATE workflow_runs SET status = 'completed', finished_at = ?, current_step_run_id = NULL, blocked_reason = NULL WHERE id = ?"
      ).run(timestamp, current.workflowRunId);
      db.prepare(
        "UPDATE goals SET active_workflow_run_id = NULL WHERE id = ? AND active_workflow_run_id = ?"
      ).run(current.goalId, current.workflowRunId);
      emitEvent(
        db,
        "workflow.run.completed",
        { goalId: current.goalId, workflowRunId: current.workflowRunId, status: "completed" },
        timestamp,
        eventOptions
      );
      return null;
    }

    return insertStep(
      db,
      now,
      current.goalId,
      current.workflowRunId,
      next.id,
      next.ordinal,
      1,
      next.exitCriteria,
      eventOptions
    );
  })();
}

export function markStepBlocked(
  db: Database.Database,
  now: () => string,
  stepRunId: string,
  reason: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  return db.transaction(() => {
    const row = readStep(db, stepRunId);
    if (row.status !== "active") {
      throw new WorkflowStepInvalidTransitionError(stepRunId, row.status, "mark blocked");
    }
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'blocked', blocked_reason = ? WHERE id = ?"
    ).run(sanitizeReason(reason), stepRunId);
    emitEvent(
      db,
      "workflow.step.blocked",
      {
        goalId: row.goalId,
        workflowRunId: row.workflowRunId,
        stepRunId,
        stepTemplateId: row.stepTemplateId,
      },
      now(),
      eventOptions
    );
    return readStep(db, stepRunId);
  })();
}

export function failStep(
  db: Database.Database,
  now: () => string,
  stepRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  return db.transaction(() => {
    const row = readStep(db, stepRunId);
    if (row.status !== "active" && row.status !== "blocked") {
      throw new WorkflowStepInvalidTransitionError(stepRunId, row.status, "fail");
    }
    const timestamp = now();
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'failed', finished_at = ? WHERE id = ?"
    ).run(timestamp, stepRunId);
    emitEvent(
      db,
      "workflow.step.failed",
      {
        goalId: row.goalId,
        workflowRunId: row.workflowRunId,
        stepRunId,
        stepTemplateId: row.stepTemplateId,
      },
      timestamp,
      eventOptions
    );
    return readStep(db, stepRunId);
  })();
}

export function skipStep(
  db: Database.Database,
  now: () => string,
  stepRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  return db.transaction(() => {
    const row = readStep(db, stepRunId);
    if (row.status !== "active" && row.status !== "blocked") {
      throw new WorkflowStepInvalidTransitionError(stepRunId, row.status, "skip");
    }
    const timestamp = now();
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'skipped', finished_at = ? WHERE id = ?"
    ).run(timestamp, stepRunId);
    emitEvent(
      db,
      "workflow.step.skipped",
      {
        goalId: row.goalId,
        workflowRunId: row.workflowRunId,
        stepRunId,
        stepTemplateId: row.stepTemplateId,
      },
      timestamp,
      eventOptions
    );
    return readStep(db, stepRunId);
  })();
}

export function retryStep(
  db: Database.Database,
  now: () => string,
  stepRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  return db.transaction(() => {
    const row = readStep(db, stepRunId);
    if (row.status !== "failed") {
      throw new WorkflowStepInvalidTransitionError(stepRunId, row.status, "retry");
    }
    const run = getWorkflowRunById(db, row.workflowRunId);
    if (!run) throw new Error("run_not_found");
    const template = getTemplateById(db, run.templateId);
    if (!template) throw new Error("template_not_found");
    const templateStep = template.steps.find((step) => step.id === row.stepTemplateId);
    if (!templateStep) throw new Error("template_step_not_found");
    return insertStep(
      db,
      now,
      row.goalId,
      row.workflowRunId,
      row.stepTemplateId,
      row.ordinal,
      row.attempt + 1,
      templateStep.exitCriteria,
      eventOptions
    );
  })();
}
