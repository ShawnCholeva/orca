import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  DomainEvent,
  WorkflowGraph,
  WorkflowStepResult,
  WorkflowStepRun as WorkflowStepRunT,
} from "@orca/contracts";
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  WorkflowStepResult as WorkflowStepResultSchema,
} from "@orca/contracts";
import { redactSecrets } from "../../memory/normalize.js";
import { appendWorkflowEvent } from "../events.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { getWorkflowStepRunById } from "./projection.js";
import { loadRunTemplate } from "../runs/run-template.js";
import {
  buildEvaluationFailedStepResult,
  mapStepRunStatusToResultStatus,
  sanitizeStepResult,
  serializeStepResult,
} from "./step-result.js";
import { materializeStepResultActivity } from "../../activities/step-result-activity.js";
import type { ActivityStoreCtx } from "../../activities/store.js";
import { effectiveGraph, resolveStepNext } from "../graph/graph-routing.js";

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
  revise_attempts?: number;
  crash_retries?: number;
  step_result_json: string | null;
}

class WorkflowStepNotFoundError extends Error {
  readonly code = "workflow_step_run_not_found" as const;

  constructor(stepRunId: string) {
    super(`Workflow step run not found: ${stepRunId}`);
    this.name = "WorkflowStepNotFoundError";
  }
}

class WorkflowStepInvalidTransitionError extends Error {
  readonly code = "workflow_step_invalid_transition" as const;

  constructor(stepRunId: string, fromStatus: string, action: string) {
    super(`Workflow step run ${stepRunId} cannot ${action} from status ${fromStatus}`);
    this.name = "WorkflowStepInvalidTransitionError";
  }
}

interface StepEventOptions {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
  activityCtx?: ActivityStoreCtx;
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
  const step = getWorkflowStepRunById(db, id);
  if (!step) throw new WorkflowStepNotFoundError(id);
  return step;
}

function readStepRow(db: Database.Database, id: string): WorkflowStepRunRow {
  const row = db
    .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
    .get(id) as WorkflowStepRunRow | undefined;
  if (!row) throw new WorkflowStepNotFoundError(id);
  return row;
}

function retryCount(row: WorkflowStepRunRow): number {
  return Math.max(row.attempt - 1, 0) + (row.revise_attempts ?? 0) + (row.crash_retries ?? 0);
}

function artifactCountForStep(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE step_run_id = ?")
      .get(stepRunId) as { count: number }
  ).count;
}

function terminalIssueCount(status: string): number {
  return status === "blocked" || status === "failed" ? 1 : 0;
}

function terminalStepResult(
  db: Database.Database,
  row: WorkflowStepRunRow,
  terminalStatus: "passed" | "blocked" | "failed" | "skipped",
  finishedAt: string,
  supplied?: WorkflowStepResult
): WorkflowStepResult {
  const expectedStatus = mapStepRunStatusToResultStatus(terminalStatus);
  if (supplied) {
    const parsed = WorkflowStepResultSchema.parse(supplied);
    if (parsed.stepId !== row.id) {
      throw new Error(
        `supplied step result stepId mismatch: expected ${row.id}, received ${parsed.stepId}`
      );
    }
    if (parsed.stepStatus !== expectedStatus) {
      throw new Error(
        `supplied step result stepStatus mismatch: expected ${expectedStatus}, received ${parsed.stepStatus}`
      );
    }
    return sanitizeStepResult(parsed);
  }
  return buildEvaluationFailedStepResult({
    stepId: row.id,
    stepStatus: expectedStatus,
    startedAt: row.started_at,
    finishedAt,
    retries: retryCount(row),
    producedArtifactsCount: artifactCountForStep(db, row.id),
    blockingIssuesCount: terminalIssueCount(terminalStatus),
    warningsCount: 0,
    reason: "orchestrator scoring not supplied",
  });
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

function materializeStepResultSafely(
  options: StepEventOptions | undefined,
  input: { goalId: string; workflowRunId: string; stepRunId: string }
): void {
  if (!options?.activityCtx) return;
  try {
    materializeStepResultActivity(options.activityCtx, input);
  } catch (error) {
    console.error("[activity] step result materialization failed", {
      stepRunId: input.stepRunId,
      error,
    });
  }
}

function insertStep(
  db: Database.Database,
  now: () => string,
  goalId: string,
  runId: string,
  templateStepId: string,
  ordinal: number,
  attempt: number,
  eventOptions?: StepEventOptions,
  nodeId?: string
): WorkflowStepRunT {
  const id = randomUUID();
  const timestamp = now();
  const fingerprint = stepFingerprint(runId, templateStepId, attempt);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', '[]', NULL, ?, NULL, ?)"
  ).run(
    id,
    goalId,
    runId,
    templateStepId,
    ordinal,
    attempt,
    timestamp,
    fingerprint
  );
  db.prepare(
    "UPDATE workflow_runs SET current_step_run_id = ?, current_node_id = ?, current_node_kind = 'step' WHERE id = ?"
  ).run(id, nodeId ?? templateStepId, runId);
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

/**
 * Inserts a fresh step run for a graph-routed destination (e.g. a gate routing
 * backward to an earlier step). Moves the run cursor to the new step node. Used
 * by the orchestrator when a gate's outcome selects a step destination.
 */
export function insertStepForRouting(
  db: Database.Database,
  now: () => string,
  goalId: string,
  runId: string,
  stepTemplateId: string,
  ordinal: number,
  attempt: number,
  nodeId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  return insertStep(db, now, goalId, runId, stepTemplateId, ordinal, attempt, eventOptions, nodeId);
}

export function createInitialStep(
  db: Database.Database,
  now: () => string,
  workflowRunId: string,
  eventOptions?: StepEventOptions
): WorkflowStepRunT {
  const run = getWorkflowRunById(db, workflowRunId);
  if (!run) throw new Error("run_not_found");
  const template = loadRunTemplate(db, run);
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

export type AdvanceResult =
  | { kind: "step"; stepRun: WorkflowStepRunT }
  | { kind: "gate"; nodeId: string }
  | { kind: "completed-terminal"; stepRun: WorkflowStepRunT };

function graphStepTemplateId(graph: WorkflowGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "step") throw new Error(`not a step node: ${nodeId}`);
  return node.stepId ?? node.id;
}

function ordinalForStep(
  template: { steps: { id: string; ordinal: number }[] },
  stepId: string
): number {
  return template.steps.find((s) => s.id === stepId)?.ordinal ?? 0;
}

export function advanceToNextStepOrGate(
  db: Database.Database,
  now: () => string,
  currentStepRunId: string,
  eventOptions?: StepEventOptions,
  suppliedStepResult?: WorkflowStepResult
): AdvanceResult {
  return db.transaction((): AdvanceResult => {
    const current = readStep(db, currentStepRunId);
    if (current.status !== "active") {
      throw new WorkflowStepInvalidTransitionError(
        currentStepRunId,
        current.status,
        "advance"
      );
    }
    const run = getWorkflowRunById(db, current.workflowRunId);
    if (!run) throw new Error("run_not_found");
    const template = loadRunTemplate(db, run);
    if (!template) throw new Error("template_not_found");

    const timestamp = now();
    const row = readStepRow(db, currentStepRunId);
    const result = terminalStepResult(db, row, "passed", timestamp, suppliedStepResult);
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'passed', finished_at = ?, blocked_reason = NULL, step_result_json = ? WHERE id = ?"
    ).run(timestamp, serializeStepResult(result), currentStepRunId);
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
    materializeStepResultSafely(eventOptions, {
      goalId: current.goalId,
      workflowRunId: current.workflowRunId,
      stepRunId: currentStepRunId,
    });

    const graph = effectiveGraph(template.graph, template.steps);
    const dest = resolveStepNext(graph, current.stepTemplateId);

    if (dest.kind === "terminal") {
      // A finished terminal step does NOT auto-complete the run. The run stays
      // active with the cursor parked on the terminal step so the orchestrator can
      // yield to the user (mark_run_complete decision + complete_workflow_run
      // recommendation); completion happens only on user approval.
      return { kind: "completed-terminal", stepRun: readStep(db, currentStepRunId) };
    }

    if (dest.kind === "gate") {
      db.prepare(
        "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'gate' WHERE id = ?"
      ).run(dest.nodeId, current.workflowRunId);
      return { kind: "gate", nodeId: dest.nodeId };
    }

    // dest.kind === "step"
    const nextStepTemplateId = graphStepTemplateId(graph, dest.nodeId);
    const attempt = nextAttemptForStep(db, current.workflowRunId, nextStepTemplateId);
    const stepRun = insertStep(
      db,
      now,
      current.goalId,
      current.workflowRunId,
      nextStepTemplateId,
      ordinalForStep(template, nextStepTemplateId),
      attempt,
      eventOptions,
      dest.nodeId
    );
    return { kind: "step", stepRun };
  })();
}

export function advanceToNextStep(
  db: Database.Database,
  now: () => string,
  currentStepRunId: string,
  eventOptions?: StepEventOptions,
  suppliedStepResult?: WorkflowStepResult
): WorkflowStepRunT | null {
  const result = advanceToNextStepOrGate(db, now, currentStepRunId, eventOptions, suppliedStepResult);
  if (result.kind === "step") return result.stepRun;
  return null;
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
    const timestamp = now();
    const raw = readStepRow(db, stepRunId);
    const result = terminalStepResult(db, raw, "blocked", timestamp);
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'blocked', blocked_reason = ?, finished_at = ?, step_result_json = ? WHERE id = ?"
    ).run(sanitizeReason(reason), timestamp, serializeStepResult(result), stepRunId);
    emitEvent(
      db,
      "workflow.step.blocked",
      {
        goalId: row.goalId,
        workflowRunId: row.workflowRunId,
        stepRunId,
        stepTemplateId: row.stepTemplateId,
      },
      timestamp,
      eventOptions
    );
    materializeStepResultSafely(eventOptions, {
      goalId: row.goalId,
      workflowRunId: row.workflowRunId,
      stepRunId,
    });
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
    const raw = readStepRow(db, stepRunId);
    const result = terminalStepResult(db, raw, "failed", timestamp);
    db.prepare(
      "UPDATE workflow_step_runs SET status = 'failed', finished_at = ?, step_result_json = ? WHERE id = ?"
    ).run(timestamp, serializeStepResult(result), stepRunId);
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
    materializeStepResultSafely(eventOptions, {
      goalId: row.goalId,
      workflowRunId: row.workflowRunId,
      stepRunId,
    });
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
    const template = loadRunTemplate(db, run);
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
      eventOptions
    );
  })();
}

export function nextAttemptForStep(
  db: Database.Database,
  runId: string,
  stepTemplateId: string
): number {
  const row = db
    .prepare(
      "SELECT MAX(attempt) AS max FROM workflow_step_runs WHERE workflow_run_id = ? AND step_template_id = ?"
    )
    .get(runId, stepTemplateId) as { max: number | null };
  return (row.max ?? 0) + 1;
}
