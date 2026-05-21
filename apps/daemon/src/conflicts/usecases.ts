import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  Conflict,
  type ConflictSourceRef,
  type DomainEvent,
  M7_RECOMMENDATION_MAX_TITLE_CHARS,
  M7_RECOMMENDATION_MAX_RATIONALE_CHARS,
  M7_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
  M7_CONFLICT_MAX_DESCRIPTION_CHARS,
  M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS,
  M7_TASK_MAX_TITLE_CHARS,
  M7_RECOMMENDATION_MAX_SOURCES,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import { redactSecrets } from '../memory/normalize.js';
import {
  insertConflictRow,
  updateConflictStatusRow,
  getConflictById,
  getExistingOpenConflict,
  getLinkedResolveConflictRec,
  listConflictsByGoal,
  resetPreparedStatements as resetProjectionStmts,
  type ListConflictsOptions,
} from './projection.js';
import {
  insertFeedback,
  resetFeedbackStatements,
} from '../recommendations/feedback.js';
import {
  insertRecommendation,
  updateRecommendationStatusRow,
  resetPreparedStatements as resetRecProjectionStmts,
} from '../recommendations/projection.js';
import { resolveConflictCandidate } from '../recommendations/rules.js';
import {
  canonicalizeProposedActionJson,
  recommendationFingerprint,
  recommendationGenerationRequestFingerprint,
} from '../recommendations/fingerprint.js';
import {
  DeterministicConflictDetector,
  resetPreparedStatements as resetDetectorStatements,
  type ConflictCandidate,
  type ConflictDetector,
  type TriggerEventRef,
} from './detectors.js';
import { conflictFingerprint } from './fingerprint.js';

export { getConflictById, listConflictsByGoal, type ListConflictsOptions };

export interface ConflictCtx {
  db: Database.Database;
  bus: EventBus;
  conflictDetector?: ConflictDetector;
  now?: () => string;
  idFactory?: () => string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class ConflictNotFoundError extends Error {
  readonly code = 'conflict_not_found' as const;
  constructor(public readonly conflictId: string) {
    super(`Conflict not found: ${conflictId}`);
    this.name = 'ConflictNotFoundError';
  }
}

export class InvalidConflictStatusError extends Error {
  readonly code = 'invalid_conflict_status' as const;
  constructor(
    public readonly status: string,
    public readonly action: string
  ) {
    super(`Cannot ${action} conflict with status: ${status}`);
    this.name = 'InvalidConflictStatusError';
  }
}

export class EmptyConflictSourcesError extends Error {
  readonly code = 'empty_conflict_sources' as const;
  constructor() {
    super('Conflict sources must be non-empty');
    this.name = 'EmptyConflictSourcesError';
  }
}

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
  resetRecProjectionStmts();
  resetFeedbackStatements();
  resetDetectorStatements();
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

function capTitle(s: string): string {
  return s.trim().slice(0, M7_TASK_MAX_TITLE_CHARS);
}

function capDescription(s: string): string {
  return s.trim().slice(0, M7_CONFLICT_MAX_DESCRIPTION_CHARS);
}

function capResolutionNote(note: string | undefined): string | null {
  return note
    ? redactSecrets(note.trim().slice(0, M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS))
    : null;
}

function capSources(sources: ConflictSourceRef[]): ConflictSourceRef[] {
  return sources.slice(0, M7_RECOMMENDATION_MAX_SOURCES);
}

const RESOLVE_CONFLICT_PROVIDER_ID = 'orca/conflict-detector-resolve-conflict';
const RESOLVE_CONFLICT_PROVIDER_VERSION = '0.1.0';

interface ClosedConflictRow {
  id: string;
  status: string;
  detected_at: string;
  resolved_at: string | null;
}

function latestClosedConflictByFingerprint(
  db: Database.Database,
  goalId: string,
  fingerprint: string
): ClosedConflictRow | null {
  const row = db
    .prepare(
      `SELECT id, status, detected_at, resolved_at
       FROM conflicts
       WHERE goal_id = ? AND fingerprint = ? AND status != 'open'
       ORDER BY COALESCE(resolved_at, detected_at) DESC, id DESC
       LIMIT 1`
    )
    .get(goalId, fingerprint) as ClosedConflictRow | undefined;
  return row ?? null;
}

function sourceAdvancedAfterDismissal(candidate: ConflictCandidate, dismissed: ClosedConflictRow): boolean {
  const baseline = dismissed.resolved_at ?? dismissed.detected_at;
  // Reset rule: a dismissed fingerprint reopens only after at least one current
  // source timestamp is strictly newer than the dismissal timestamp.
  return candidate.sourceUpdatedAts.some((updatedAt) => updatedAt > baseline);
}

function shouldInsertCandidate(
  db: Database.Database,
  goalId: string,
  fingerprint: string,
  candidate: ConflictCandidate
): boolean {
  if (getExistingOpenConflict(db, goalId, fingerprint)) return false;
  const latestClosed = latestClosedConflictByFingerprint(db, goalId, fingerprint);
  if (latestClosed?.status === 'dismissed') {
    return sourceAdvancedAfterDismissal(candidate, latestClosed);
  }
  return true;
}

function insertSucceededRecommendationGeneration(
  db: Database.Database,
  input: {
    id: string;
    goalId: string;
    triggerSourceId: string;
    inputFingerprint: string;
    recommendationId: string;
    now: string;
  }
): void {
  const requestFingerprint = recommendationGenerationRequestFingerprint(
    input.goalId,
    'conflict_detected',
    input.triggerSourceId,
    RESOLVE_CONFLICT_PROVIDER_ID,
    RESOLVE_CONFLICT_PROVIDER_VERSION,
    input.inputFingerprint
  );

  db.prepare(`
    INSERT INTO recommendation_generations
      (id, goal_id, trigger, trigger_source_id, provider_id, provider_version,
       input_fingerprint, request_fingerprint, status, failure_code, failure_message,
       recommendation_ids_json, superseded_ids_json, sparse, requested_at, started_at, finished_at)
    VALUES (?, ?, 'conflict_detected', ?, ?, ?, ?, ?, 'succeeded', NULL, NULL, ?, '[]', 0, ?, ?, ?)
  `).run(
    input.id,
    input.goalId,
    input.triggerSourceId,
    RESOLVE_CONFLICT_PROVIDER_ID,
    RESOLVE_CONFLICT_PROVIDER_VERSION,
    input.inputFingerprint,
    requestFingerprint,
    JSON.stringify([input.recommendationId]),
    input.now,
    input.now,
    input.now
  );
}

function insertResolveConflictRecommendation(
  db: Database.Database,
  input: {
    id: string;
    goalId: string;
    generationId: string;
    conflictId: string;
    conflictTitle: string;
    candidate: ConflictCandidate;
    now: string;
  }
): void {
  const generated = resolveConflictCandidate({
    conflictId: input.conflictId,
    conflictTitle: input.conflictTitle,
    goalId: input.goalId,
  });
  const title = redactSecrets(generated.title.trim().slice(0, M7_RECOMMENDATION_MAX_TITLE_CHARS));
  const rationale = redactSecrets(
    generated.rationale.slice(0, M7_RECOMMENDATION_MAX_RATIONALE_CHARS)
  );
  const proposedActionJson = JSON.stringify(generated.proposedAction);
  if (new TextEncoder().encode(proposedActionJson).length > M7_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES) {
    throw new Error('resolve_conflict proposedAction exceeded M7 cap');
  }
  const canonical = canonicalizeProposedActionJson(proposedActionJson);

  const sources = [
    ...generated.sources,
    ...input.candidate.recommendationSources,
  ].slice(0, M7_RECOMMENDATION_MAX_SOURCES);

  insertRecommendation(db, {
    id: input.id,
    goalId: input.goalId,
    generationId: input.generationId,
    type: generated.type,
    status: 'proposed',
    source: 'deterministic_provider',
    title,
    rationale,
    proposedActionJson,
    confidence: generated.confidence,
    sourcesJson: JSON.stringify(sources),
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: input.conflictId,
    fingerprint: recommendationFingerprint(input.goalId, generated.type, canonical),
    supersededById: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

// ── Auto-dismiss helper ───────────────────────────────────────────────────────

/**
 * Auto-dismiss helper: the only automatic lifecycle transition in M7 (Section 12).
 * MUST be called inside an existing database transaction.
 * Exported only for use by resolveConflict / dismissConflict and their tests.
 */
export function autoDismissResolveConflictRecommendation(
  db: Database.Database,
  stmts: { insertEvent: Database.Statement },
  conflictId: string,
  goalId: string,
  now: string,
  idFn: () => string
): DomainEvent[] {
  const linked = getLinkedResolveConflictRec(db, conflictId);
  if (!linked) return [];
  if (TERMINAL_STATUSES.has(linked.status)) return [];

  const feedbackId = idFn();
  const events: DomainEvent[] = [];

  insertFeedback(db, {
    id: feedbackId,
    goalId,
    recommendationId: linked.id,
    action: 'dismiss',
    note: 'conflict_resolved',
    modifiedPayloadJson: null,
    createdAt: now,
  });

  updateRecommendationStatusRow(db, linked.id, 'dismissed', now, now);

  events.push(
    emitEvent(
      stmts,
      'recommendation.dismissed',
      goalId,
      { recommendationId: linked.id, goalId, type: linked.type },
      now,
      idFn
    )
  );

  events.push(
    emitEvent(
      stmts,
      'user.feedback.recorded',
      goalId,
      { feedbackId, goalId, recommendationId: linked.id, action: 'dismiss' },
      now,
      idFn
    )
  );

  return events;
}

// ── Insert open conflict ──────────────────────────────────────────────────────

export interface InsertOpenConflictInput {
  goalId: string;
  conflictType: Conflict['conflictType'];
  severity: Conflict['severity'];
  title: string;
  description: string;
  sources: ConflictSourceRef[];
  fingerprint: string;
}

export interface InsertOpenConflictResult {
  conflict: Conflict;
  isNew: boolean;
}

export function insertOpenConflict(
  ctx: ConflictCtx,
  input: InsertOpenConflictInput
): InsertOpenConflictResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  if (input.sources.length === 0) throw new EmptyConflictSourcesError();

  const title = capTitle(input.title);
  const description = capDescription(input.description);
  const sources = capSources(input.sources);
  const id = idFn();

  const toPublish: DomainEvent[] = [];
  let wasNew = false;

  db.transaction(() => {
    const { isNew } = insertConflictRow(db, {
      id,
      goalId: input.goalId,
      conflictType: input.conflictType,
      severity: input.severity,
      title,
      description,
      sourcesJson: JSON.stringify(sources),
      fingerprint: input.fingerprint,
      detectedAt: now,
    });

    wasNew = isNew;

    if (isNew) {
      toPublish.push(
        emitEvent(
          stmts,
          'conflict.detected',
          input.goalId,
          {
            conflictId: id,
            goalId: input.goalId,
            conflictType: input.conflictType,
            severity: input.severity,
          },
          now,
          idFn
        )
      );
    }
  })();

  for (const ev of toPublish) bus.publish(ev);

  if (wasNew) {
    return { conflict: getConflictById(db, id)!, isNew: true };
  }

  // Duplicate fingerprint while open — return existing row.
  const existing = getExistingOpenConflict(db, input.goalId, input.fingerprint)!;
  return { conflict: existing, isNew: false };
}

// ── Detector cascade ─────────────────────────────────────────────────────────

export interface DetectAndPersistInput {
  goalId: string;
  triggerEvent?: TriggerEventRef | null;
}

export interface DetectAndPersistResult {
  conflictIds: string[];
  recommendationIds: string[];
  skippedCount: number;
}

function candidateFingerprint(goalId: string, candidate: ConflictCandidate): string {
  return conflictFingerprint(
    goalId,
    candidate.conflictType,
    candidate.sources.map((item) => item.id)
  );
}

export function detectAndPersist(
  ctx: ConflictCtx,
  input: DetectAndPersistInput
): DetectAndPersistResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);
  const detector = ctx.conflictDetector ?? new DeterministicConflictDetector();

  const candidates = detector.run({
    goalId: input.goalId,
    db,
    triggerEvent: input.triggerEvent ?? null,
  });

  const toPublish: DomainEvent[] = [];
  const conflictIds: string[] = [];
  const recommendationIds: string[] = [];
  let skippedCount = 0;

  db.transaction(() => {
    for (const candidate of candidates) {
      if (candidate.sources.length === 0) {
        skippedCount += 1;
        continue;
      }

      const fingerprint = candidateFingerprint(input.goalId, candidate);
      if (!shouldInsertCandidate(db, input.goalId, fingerprint, candidate)) {
        skippedCount += 1;
        continue;
      }

      const conflictId = idFn();
      const title = capTitle(candidate.title);
      const description = capDescription(candidate.description);
      const sources = capSources(candidate.sources);

      const { isNew } = insertConflictRow(db, {
        id: conflictId,
        goalId: input.goalId,
        conflictType: candidate.conflictType,
        severity: candidate.severity,
        title,
        description,
        sourcesJson: JSON.stringify(sources),
        fingerprint,
        detectedAt: now,
      });

      if (!isNew) {
        skippedCount += 1;
        continue;
      }

      const recommendationId = idFn();
      const generationId = idFn();

      insertSucceededRecommendationGeneration(db, {
        id: generationId,
        goalId: input.goalId,
        triggerSourceId: conflictId,
        inputFingerprint: fingerprint,
        recommendationId,
        now,
      });

      insertResolveConflictRecommendation(db, {
        id: recommendationId,
        goalId: input.goalId,
        generationId,
        conflictId,
        conflictTitle: title,
        candidate,
        now,
      });

      conflictIds.push(conflictId);
      recommendationIds.push(recommendationId);

      toPublish.push(
        emitEvent(
          stmts,
          'conflict.detected',
          input.goalId,
          {
            conflictId,
            goalId: input.goalId,
            conflictType: candidate.conflictType,
            severity: candidate.severity,
          },
          now,
          idFn
        )
      );
      toPublish.push(
        emitEvent(
          stmts,
          'recommendation.generated',
          input.goalId,
          {
            generationId,
            goalId: input.goalId,
            recommendationIds: [recommendationId],
            supersededIds: [],
            count: 1,
            sparse: false,
          },
          now,
          idFn
        )
      );
    }
  })();

  for (const ev of toPublish) bus.publish(ev);

  return { conflictIds, recommendationIds, skippedCount };
}

// ── Shared lifecycle helper ───────────────────────────────────────────────────

export interface ResolveConflictResult {
  conflict: Conflict;
}

type ConflictResolution = 'resolved' | 'dismissed';

function applyConflictLifecycle(
  ctx: ConflictCtx,
  id: string,
  resolution: ConflictResolution,
  note?: string
): ResolveConflictResult {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const conflict = getConflictById(db, id);
  if (!conflict) throw new ConflictNotFoundError(id);
  if (conflict.status !== 'open') throw new InvalidConflictStatusError(conflict.status, resolution);

  const cappedNote = capResolutionNote(note);
  const eventType = resolution === 'resolved' ? 'conflict.resolved' : 'conflict.dismissed';
  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    updateConflictStatusRow(db, id, resolution, cappedNote, now);
    toPublish.push(
      emitEvent(
        stmts,
        eventType,
        conflict.goalId,
        { conflictId: id, goalId: conflict.goalId, resolution },
        now,
        idFn
      )
    );
    // Auto-dismiss linked resolve_conflict recommendation — sole automatic cascade in M7.
    toPublish.push(
      ...autoDismissResolveConflictRecommendation(db, stmts, id, conflict.goalId, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return { conflict: getConflictById(db, id)! };
}

// ── Resolve conflict ──────────────────────────────────────────────────────────

export function resolveConflict(ctx: ConflictCtx, id: string, note?: string): ResolveConflictResult {
  return applyConflictLifecycle(ctx, id, 'resolved', note);
}

// ── Dismiss conflict ──────────────────────────────────────────────────────────

export function dismissConflict(ctx: ConflictCtx, id: string, note?: string): ResolveConflictResult {
  return applyConflictLifecycle(ctx, id, 'dismissed', note);
}
