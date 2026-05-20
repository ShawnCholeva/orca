import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DomainEvent,
  GoalDecision,
  GoalMemoryItem,
  SessionExtractionOutput,
  SessionMemorySummary,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import { insertSummary, getExtractionById, updateExtractionStatus } from './projection.js';
import { MemoryDuplicateError, insertMemoryItem } from '../memory/projection.js';
import { insertDecision } from '../decisions/projection.js';
import { normalizeText, redactSecrets, computeContentHash } from '../memory/normalize.js';
import { shouldAutoPromote, type ExtractionContext } from '../memory/promotion-rules.js';
import { markExtractionFailed } from './usecases.js';
export type { MarkFailedInput } from './usecases.js';

export interface CommitCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
}

export interface CommitSourceMeta {
  sourceOffsetFirst: number;
  sourceOffsetLast: number;
}

export class ExtractionNotRunningError extends Error {
  readonly code = 'extraction_not_running' as const;
  constructor(id: string, status: string) {
    super(`Extraction ${id} is not in running state (status: ${status})`);
    this.name = 'ExtractionNotRunningError';
  }
}

export class ExtractionNotFoundForCommitError extends Error {
  readonly code = 'extraction_not_found' as const;
  constructor(id: string) {
    super(`Extraction not found: ${id}`);
    this.name = 'ExtractionNotFoundForCommitError';
  }
}

export interface CommitExtractionResultStats {
  insertedMemoryCount: number;
  duplicateMemoryCount: number;
  insertedDecisionCount: number;
  promotedCount: number;
}

interface SessionExitRow {
  exit_code: number | null;
}

let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  getSessionExitCode: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
      getSessionExitCode: db.prepare('SELECT exit_code FROM sessions WHERE id = ?'),
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

export function commitExtractionResult(
  ctx: CommitCtx,
  extractionId: string,
  output: SessionExtractionOutput,
  sourceMeta: CommitSourceMeta
): CommitExtractionResultStats {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const toPublish: DomainEvent[] = [];
  const stats: CommitExtractionResultStats = {
    insertedMemoryCount: 0,
    duplicateMemoryCount: 0,
    insertedDecisionCount: 0,
    promotedCount: 0,
  };

  ctx.db.transaction(() => {
    const extraction = getExtractionById(ctx.db, extractionId);
    if (!extraction) {
      throw new ExtractionNotFoundForCommitError(extractionId);
    }
    if (extraction.status !== 'running') {
      throw new ExtractionNotRunningError(extractionId, extraction.status);
    }

    const { goalId, sessionId } = extraction;

    const sessionRow = stmts.getSessionExitCode.get(sessionId) as SessionExitRow | undefined;
    const exitCode = sessionRow?.exit_code ?? null;

    const extractionCtx: ExtractionContext = {
      sourceType: 'session',
      derivedFromExitCode: exitCode !== null && exitCode !== 0,
      derivedFromCleanCompletion: exitCode === 0,
    };

    let summaryId: string | null = null;
    if (output.summary) {
      summaryId = randomUUID();
      const summaryRow: SessionMemorySummary = {
        id: summaryId,
        sessionId,
        goalId,
        extractionId,
        headline: redactSecrets(normalizeText(output.summary.headline, 200)),
        summaryText: redactSecrets(normalizeText(output.summary.text)),
        truncated: output.summary.truncated,
        sourceOffsetFirst: sourceMeta.sourceOffsetFirst,
        sourceOffsetLast: sourceMeta.sourceOffsetLast,
        createdAt: now,
      };
      insertSummary(ctx.db, summaryRow);
    }

    for (const candidate of output.memoryCandidates) {
      const normalized = redactSecrets(normalizeText(candidate.content));
      const contentHash = computeContentHash({ type: candidate.type, content: normalized });

      const autoPromote = shouldAutoPromote(candidate, extractionCtx);
      const status = autoPromote ? 'promoted' : 'candidate';
      const promotedAt = autoPromote ? now : null;

      const memId = randomUUID();
      const memRow: GoalMemoryItem = {
        id: memId,
        goalId,
        type: candidate.type,
        status,
        content: normalized,
        contentHash,
        confidence: candidate.confidence ?? null,
        sourceType: 'session',
        sourceId: null,
        sourceSessionId: sessionId,
        sourceExtractionId: extractionId,
        sourceOffsetFirst: candidate.sourceOffsetFirst ?? null,
        sourceOffsetLast: candidate.sourceOffsetLast ?? null,
        createdAt: now,
        updatedAt: now,
        promotedAt,
        archivedAt: null,
      };

      try {
        insertMemoryItem(ctx.db, memRow);
      } catch (err) {
        if (err instanceof MemoryDuplicateError) {
          stats.duplicateMemoryCount++;
          continue;
        }
        throw err;
      }

      stats.insertedMemoryCount++;

      toPublish.push(
        emitEvent(stmts, 'memory.item.created', goalId, {
          memoryItemId: memId,
          goalId,
          type: candidate.type,
          status,
          sourceType: 'session',
          sourceSessionId: sessionId,
          sourceExtractionId: extractionId,
        }, now)
      );

      if (autoPromote) {
        stats.promotedCount++;
        toPublish.push(
          emitEvent(stmts, 'memory.item.promoted', goalId, {
            memoryItemId: memId,
            goalId,
            type: candidate.type,
          }, now)
        );
      }
    }

    for (const candidate of output.decisionCandidates) {
      const decId = randomUUID();
      const decRow: GoalDecision = {
        id: decId,
        goalId,
        title: redactSecrets(normalizeText(candidate.title, 200)),
        decisionText: redactSecrets(normalizeText(candidate.decisionText)),
        rationale: candidate.rationale !== undefined
          ? redactSecrets(normalizeText(candidate.rationale))
          : null,
        status: 'proposed',
        confirmationRequired: candidate.confirmationRequired,
        confidence: candidate.confidence ?? null,
        sourceType: 'session',
        sourceId: null,
        sourceSessionId: sessionId,
        sourceExtractionId: extractionId,
        sourceOffsetFirst: candidate.sourceOffsetFirst ?? null,
        sourceOffsetLast: candidate.sourceOffsetLast ?? null,
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
        archivedAt: null,
      };

      insertDecision(ctx.db, decRow);
      stats.insertedDecisionCount++;

      toPublish.push(
        emitEvent(stmts, 'decision.created', goalId, {
          decisionId: decId,
          goalId,
          status: 'proposed',
          confirmationRequired: candidate.confirmationRequired,
          sourceType: 'session',
          sourceSessionId: sessionId,
          sourceExtractionId: extractionId,
        }, now)
      );
    }

    updateExtractionStatus(ctx.db, extractionId, {
      status: 'succeeded',
      summaryId,
      itemCount: output.memoryCandidates.length,
      decisionCount: stats.insertedDecisionCount,
      promotedCount: stats.promotedCount,
      sourceOffsetFirst: sourceMeta.sourceOffsetFirst,
      sourceOffsetLast: sourceMeta.sourceOffsetLast,
      finishedAt: now,
    });

    toPublish.push(
      emitEvent(stmts, 'memory.extraction.completed', goalId, {
        extractionId,
        goalId,
        sessionId,
        summaryId,
        itemCount: output.memoryCandidates.length,
        decisionCount: stats.insertedDecisionCount,
        promotedCount: stats.promotedCount,
        truncated: output.summary?.truncated ?? false,
      }, now)
    );
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return stats;
}

export const commitExtractionFailure = markExtractionFailed;
