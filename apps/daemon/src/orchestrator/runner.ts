import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS, type DomainEvent, type OrchestrationFailureCode } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { redactSecrets } from '../memory/normalize.js';
import {
  insertOrGetPendingGeneration,
  markGenerationRunning,
  markGenerationSucceeded,
  markGenerationFailed,
} from '../tasks/projection.js';
import {
  insertOrGetPendingRecommendationGeneration,
  markRecommendationGenerationRunning,
  markRecommendationGenerationSucceeded,
  markRecommendationGenerationFailed,
} from '../recommendations/projection.js';
import { computeGenerationRequestFingerprint } from './fingerprint.js';

export interface RunGenerationCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

export interface RunTaskGenerationOutput {
  taskIds: string[];
  sparse: boolean;
  data?: unknown;
}

export interface RunRecommendationGenerationOutput {
  recommendationIds: string[];
  supersededIds: string[];
  sparse: boolean;
  data?: unknown;
}

export interface RunTaskGenerationCommitResult {
  taskIds: string[];
  sparse: boolean;
  events?: DomainEvent[];
}

export interface RunRecommendationGenerationCommitResult {
  recommendationIds: string[];
  supersededIds: string[];
  sparse: boolean;
  events?: DomainEvent[];
}

export interface RunTaskGenerationOpts {
  kind: 'task';
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  providerId: string;
  providerVersion: string;
  inputFingerprint: string;
  ctx: RunGenerationCtx;
  execute: (generationId: string) => Promise<RunTaskGenerationOutput>;
  commitSuccess?: (
    generationId: string,
    output: RunTaskGenerationOutput,
    now: string
  ) => RunTaskGenerationCommitResult;
}

export interface RunRecommendationGenerationOpts {
  kind: 'recommendation';
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  providerId: string;
  providerVersion: string;
  inputFingerprint: string;
  ctx: RunGenerationCtx;
  execute: (generationId: string) => Promise<RunRecommendationGenerationOutput>;
  commitSuccess?: (
    generationId: string,
    output: RunRecommendationGenerationOutput,
    now: string
  ) => RunRecommendationGenerationCommitResult;
}

export type RunGenerationOpts = RunTaskGenerationOpts | RunRecommendationGenerationOpts;

export type RunGenerationResult =
  | { generationId: string; status: string; isNew: boolean; dirtyQueued: false }
  | { generationId: null; status: 'dirty_queued'; isNew: false; dirtyQueued: true };

// ── Module-level single-flight state ──────────────────────────────────────────
//
// Single-flight is per-goalId. While any generation is executing for a given
// Goal, additional triggers set a dirty flag instead of starting a second
// concurrent generation. On completion, if dirty, the re-evaluator is called
// once so the trigger system can re-evaluate for the Goal.

const inFlightMap = new Map<string, Promise<void>>();
const dirtyMap = new Map<string, boolean>();
let _reEvaluator: ((goalId: string) => void) | null = null;

/**
 * Register a callback invoked when a Goal completes with a pending dirty flag.
 * Called by the orchestrator trigger system  during daemon bootstrap.
 */
export function setGoalReEvaluator(fn: (goalId: string) => void): void {
  _reEvaluator = fn;
}

/** Reset all module-level state. For use in tests only. */
export function resetRunnerState(): void {
  inFlightMap.clear();
  dirtyMap.clear();
  _reEvaluator = null;
  _evDb = null;
  _evStmt = null;
}

// ── Event emission ────────────────────────────────────────────────────────────

let _evDb: Database.Database | null = null;
let _evStmt: Database.Statement | null = null;

function ensureEvStmt(db: Database.Database): Database.Statement {
  if (db !== _evDb) {
    _evDb = db;
    _evStmt = db.prepare(
      'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
  }
  return _evStmt!;
}

function emitEvent(
  db: Database.Database,
  type: DomainEvent['type'],
  goalId: string,
  payload: Record<string, unknown>,
  now: string,
  idFn: () => string
): DomainEvent {
  const stmt = ensureEvStmt(db);
  const eventId = idFn();
  const result = stmt.run(eventId, type, goalId, JSON.stringify(payload), now);
  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type,
    goalId,
    payload,
    createdAt: now,
  };
}

// ── Error classification ──────────────────────────────────────────────────────

/** Error thrown by execute callbacks to signal schema/output validation failure. */
export class SchemaValidationError extends Error {
  readonly isSchemaValidationError = true;
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

function classifyError(err: unknown): { code: OrchestrationFailureCode; message: string } {
  if (err instanceof Error) {
    if ((err as { isSchemaValidationError?: boolean }).isSchemaValidationError) {
      return { code: 'invalid_output', message: err.message };
    }
    return { code: 'provider_error', message: err.message };
  }
  return { code: 'internal_error', message: String(err) };
}

function capAndRedactMessage(msg: string): string {
  return redactSecrets(msg.slice(0, ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS));
}

// ── runGeneration ─────────────────────────────────────────────────────────────

/**
 * Unified lifecycle runner for task and recommendation generation.
 *
 * - Computes request_fingerprint and enforces DB-level idempotency via the
 *   partial unique index (pending|running|succeeded rows block duplicate inserts).
 * - Enforces single-flight per Goal via an in-process Map: a second trigger
 *   for the same Goal while one is running sets a dirty flag and returns
 *   'dirty_queued' without starting a new generation.
 * - On dirty-flag completion, calls the registered re-evaluator once so the
 *   orchestrator can schedule the next generation.
 * - Each state transition (succeeded, failed) commits projection row + event
 *   in one TX, broadcasts only after COMMIT.
 * - Failure messages are redacted and capped to 256 chars.
 */
export async function runGeneration(opts: RunGenerationOpts): Promise<RunGenerationResult> {
  const { goalId, trigger, triggerSourceId, providerId, providerVersion, inputFingerprint } = opts;
  const { ctx } = opts;
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;

  // Single-flight check: if a generation is already running for this Goal,
  // set dirty flag so re-evaluation fires once after completion.
  if (inFlightMap.has(goalId)) {
    dirtyMap.set(goalId, true);
    return { generationId: null, status: 'dirty_queued', isNew: false, dirtyQueued: true };
  }

  const requestFingerprint = computeGenerationRequestFingerprint(
    goalId, trigger, triggerSourceId, providerId, providerVersion, inputFingerprint
  );

  // Insert or retrieve an active (pending|running|succeeded) generation row.
  let generationId: string;
  let isNew: boolean;
  let generationStatus: string;
  const toPublishRequested: DomainEvent[] = [];

  const newId = idFn();
  const requestedType: DomainEvent['type'] = opts.kind === 'task'
    ? 'task.generation.requested'
    : 'recommendation.generation.requested';
  const emitRequested = () => {
    toPublishRequested.push(
      emitEvent(db, requestedType, goalId, {
        generationId: newId,
        goalId,
        trigger,
        triggerSourceId,
      }, now, idFn)
    );
  };

  if (opts.kind === 'task') {
    const { generation, isNew: _isNew } = insertOrGetPendingGeneration(db, {
      id: newId,
      goalId,
      trigger,
      triggerSourceId,
      generatorId: providerId,
      generatorVersion: providerVersion,
      inputFingerprint,
      requestFingerprint,
      requestedAt: now,
    }, emitRequested);
    generationId = generation.id;
    isNew = _isNew;
    generationStatus = generation.status;
  } else {
    const { generation, isNew: _isNew } = insertOrGetPendingRecommendationGeneration(db, {
      id: newId,
      goalId,
      trigger,
      triggerSourceId,
      providerId,
      providerVersion,
      inputFingerprint,
      requestFingerprint,
      requestedAt: now,
    }, emitRequested);
    generationId = generation.id;
    isNew = _isNew;
    generationStatus = generation.status;
  }

  if (!isNew) {
    return { generationId, status: generationStatus, isNew: false, dirtyQueued: false };
  }

  for (const ev of toPublishRequested) bus.publish(ev);

  // Capture opts.kind for use inside the async closure (TypeScript narrowing).
  const kind = opts.kind;

  // Start async execution. The returned Promise is tracked in inFlightMap so
  // concurrent triggers for the same Goal are collapsed into a dirty flag.
  const executionPromise = (async (): Promise<void> => {
    try {
      // Transition to running (no event; DB update only).
      const runningNow = ctx.now?.() ?? new Date().toISOString();
      if (kind === 'task') {
        markGenerationRunning(db, generationId, runningNow);
      } else {
        markRecommendationGenerationRunning(db, generationId, runningNow);
      }

      // Execute caller-provided generation logic.
      const output = await opts.execute(generationId);

      // Transition to succeeded: row update + event in one TX; broadcast after COMMIT.
      const successNow = ctx.now?.() ?? new Date().toISOString();
      const toPublishSuccess: DomainEvent[] = [];

      if (kind === 'task') {
        const taskOutput = output as RunTaskGenerationOutput;
        db.transaction(() => {
          const committed = opts.kind === 'task' && opts.commitSuccess
            ? opts.commitSuccess(generationId, taskOutput, successNow)
            : { taskIds: taskOutput.taskIds, sparse: taskOutput.sparse, events: [] };
          toPublishSuccess.push(...(committed.events ?? []));
          markGenerationSucceeded(db, generationId, committed.taskIds, committed.sparse, successNow);
          toPublishSuccess.push(
            emitEvent(db, 'task.generated', goalId, {
              generationId,
              goalId,
              taskIds: committed.taskIds,
              count: committed.taskIds.length,
              sparse: committed.sparse,
            }, successNow, idFn)
          );
        })();
      } else {
        const recOutput = output as RunRecommendationGenerationOutput;
        db.transaction(() => {
          const committed = opts.kind === 'recommendation' && opts.commitSuccess
            ? opts.commitSuccess(generationId, recOutput, successNow)
            : {
                recommendationIds: recOutput.recommendationIds,
                supersededIds: recOutput.supersededIds,
                sparse: recOutput.sparse,
                events: [],
              };
          toPublishSuccess.push(...(committed.events ?? []));
          markRecommendationGenerationSucceeded(
            db, generationId,
            committed.recommendationIds, committed.supersededIds,
            committed.sparse, successNow
          );
          toPublishSuccess.push(
            emitEvent(db, 'recommendation.generated', goalId, {
              generationId,
              goalId,
              recommendationIds: committed.recommendationIds,
              supersededIds: committed.supersededIds,
              count: committed.recommendationIds.length,
              sparse: committed.sparse,
            }, successNow, idFn)
          );
        })();
      }

      for (const ev of toPublishSuccess) bus.publish(ev);

    } catch (err) {
      const { code, message } = classifyError(err);
      const cappedMsg = capAndRedactMessage(message);
      const failNow = ctx.now?.() ?? new Date().toISOString();
      const toPublishFail: DomainEvent[] = [];

      if (kind === 'task') {
        db.transaction(() => {
          markGenerationFailed(db, generationId, code, cappedMsg, failNow);
          toPublishFail.push(
            emitEvent(db, 'task.generation.failed', goalId, {
              generationId,
              goalId,
              failureCode: code,
            }, failNow, idFn)
          );
        })();
      } else {
        db.transaction(() => {
          markRecommendationGenerationFailed(db, generationId, code, cappedMsg, failNow);
          toPublishFail.push(
            emitEvent(db, 'recommendation.generation.failed', goalId, {
              generationId,
              goalId,
              failureCode: code,
            }, failNow, idFn)
          );
        })();
      }

      for (const ev of toPublishFail) bus.publish(ev);

    } finally {
      inFlightMap.delete(goalId);
      if (dirtyMap.get(goalId)) {
        dirtyMap.delete(goalId);
        _reEvaluator?.(goalId);
      }
    }
  })();

  inFlightMap.set(goalId, executionPromise);

  return { generationId, status: 'pending', isNew: true, dirtyQueued: false };
}
