import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  Recommendation,
  RecommendationGeneration,
  RecommendationFeedback,
  RecommendationFieldKey,
  ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
  ORCHESTRATION_FEEDBACK_MAX_NOTE_CHARS,
  ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_SOURCES,
  type DomainEvent,
  type ProposedAction,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import { redactSecrets } from '../memory/normalize.js';
import { runGeneration } from '../generation/runner.js';
import { appendWorkflowEvent } from '../workflows/events.js';
import { getWorkflowRunById } from '../workflows/runs/projection.js';
import {
  advanceToNextStep,
  recordExitCriteriaSatisfaction,
} from '../workflows/steps/usecases.js';
import { loadRunTemplate } from '../workflows/runs/run-template.js';
import {
  decisionFingerprint,
  recordDecisionInTx,
} from '../workflows/decisions/usecases.js';
import { createRecommendationForWorkflowInTx } from '../workflows/orchestrator/workflow-recommendations.js';
import { buildRecommendationInput } from './input.js';
import type { RecommendationProvider, RecommendationProviderOutput } from './provider.js';
import { RecommendationProviderOutputSchema } from './provider.js';
import { listProposedRecommendationsByGoalAndFingerprints } from './projection.js';
import {
  insertRecommendation,
  updateRecommendationStatusRow,
  updateRecommendationSupersededRow,
  updateRecommendationModifyRow,
  getRecommendationById,
  listRecommendationsByGoal,
  insertOrGetPendingRecommendationGeneration,
  markRecommendationGenerationRunning,
  markRecommendationGenerationSucceeded,
  markRecommendationGenerationFailed,
  getRecommendationGenerationById,
  getActiveRecommendationGenerationByFp,
  listRecommendationGenerationsByGoal,
  type InsertRecommendationInput,
  type ListRecommendationsOptions,
  resetPreparedStatements as resetProjectionStmts,
} from './projection.js';
import {
  insertFeedback,
  getFeedbackById,
  getFeedbackByRecommendationId,
  getTerminalFeedbackByRecommendationId,
  resetFeedbackStatements,
} from './feedback.js';
import {
  recommendationFingerprint,
  recommendationGenerationRequestFingerprint,
  canonicalizeProposedActionJson,
} from './fingerprint.js';
import { emitMarkDone } from "../harness-transitions/emit.js";
import { resolveMarkDoneActivity } from "../activities/store.js";
import { buildGoalWriteSetRollup } from "../harness-state/write-set-rollup.js";
import type { TelemetryFacet } from "@orca/contracts";

export {
  getRecommendationById,
  listRecommendationsByGoal,
  getRecommendationGenerationById,
  getActiveRecommendationGenerationByFp,
  listRecommendationGenerationsByGoal,
  getFeedbackByRecommendationId,
  type ListRecommendationsOptions,
};

export { insertRecommendation, type InsertRecommendationInput };

export interface RecommendationCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class RecommendationNotFoundError extends Error {
  readonly code = 'recommendation_not_found' as const;
  constructor(public readonly recommendationId: string) {
    super(`Recommendation not found: ${recommendationId}`);
    this.name = 'RecommendationNotFoundError';
  }
}

export class InvalidRecommendationStatusError extends Error {
  readonly code = 'invalid_recommendation_status' as const;
  constructor(public readonly status: string, public readonly action: string) {
    super(`Cannot ${action} recommendation with status: ${status}`);
    this.name = 'InvalidRecommendationStatusError';
  }
}

export class RecommendationGenerationNotFoundError extends Error {
  readonly code = 'recommendation_generation_not_found' as const;
  constructor(public readonly generationId: string) {
    super(`Recommendation generation not found: ${generationId}`);
    this.name = 'RecommendationGenerationNotFoundError';
  }
}

export class WorkflowRecommendationActionError extends Error {
  readonly code = 'workflow_recommendation_action_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRecommendationActionError';
  }
}

interface WorkflowStepRunRow {
  id: string;
  workflow_run_id: string;
  step_template_id: string;
  ordinal: number;
  status: string;
  outstanding_exit_criteria_json: string;
}

const WORKFLOW_RECOMMENDATION_TYPES = new Set([
  'advance_workflow_step',
  'launch_workflow_session',
  'complete_workflow_run',
  'mark_artifact_satisfied',
  'request_user_input',
]);

// ── Prepared statement cache for event inserts ────────────────────────────────

let _db: Database.Database | null = null;
let _stmts: { insertEvent: Database.Statement } | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
  resetProjectionStmts();
  resetFeedbackStatements();
}

function emitEvent(
  stmts: NonNullable<typeof _stmts>,
  type: DomainEvent['type'],
  goalId: string,
  payload: Record<string, unknown>,
  now: string,
  idFn: () => string
): DomainEvent {
  const eventId = idFn();
  const result = stmts.insertEvent.run(eventId, type, goalId, JSON.stringify(payload), now);
  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type,
    goalId,
    payload,
    createdAt: now,
  };
}

const TERMINAL_STATUSES = new Set(['accepted', 'rejected', 'dismissed', 'superseded']);

function isSqliteUniqueError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function capNote(note: string | undefined): string | null {
  return note ? redactSecrets(note.trim().slice(0, ORCHESTRATION_FEEDBACK_MAX_NOTE_CHARS)) : null;
}

function parseOutstandingCriteria(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

function readStepRunRow(db: Database.Database, stepRunId: string): WorkflowStepRunRow | null {
  return db
    .prepare(
      'SELECT id, workflow_run_id, step_template_id, ordinal, status, outstanding_exit_criteria_json FROM workflow_step_runs WHERE id = ?'
    )
    .get(stepRunId) as WorkflowStepRunRow | undefined ?? null;
}

function resolveWorkflowRunId(db: Database.Database, rec: Recommendation): string | null {
  const action = rec.proposedAction;
  if (
    action.kind === 'advance_workflow_step' ||
    action.kind === 'complete_workflow_run'
  ) {
    return action.workflowRunId;
  }
  const stepRunId =
    rec.workflowStepRunId ??
    ('workflowStepRunId' in action ? action.workflowStepRunId : null);
  if (!stepRunId) return null;
  const row = db
    .prepare('SELECT workflow_run_id FROM workflow_step_runs WHERE id = ?')
    .get(stepRunId) as { workflow_run_id: string } | undefined;
  return row?.workflow_run_id ?? null;
}

function appendWorkflowRecommendationStatusEvent(
  db: Database.Database,
  rec: Recommendation,
  status: 'accepted' | 'rejected',
  now: string,
  idFn: () => string,
  toPublish: DomainEvent[]
): void {
  if (!WORKFLOW_RECOMMENDATION_TYPES.has(rec.type)) return;
  const workflowRunId = resolveWorkflowRunId(db, rec);
  const type =
    status === 'accepted'
      ? 'workflow.recommendation.accepted'
      : 'workflow.recommendation.rejected';
  toPublish.push(
    appendWorkflowEvent(
      db,
      type,
      {
        recommendationId: rec.id,
        goalId: rec.goalId,
        workflowRunId,
        stepRunId: rec.workflowStepRunId ?? null,
        type: rec.type,
        status,
      },
      now,
      idFn
    )
  );
}

function assertFinalStepReadyForCompletion(
  db: Database.Database,
  workflowRunId: string,
  stepRunId: string
): void {
  const run = getWorkflowRunById(db, workflowRunId);
  if (!run) {
    throw new WorkflowRecommendationActionError(`Workflow run not found: ${workflowRunId}`);
  }
  if (run.status !== 'active') {
    throw new WorkflowRecommendationActionError(`Workflow run is not active: ${workflowRunId}`);
  }
  if (run.currentStepRunId !== stepRunId) {
    throw new WorkflowRecommendationActionError(
      `Workflow run ${workflowRunId} is no longer on step ${stepRunId}`
    );
  }

  const stepRun = readStepRunRow(db, stepRunId);
  if (!stepRun || stepRun.workflow_run_id !== workflowRunId) {
    throw new WorkflowRecommendationActionError(`Workflow step run not found: ${stepRunId}`);
  }
  if (stepRun.status !== 'active') {
    throw new WorkflowRecommendationActionError(`Workflow step run is not active: ${stepRunId}`);
  }
  if (parseOutstandingCriteria(stepRun.outstanding_exit_criteria_json).length > 0) {
    throw new WorkflowRecommendationActionError(
      `Workflow step run ${stepRunId} still has outstanding exit criteria`
    );
  }

  const template = loadRunTemplate(db, run);
  if (!template) {
    throw new WorkflowRecommendationActionError(`Workflow template not found: ${run.templateId}`);
  }
  const nextStep = template.steps.find((step) => step.ordinal === stepRun.ordinal + 1);
  if (nextStep) {
    throw new WorkflowRecommendationActionError(
      `Workflow run ${workflowRunId} is not at its final step`
    );
  }
}

function reEvaluateAfterArtifactSatisfactionInTx(
  db: Database.Database,
  now: string,
  idFn: () => string,
  stepRunId: string,
  stagedEvents: DomainEvent[]
): void {
  const stepRun = readStepRunRow(db, stepRunId);
  if (!stepRun) return;

  const outstanding = parseOutstandingCriteria(stepRun.outstanding_exit_criteria_json);
  if (outstanding.length > 0) return;

  const run = getWorkflowRunById(db, stepRun.workflow_run_id);
  if (!run || run.status !== 'active' || run.currentStepRunId !== stepRunId) return;

  const template = loadRunTemplate(db, run);
  if (!template) return;

  const stepTemplate = template.steps.find((step) => step.id === stepRun.step_template_id);
  const nextStep = template.steps.find((step) => step.ordinal === stepRun.ordinal + 1);
  const completing = nextStep === undefined;

  stagedEvents.push(
    appendWorkflowEvent(
      db,
      'workflow.decision.requested',
      {
        goalId: run.goalId,
        workflowRunId: run.id,
        stepRunId,
        stepTemplateId: stepRun.step_template_id,
      },
      now,
      idFn
    )
  );

  const decision = recordDecisionInTx(
    db,
    () => now,
    {
      goalId: run.goalId,
      workflowRunId: run.id,
      stepRunId,
      decisionType: completing ? 'mark_run_complete' : 'advance_step',
      selectedAction: completing
        ? 'recommend_complete_run'
        : `recommend_advance:${nextStep.id}`,
      reason: completing
        ? 'Final step criteria satisfied; user approval required before completing the run'
        : 'All exit criteria satisfied; user approval required before advancing',
      influencedBy: [
        {
          kind: 'workflow_step',
          id: stepRun.step_template_id,
          label: stepTemplate?.name ?? stepRun.step_template_id,
          effect: 'satisfied',
        },
      ],
      inputFingerprint: decisionFingerprint({
        runId: run.id,
        stepRunId,
        decisionType: completing ? 'mark_run_complete' : 'advance_step',
        payload: nextStep?.id ?? 'complete',
      }),
    },
    { idFactory: idFn, stagedEvents }
  );

  createRecommendationForWorkflowInTx(
    db,
    () => now,
    {
      goalId: run.goalId,
      workflowRunId: run.id,
      stepRunId,
      type: completing ? 'complete_workflow_run' : 'advance_workflow_step',
      proposedAction: completing
        ? { kind: 'complete_workflow_run', workflowRunId: run.id, workflowStepRunId: stepRunId }
        : {
            kind: 'advance_workflow_step',
            workflowRunId: run.id,
            workflowStepRunId: stepRunId,
            toStepTemplateId: nextStep.id,
          },
      rationale: completing
        ? 'Final step criteria are satisfied; approve to complete the workflow run.'
        : 'All exit criteria satisfied; approve to advance to the next workflow step.',
      decisionId: decision.decisionId,
    },
    { idFactory: idFn, stagedEvents }
  );
}

function applyWorkflowAcceptSideEffectsInTx(
  db: Database.Database,
  now: string,
  idFn: () => string,
  bus: EventBus,
  rec: Recommendation,
  stagedEvents: DomainEvent[]
): void {
  if (!WORKFLOW_RECOMMENDATION_TYPES.has(rec.type)) return;

  const action = rec.proposedAction;
  switch (action.kind) {
    case 'advance_workflow_step': {
      advanceToNextStep(db, () => now, action.workflowStepRunId, {
        idFactory: idFn,
        stagedEvents,
        activityCtx: { db, bus, now: () => now, idFactory: idFn },
      });
      return;
    }
    case 'complete_workflow_run': {
      assertFinalStepReadyForCompletion(db, action.workflowRunId, action.workflowStepRunId);
      // Marks the terminal step passed; the terminal step yields rather than
      // auto-completing the run, so the user-approved completion happens here.
      advanceToNextStep(db, () => now, action.workflowStepRunId, {
        idFactory: idFn,
        stagedEvents,
        activityCtx: { db, bus, now: () => now, idFactory: idFn },
      });
      db.prepare(
        "UPDATE workflow_runs SET status = 'completed', finished_at = ?, current_step_run_id = NULL, current_node_id = NULL, current_node_kind = NULL WHERE id = ?"
      ).run(now, action.workflowRunId);
      // Human-authoritative completion: accepting the terminal recommendation
      // transitions the goal's lifecycle to completed in the same transaction as
      // the run completion (preserving an archived goal). Deterministic control-
      // plane owns the lifecycle; clients read the resulting projection.
      db.prepare(
        "UPDATE goals SET active_workflow_run_id = NULL, " +
          "status = CASE WHEN status = 'archived' THEN status ELSE 'completed' END, " +
          "updated_at = ? WHERE id = ? AND active_workflow_run_id = ?"
      ).run(now, rec.goalId, action.workflowRunId);
      stagedEvents.push(
        appendWorkflowEvent(
          db,
          'workflow.run.completed',
          {
            goalId: rec.goalId,
            workflowRunId: action.workflowRunId,
            status: 'completed',
          },
          now,
          idFn
        )
      );
      return;
    }
    case 'mark_artifact_satisfied': {
      recordExitCriteriaSatisfaction(db, () => now, action.workflowStepRunId, [
        action.artifactType,
      ]);
      reEvaluateAfterArtifactSatisfactionInTx(
        db,
        now,
        idFn,
        action.workflowStepRunId,
        stagedEvents
      );
      return;
    }
    case 'launch_workflow_session':
    case 'request_user_input':
      return;
    default:
      return;
  }
}

// ── Shared terminal-feedback helper ───────────────────────────────────────────

type TerminalAction = 'accept' | 'reject' | 'dismiss';

interface TerminalFeedbackResult {
  recommendation: Recommendation;
  feedback: RecommendationFeedback;
  alreadyDone: boolean;
}

function recordTerminalFeedback(
  ctx: RecommendationCtx,
  rec: Recommendation,
  action: TerminalAction,
  targetStatus: string,
  eventType: DomainEvent['type'],
  note: string | null
): TerminalFeedbackResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const feedbackId = idFn();
  const toPublish: DomainEvent[] = [];

  try {
    db.transaction(() => {
      insertFeedback(db, {
        id: feedbackId,
        goalId: rec.goalId,
        recommendationId: rec.id,
        action,
        note,
        modifiedPayloadJson: null,
        createdAt: now,
      });
      updateRecommendationStatusRow(db, rec.id, targetStatus, now, now);
      if (action === 'accept') {
        applyWorkflowAcceptSideEffectsInTx(db, now, idFn, bus, rec, toPublish);
      }
      toPublish.push(
        emitEvent(stmts, eventType, rec.goalId, {
          recommendationId: rec.id,
          goalId: rec.goalId,
          type: rec.type,
        }, now, idFn)
      );
      if (action === 'accept' || action === 'reject') {
        appendWorkflowRecommendationStatusEvent(
          db,
          rec,
          action === 'accept' ? 'accepted' : 'rejected',
          now,
          idFn,
          toPublish
        );
      }
      toPublish.push(
        emitEvent(stmts, 'user.feedback.recorded', rec.goalId, {
          feedbackId,
          goalId: rec.goalId,
          recommendationId: rec.id,
          action,
        }, now, idFn)
      );
    })();
  } catch (err) {
    if (isSqliteUniqueError(err)) {
      const current = getRecommendationById(db, rec.id)!;
      const existing = getTerminalFeedbackByRecommendationId(db, rec.id);
      return { recommendation: current, feedback: existing!, alreadyDone: true };
    }
    throw err;
  }

  for (const ev of toPublish) bus.publish(ev);

  // Human-authoritative completion crossed the harness ledger's terminal boundary.
  // Emitted post-commit because recordHarnessTransition opens its own transaction
  // and better-sqlite3 forbids nesting. Swallow-and-log: a transition failure must
  // never break completion. Deferred enrichments (cumulative write-set, Goal-total
  // cost roll-up) are tracked in FUTURE_WORK.md 2.7.
  if (action === "accept" && rec.proposedAction.kind === "complete_workflow_run") {
    try {
      const telemetry: TelemetryFacet = {
        cost: null, latency_ms: null, model: null,
        provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null,
        rejected_alternatives: [],
        human_interventions: [{ kind: "mark_done_approval", ref: rec.id }],
        outcome: { status: "succeeded", failure_code: null },
      };
      const stateDeps = buildGoalWriteSetRollup(db, rec.goalId, rec.proposedAction.workflowRunId);
      emitMarkDone(
        { db, bus, now: () => now, idFactory: idFn },
        { goalId: rec.goalId, workflowRunId: rec.proposedAction.workflowRunId, telemetry, stateDeps }
      );
      resolveMarkDoneActivity(
        { db, bus, now: () => now, idFactory: idFn },
        { stepRunId: rec.proposedAction.workflowStepRunId }
      );
    } catch (err) {
      console.error("emitMarkDone failed", err);
    }
  }

  return {
    recommendation: getRecommendationById(db, rec.id)!,
    feedback: getFeedbackById(db, feedbackId)!,
    alreadyDone: false,
  };
}

// ── Accept ────────────────────────────────────────────────────────────────────

export interface AcceptResult {
  recommendation: Recommendation;
  feedback: RecommendationFeedback;
  alreadyAccepted: boolean;
}

export function acceptRecommendation(
  ctx: RecommendationCtx,
  id: string,
  note?: string
): AcceptResult {
  const { db } = ctx;
  const rec = getRecommendationById(db, id);
  if (!rec) throw new RecommendationNotFoundError(id);

  if (rec.status === 'accepted') {
    return { recommendation: rec, feedback: getTerminalFeedbackByRecommendationId(db, id)!, alreadyAccepted: true };
  }
  if (rec.status !== 'proposed' && rec.status !== 'modified') {
    throw new InvalidRecommendationStatusError(rec.status, 'accept');
  }

  const { recommendation, feedback, alreadyDone } = recordTerminalFeedback(
    ctx, rec, 'accept', 'accepted', 'recommendation.accepted', capNote(note)
  );
  return { recommendation, feedback, alreadyAccepted: alreadyDone };
}

// ── Reject ────────────────────────────────────────────────────────────────────

export interface RejectResult {
  recommendation: Recommendation;
  feedback: RecommendationFeedback;
  alreadyRejected: boolean;
}

export function rejectRecommendation(
  ctx: RecommendationCtx,
  id: string,
  note?: string
): RejectResult {
  const { db } = ctx;
  const rec = getRecommendationById(db, id);
  if (!rec) throw new RecommendationNotFoundError(id);

  if (rec.status === 'rejected') {
    return { recommendation: rec, feedback: getTerminalFeedbackByRecommendationId(db, id)!, alreadyRejected: true };
  }
  if (rec.status !== 'proposed' && rec.status !== 'modified') {
    throw new InvalidRecommendationStatusError(rec.status, 'reject');
  }

  const { recommendation, feedback, alreadyDone } = recordTerminalFeedback(
    ctx, rec, 'reject', 'rejected', 'recommendation.rejected', capNote(note)
  );
  return { recommendation, feedback, alreadyRejected: alreadyDone };
}

// ── Dismiss ───────────────────────────────────────────────────────────────────

export interface DismissResult {
  recommendation: Recommendation;
  feedback: RecommendationFeedback;
  alreadyDismissed: boolean;
}

export function dismissRecommendation(
  ctx: RecommendationCtx,
  id: string,
  note?: string
): DismissResult {
  const { db } = ctx;
  const rec = getRecommendationById(db, id);
  if (!rec) throw new RecommendationNotFoundError(id);

  if (rec.status === 'dismissed') {
    return { recommendation: rec, feedback: getTerminalFeedbackByRecommendationId(db, id)!, alreadyDismissed: true };
  }
  if (TERMINAL_STATUSES.has(rec.status)) {
    throw new InvalidRecommendationStatusError(rec.status, 'dismiss');
  }

  const { recommendation, feedback, alreadyDone } = recordTerminalFeedback(
    ctx, rec, 'dismiss', 'dismissed', 'recommendation.dismissed', capNote(note)
  );
  return { recommendation, feedback, alreadyDismissed: alreadyDone };
}

// ── Modify ────────────────────────────────────────────────────────────────────

export interface ModifyRecommendationPatch {
  title?: string;
  rationale?: string;
  proposedAction?: ProposedAction;
}

export interface ModifyResult {
  recommendation: Recommendation;
  feedback: RecommendationFeedback;
}

export function modifyRecommendation(
  ctx: RecommendationCtx,
  id: string,
  patch: ModifyRecommendationPatch,
  note?: string
): ModifyResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const rec = getRecommendationById(db, id);
  if (!rec) throw new RecommendationNotFoundError(id);

  if (TERMINAL_STATUSES.has(rec.status)) {
    throw new InvalidRecommendationStatusError(rec.status, 'modify');
  }

  const changedFields: string[] = [];

  const newTitle = patch.title !== undefined
    ? redactSecrets(patch.title.trim().slice(0, ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS))
    : rec.title;
  if (newTitle !== rec.title) changedFields.push('title');

  const newRationale = patch.rationale !== undefined
    ? redactSecrets(patch.rationale.trim().slice(0, ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS))
    : rec.rationale;
  if (newRationale !== rec.rationale) changedFields.push('rationale');

  const oldProposedActionJson = JSON.stringify(rec.proposedAction);
  const newProposedActionJson = patch.proposedAction !== undefined
    ? JSON.stringify(patch.proposedAction)
    : oldProposedActionJson;
  if (newProposedActionJson !== oldProposedActionJson) changedFields.push('proposedAction');

  if (rec.status !== 'modified') changedFields.push('status');
  if (rec.source !== 'user_modified') changedFields.push('source');

  const newFingerprint = newProposedActionJson !== oldProposedActionJson
    ? recommendationFingerprint(
        rec.goalId,
        rec.type,
        canonicalizeProposedActionJson(newProposedActionJson)
      )
    : rec.fingerprint;

  const feedbackId = idFn();
  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    insertFeedback(db, {
      id: feedbackId,
      goalId: rec.goalId,
      recommendationId: id,
      action: 'modify',
      note: capNote(note),
      modifiedPayloadJson: oldProposedActionJson,
      createdAt: now,
    });
    updateRecommendationModifyRow(db, id, {
      title: newTitle,
      rationale: newRationale,
      proposedActionJson: newProposedActionJson,
      fingerprint: newFingerprint,
    }, now);
    toPublish.push(
      emitEvent(stmts, 'recommendation.modified', rec.goalId, {
        recommendationId: id,
        goalId: rec.goalId,
        changedFields: changedFields as RecommendationFieldKey[],
      }, now, idFn)
    );
    toPublish.push(
      emitEvent(stmts, 'user.feedback.recorded', rec.goalId, {
        feedbackId,
        goalId: rec.goalId,
        recommendationId: id,
        action: 'modify',
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return {
    recommendation: getRecommendationById(db, id)!,
    feedback: getFeedbackById(db, feedbackId)!,
  };
}

// ── Supersede ─────────────────────────────────────────────────────────────────

export type SupersedeReason = 'duplicate' | 'source_archived' | 'manual';

export interface SupersedeResult {
  recommendation: Recommendation;
}

export function supersedeRecommendation(
  ctx: RecommendationCtx,
  id: string,
  bySupersedingId: string | null,
  reason: SupersedeReason
): SupersedeResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const rec = getRecommendationById(db, id);
  if (!rec) throw new RecommendationNotFoundError(id);

  if (rec.status !== 'proposed') {
    throw new InvalidRecommendationStatusError(rec.status, 'supersede');
  }

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    updateRecommendationSupersededRow(db, id, bySupersedingId, reason, now, now);
    toPublish.push(
      emitEvent(stmts, 'recommendation.superseded', rec.goalId, {
        recommendationId: id,
        goalId: rec.goalId,
        bySupersedingId,
        reason,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return { recommendation: getRecommendationById(db, id)! };
}

// ── Generation lifecycle helpers ──────────────────────────────────────────────

export interface InsertPendingRecommendationGenerationInput {
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  providerId: string;
  providerVersion: string;
  inputFingerprint: string;
}

export function insertPendingRecommendationGeneration(
  ctx: RecommendationCtx,
  input: InsertPendingRecommendationGenerationInput
): { generation: RecommendationGeneration; isNew: boolean } {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const requestFingerprint = recommendationGenerationRequestFingerprint(
    input.goalId,
    input.trigger,
    input.triggerSourceId,
    input.providerId,
    input.providerVersion,
    input.inputFingerprint
  );

  const id = idFn();

  const toPublish: DomainEvent[] = [];
  const { generation, isNew } = insertOrGetPendingRecommendationGeneration(db, {
    id,
    goalId: input.goalId,
    trigger: input.trigger,
    triggerSourceId: input.triggerSourceId,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    inputFingerprint: input.inputFingerprint,
    requestFingerprint,
    requestedAt: now,
  }, () => {
    toPublish.push(
      emitEvent(stmts, 'recommendation.generation.requested', input.goalId, {
        generationId: id,
        goalId: input.goalId,
        trigger: input.trigger,
        triggerSourceId: input.triggerSourceId,
      }, now, idFn)
    );
  });
  if (isNew) {
    for (const ev of toPublish) bus.publish(ev);
  }

  return { generation, isNew };
}

export function markRecommendationGenerationRunningUseCase(
  ctx: RecommendationCtx,
  generationId: string,
  startedAt?: string
): RecommendationGeneration {
  const { db } = ctx;
  const now = startedAt ?? ctx.now?.() ?? new Date().toISOString();
  const gen = getRecommendationGenerationById(db, generationId);
  if (!gen) throw new RecommendationGenerationNotFoundError(generationId);
  markRecommendationGenerationRunning(db, generationId, now);
  return getRecommendationGenerationById(db, generationId)!;
}

export function markRecommendationGenerationSucceededUseCase(
  ctx: RecommendationCtx,
  generationId: string,
  recommendationIds: string[],
  supersededIds: string[],
  sparse: boolean,
  finishedAt?: string
): RecommendationGeneration {
  const { db, bus } = ctx;
  const now = finishedAt ?? ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const gen = getRecommendationGenerationById(db, generationId);
  if (!gen) throw new RecommendationGenerationNotFoundError(generationId);

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    markRecommendationGenerationSucceeded(db, generationId, recommendationIds, supersededIds, sparse, now);
    toPublish.push(
      emitEvent(stmts, 'recommendation.generated', gen.goalId, {
        generationId,
        goalId: gen.goalId,
        recommendationIds,
        supersededIds,
        count: recommendationIds.length,
        sparse,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getRecommendationGenerationById(db, generationId)!;
}

// ── runRecommendationGeneration ───────────────────────────────────────────────

export interface RecommendationGenerationCtx {
  db: Database.Database;
  bus: EventBus;
  recommendationProvider: RecommendationProvider;
  now?: () => string;
  idFactory?: () => string;
}

export interface RunRecommendationGenerationInput {
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
}

class SchemaValidationError extends Error {
  readonly code = 'invalid_output' as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'SchemaValidationError';
  }
}

export async function runRecommendationGeneration(
  ctx: RecommendationGenerationCtx,
  input: RunRecommendationGenerationInput
): Promise<RecommendationGeneration> {
  const { db, bus } = ctx;
  const idFn = ctx.idFactory ?? randomUUID;

  const providerInput = buildRecommendationInput({ db, goalId: input.goalId, trigger: input.trigger });

  const runResult = await runGeneration({
    kind: 'recommendation',
    goalId: input.goalId,
    trigger: input.trigger,
    triggerSourceId: input.triggerSourceId,
    providerId: ctx.recommendationProvider.id,
    providerVersion: ctx.recommendationProvider.version,
    inputFingerprint: providerInput.inputFingerprint,
    ctx: { db, bus, now: ctx.now, idFactory: ctx.idFactory },
    execute: async () => {
      const rawOutput = await ctx.recommendationProvider.generate(providerInput);
      const parsed = RecommendationProviderOutputSchema.safeParse(rawOutput);
      if (!parsed.success) {
        throw new SchemaValidationError(parsed.error.message.slice(0, ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS));
      }

      const { candidates, sparse } = parsed.data;

      // Compute per-candidate fingerprints
      const candidateFps = candidates.map((c) => {
        const canonical = canonicalizeProposedActionJson(JSON.stringify(c.proposedAction));
        return { candidate: c, fingerprint: recommendationFingerprint(input.goalId, c.type, canonical) };
      });

      // Find existing proposed rows with matching fingerprints (to supersede)
      const existingProposed = listProposedRecommendationsByGoalAndFingerprints(
        db,
        input.goalId,
        candidateFps.map((cf) => cf.fingerprint)
      );

      return {
        recommendationIds: [],
        supersededIds: [],
        sparse,
        data: { candidateFps, existingProposed },
      };
    },
    commitSuccess: (generationId, output, insertNow) => {
      const { candidateFps, existingProposed } = output.data as {
        candidateFps: Array<{
          candidate: RecommendationProviderOutput['candidates'][number];
          fingerprint: string;
        }>;
        existingProposed: ReturnType<typeof listProposedRecommendationsByGoalAndFingerprints>;
      };
      const existingFpSet = new Set(existingProposed.map((r) => r.fingerprint));
      const stmts = ensureStmts(db);
      const recommendationIds: string[] = [];
      const supersededIds: string[] = [];
      const events: DomainEvent[] = [];

      for (const existing of existingProposed) {
        if (existing.status !== 'proposed') continue;
        updateRecommendationSupersededRow(db, existing.id, null, 'duplicate', insertNow, insertNow);
        events.push(
          emitEvent(stmts, 'recommendation.superseded', input.goalId, {
            recommendationId: existing.id,
            goalId: input.goalId,
            bySupersedingId: null,
            reason: 'duplicate',
          }, insertNow, idFn)
        );
        supersededIds.push(existing.id);
      }

      for (const { candidate: c, fingerprint } of candidateFps) {
        if (existingFpSet.has(fingerprint)) {
          // We just superseded the existing row — still insert the replacement.
        }

        const id = idFn();
        const title = redactSecrets(c.title.trim().slice(0, ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS));
        const rationale = redactSecrets(c.rationale.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS));
        const proposedActionJson = JSON.stringify(c.proposedAction);
        const sourcesJson = JSON.stringify(c.sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES));

        if (new TextEncoder().encode(proposedActionJson).length > ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES) {
          continue;
        }

        insertRecommendation(db, {
          id,
          goalId: input.goalId,
          generationId,
          type: c.type,
          status: 'proposed',
          source: 'deterministic_provider',
          title,
          rationale,
          proposedActionJson,
          confidence: c.confidence,
          sourcesJson,
          relatedTaskId: c.relatedTaskId ?? null,
          relatedSessionId: c.relatedSessionId ?? null,
          relatedContextPkgId: c.relatedContextPackageId ?? null,
          relatedConflictId: c.relatedConflictId ?? null,
          fingerprint,
          supersededById: null,
          createdAt: insertNow,
          updatedAt: insertNow,
        });
        recommendationIds.push(id);
      }

      return { recommendationIds, supersededIds, sparse: output.sparse, events };
    },
  });

  if (runResult.generationId === null) {
    throw new Error(`Recommendation generation for goal ${input.goalId} was queued for re-evaluation`);
  }

  const generation = getRecommendationGenerationById(db, runResult.generationId);
  if (!generation) {
    throw new RecommendationGenerationNotFoundError(runResult.generationId);
  }
  return generation;
}

export function markRecommendationGenerationFailedUseCase(
  ctx: RecommendationCtx,
  generationId: string,
  failureCode: string,
  failureMessage: string | null,
  finishedAt?: string
): RecommendationGeneration {
  const { db, bus } = ctx;
  const now = finishedAt ?? ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const gen = getRecommendationGenerationById(db, generationId);
  if (!gen) throw new RecommendationGenerationNotFoundError(generationId);

  const cappedMsg = failureMessage
    ? redactSecrets(failureMessage.slice(0, ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS))
    : null;

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    markRecommendationGenerationFailed(db, generationId, failureCode, cappedMsg, now);
    toPublish.push(
      emitEvent(stmts, 'recommendation.generation.failed', gen.goalId, {
        generationId,
        goalId: gen.goalId,
        failureCode,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getRecommendationGenerationById(db, generationId)!;
}
