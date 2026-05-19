import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent, GoalMemoryItem } from '@orca/contracts';
import type { EventBus } from '../events.js';
import { getGoalRefinement } from '../goal-refinements.js';
import { insertMemoryItem, MemoryDuplicateError } from './projection.js';
import { computeContentHash, normalizeText, redactSecrets } from './normalize.js';

export interface RefinementSeedCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
}

export interface RefinementSeedResult {
  insertedCount: number;
  skippedCount: number;
}

let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
} | null = null;

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

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export function seedRefinementMemory(
  ctx: RefinementSeedCtx,
  goalId: string
): RefinementSeedResult {
  const refinement = getGoalRefinement(ctx.db, goalId);
  if (!refinement) {
    return { insertedCount: 0, skippedCount: 0 };
  }

  const candidates: Array<Pick<GoalMemoryItem, 'type' | 'content'>> = [
    ...refinement.constraints.map((content) => ({ type: 'constraint' as const, content })),
    ...refinement.successCriteria.map((content) => ({
      type: 'success_criterion' as const,
      content,
    })),
  ];

  if (candidates.length === 0) {
    return { insertedCount: 0, skippedCount: 0 };
  }

  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);
  const toPublish: DomainEvent[] = [];
  let insertedCount = 0;
  let skippedCount = 0;

  ctx.db.transaction(() => {
    for (const candidate of candidates) {
      const content = redactSecrets(normalizeText(candidate.content));
      const row: GoalMemoryItem = {
        id: randomUUID(),
        goalId,
        type: candidate.type,
        status: 'promoted',
        content,
        contentHash: computeContentHash({ type: candidate.type, content }),
        confidence: null,
        sourceType: 'refinement',
        sourceId: refinement.goalId,
        sourceSessionId: null,
        sourceExtractionId: null,
        sourceOffsetFirst: null,
        sourceOffsetLast: null,
        createdAt: now,
        updatedAt: now,
        promotedAt: now,
        archivedAt: null,
      };

      try {
        insertMemoryItem(ctx.db, row);
      } catch (error) {
        if (error instanceof MemoryDuplicateError) {
          skippedCount++;
          continue;
        }
        throw error;
      }

      insertedCount++;
      toPublish.push(
        emitEvent(stmts, 'memory.item.created', goalId, {
          memoryItemId: row.id,
          goalId,
          type: row.type,
          status: row.status,
          sourceType: 'refinement',
          sourceSessionId: null,
          sourceExtractionId: null,
        }, now)
      );
      toPublish.push(
        emitEvent(stmts, 'memory.item.promoted', goalId, {
          memoryItemId: row.id,
          goalId,
          type: row.type,
        }, now)
      );
    }
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return { insertedCount, skippedCount };
}
