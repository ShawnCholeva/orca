import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent, MemoryExtraction, MemoryExtractionTrigger } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { getSessionDetail } from '../sessions/projection.js';
import {
  getExtractionById,
  getLatestExtractionForSession,
  insertExtraction,
  updateExtractionStatus,
} from './projection.js';
import { computeSourceFingerprint } from './fingerprint.js';

export { getLatestExtractionForSession };

export interface ExtractionCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
}

export interface ReadOnlySessionOutputStore {
  readTail(sessionId: string): {
    firstByteOffset: number;
    totalBytesKept: number;
  };
}

export class SessionNotFoundForExtractionError extends Error {
  readonly code = 'session_not_found' as const;
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundForExtractionError';
  }
}

export class SessionNotTerminalError extends Error {
  readonly code = 'session_not_terminal' as const;
  constructor(sessionId: string, status: string) {
    super(`Session ${sessionId} is not in a terminal state (status: ${status})`);
    this.name = 'SessionNotTerminalError';
  }
}

export class SessionArchivedForExtractionError extends Error {
  readonly code = 'session_archived' as const;
  constructor(sessionId: string) {
    super(`Session ${sessionId} is archived`);
    this.name = 'SessionArchivedForExtractionError';
  }
}

export class GoalArchivedForExtractionError extends Error {
  readonly code = 'goal_archived' as const;
  constructor(goalId: string) {
    super(`Goal ${goalId} is archived`);
    this.name = 'GoalArchivedForExtractionError';
  }
}

export class ExtractionNotFoundError extends Error {
  readonly code = 'extraction_not_found' as const;
  constructor(id: string) {
    super(`Extraction not found: ${id}`);
    this.name = 'ExtractionNotFoundError';
  }
}

export class InvalidExtractionTransitionError extends Error {
  readonly code = 'invalid_status_transition' as const;
  constructor(from: string, to: string) {
    super(`Invalid extraction status transition: ${from} -> ${to}`);
    this.name = 'InvalidExtractionTransitionError';
  }
}

const TERMINAL_STATUSES = new Set(['exited', 'failed', 'stopped']);

export interface EnqueueExtractionInput {
  goalId: string;
  sessionId: string;
  trigger: MemoryExtractionTrigger;
  sourceOffsetFirst: number;
  sourceOffsetLast: number;
  extractorVersion: string;
}

interface ActiveFingerprintRow {
  id: string;
}

interface GoalRow {
  archived_at: string | null;
}

export interface ManualExtractEnqueueCtx extends ExtractionCtx {
  outputStore: ReadOnlySessionOutputStore;
  extractorVersion: string;
}

export interface ManualExtractEnqueueResult {
  extraction: MemoryExtraction;
  created: boolean;
}

let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  findActiveByFingerprint: Database.Statement;
  selectGoal: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
      findActiveByFingerprint: db.prepare(
        `SELECT id FROM memory_extractions
         WHERE session_id = ? AND source_fingerprint = ? AND status IN ('pending', 'running', 'succeeded')
         LIMIT 1`
      ),
      selectGoal: db.prepare('SELECT archived_at FROM goals WHERE id = ?'),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function emitEvent(
  stmts: NonNullable<typeof _stmts>,
  db: Database.Database,
  type: DomainEvent['type'],
  goalId: string,
  payload: Record<string, unknown>,
  now: string
): DomainEvent {
  const eventId = randomUUID();
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

export function enqueueExtraction(
  ctx: ExtractionCtx,
  input: EnqueueExtractionInput
): MemoryExtraction {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const session = getSessionDetail(ctx.db, input.sessionId);
  if (!session) throw new SessionNotFoundForExtractionError(input.sessionId);
  if (!TERMINAL_STATUSES.has(session.status)) {
    throw new SessionNotTerminalError(input.sessionId, session.status);
  }
  if (session.archivedAt !== null) {
    throw new SessionArchivedForExtractionError(input.sessionId);
  }
  const goalRow = stmts.selectGoal.get(input.goalId) as GoalRow | undefined;
  if (goalRow && goalRow.archived_at !== null) {
    throw new GoalArchivedForExtractionError(input.goalId);
  }

  const fingerprint = computeSourceFingerprint({
    sessionId: input.sessionId,
    sourceOffsetFirst: input.sourceOffsetFirst,
    sourceOffsetLast: input.sourceOffsetLast,
    extractorVersion: input.extractorVersion,
  });

  const existing = stmts.findActiveByFingerprint.get(
    input.sessionId,
    fingerprint
  ) as ActiveFingerprintRow | undefined;

  if (existing) {
    return getExtractionById(ctx.db, existing.id)!;
  }

  const id = randomUUID();
  const row: MemoryExtraction = {
    id,
    goalId: input.goalId,
    sessionId: input.sessionId,
    trigger: input.trigger,
    status: 'pending',
    extractorVersion: input.extractorVersion,
    sourceFingerprint: fingerprint,
    sourceOffsetFirst: input.sourceOffsetFirst,
    sourceOffsetLast: input.sourceOffsetLast,
    summaryId: null,
    itemCount: 0,
    decisionCount: 0,
    promotedCount: 0,
    failureCode: null,
    failureMessage: null,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
  };

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    insertExtraction(ctx.db, row);
    toPublish.push(
      emitEvent(stmts, ctx.db, 'memory.extraction.requested', input.goalId, {
        extractionId: id,
        goalId: input.goalId,
        sessionId: input.sessionId,
        trigger: input.trigger,
      }, now)
    );
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return row;
}

export function manualExtractEnqueue(
  ctx: ManualExtractEnqueueCtx,
  sessionId: string
): ManualExtractEnqueueResult {
  const session = getSessionDetail(ctx.db, sessionId);
  if (!session) {
    throw new SessionNotFoundForExtractionError(sessionId);
  }
  if (!TERMINAL_STATUSES.has(session.status)) {
    throw new SessionNotTerminalError(sessionId, session.status);
  }
  if (session.archivedAt !== null) {
    throw new SessionArchivedForExtractionError(sessionId);
  }

  const snapshot = ctx.outputStore.readTail(sessionId);
  const sourceOffsetFirst = snapshot.firstByteOffset;
  const sourceOffsetLast = snapshot.firstByteOffset + snapshot.totalBytesKept;
  const fingerprint = computeSourceFingerprint({
    sessionId,
    sourceOffsetFirst,
    sourceOffsetLast,
    extractorVersion: ctx.extractorVersion,
  });

  const existing = ensureStmts(ctx.db).findActiveByFingerprint.get(
    sessionId,
    fingerprint
  ) as ActiveFingerprintRow | undefined;

  if (existing) {
    return {
      extraction: getExtractionById(ctx.db, existing.id)!,
      created: false,
    };
  }

  return {
    extraction: enqueueExtraction(ctx, {
      goalId: session.goalId,
      sessionId,
      trigger: 'manual',
      sourceOffsetFirst,
      sourceOffsetLast,
      extractorVersion: ctx.extractorVersion,
    }),
    created: true,
  };
}

export function markExtractionStarted(ctx: ExtractionCtx, id: string): MemoryExtraction {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const extraction = getExtractionById(ctx.db, id);
  if (!extraction) throw new ExtractionNotFoundError(id);
  if (extraction.status !== 'pending') {
    throw new InvalidExtractionTransitionError(extraction.status, 'running');
  }

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    updateExtractionStatus(ctx.db, id, { status: 'running', startedAt: now });
    toPublish.push(
      emitEvent(stmts, ctx.db, 'memory.extraction.started', extraction.goalId, {
        extractionId: id,
        goalId: extraction.goalId,
        sessionId: extraction.sessionId,
      }, now)
    );
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return { ...extraction, status: 'running', startedAt: now };
}

export interface MarkFailedInput {
  failureCode: MemoryExtraction['failureCode'];
  failureMessage?: string | null;
}

export function markExtractionFailed(
  ctx: ExtractionCtx,
  id: string,
  input: MarkFailedInput
): MemoryExtraction {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const extraction = getExtractionById(ctx.db, id);
  if (!extraction) throw new ExtractionNotFoundError(id);
  if (extraction.status !== 'pending' && extraction.status !== 'running') {
    throw new InvalidExtractionTransitionError(extraction.status, 'failed');
  }

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    updateExtractionStatus(ctx.db, id, {
      status: 'failed',
      failureCode: input.failureCode,
      failureMessage: input.failureMessage ?? null,
      finishedAt: now,
    });
    toPublish.push(
      emitEvent(stmts, ctx.db, 'memory.extraction.failed', extraction.goalId, {
        extractionId: id,
        goalId: extraction.goalId,
        sessionId: extraction.sessionId,
        failureCode: input.failureCode,
      }, now)
    );
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return {
    ...extraction,
    status: 'failed',
    failureCode: input.failureCode,
    failureMessage: input.failureMessage ?? null,
    finishedAt: now,
  };
}
