import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent, GoalMemoryItem } from '@orca/contracts';
import { GoalArchivedError, GoalNotFoundError } from '../sessions/errors.js';
import type { EventBus } from '../events.js';
import {
  MemoryDuplicateError,
  getMemoryById,
  insertMemoryItem,
  isSqliteUniqueConstraintError,
  listMemoryByGoal,
  updateMemoryItem,
  type ListMemoryOptions,
} from './projection.js';
import { normalizeText, redactSecrets, computeContentHash } from './normalize.js';

export { GoalNotFoundError, GoalArchivedError, MemoryDuplicateError, listMemoryByGoal };
export type { ListMemoryOptions };

export interface MemoryCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
}

export class MemoryNotFoundError extends Error {
  readonly code = 'memory_not_found' as const;
  constructor(id: string) {
    super(`Memory item not found: ${id}`);
    this.name = 'MemoryNotFoundError';
  }
}

export class InvalidMemoryTransitionError extends Error {
  readonly code = 'invalid_status_transition' as const;
  constructor(from: string, to: string) {
    super(`Invalid memory status transition: ${from} -> ${to}`);
    this.name = 'InvalidMemoryTransitionError';
  }
}

interface GoalRow {
  id: string;
  archived_at: string | null;
}

let _db: Database.Database | null = null;
let _stmts: {
  selectGoal: Database.Statement;
  insertEvent: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectGoal: db.prepare('SELECT id, archived_at FROM goals WHERE id = ?'),
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
}

export type CreateMemoryInput = {
  goalId: string;
  type: GoalMemoryItem['type'];
  content: string;
  status?: 'candidate' | 'promoted';
  confidence?: number;
};

export function createMemoryItem(ctx: MemoryCtx, input: CreateMemoryInput): GoalMemoryItem {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const goalRow = stmts.selectGoal.get(input.goalId) as GoalRow | undefined;
  if (!goalRow) throw new GoalNotFoundError(input.goalId);
  if (goalRow.archived_at !== null) throw new GoalArchivedError(input.goalId);

  const normalized = redactSecrets(normalizeText(input.content));
  const contentHash = computeContentHash({ type: input.type, content: normalized });
  const id = randomUUID();
  const status = input.status ?? 'candidate';
  const promotedAt = status === 'promoted' ? now : null;

  const row: GoalMemoryItem = {
    id,
    goalId: input.goalId,
    type: input.type,
    status,
    content: normalized,
    contentHash,
    confidence: input.confidence ?? null,
    sourceType: 'manual',
    sourceId: null,
    sourceSessionId: null,
    sourceExtractionId: null,
    sourceOffsetFirst: null,
    sourceOffsetLast: null,
    createdAt: now,
    updatedAt: now,
    promotedAt,
    archivedAt: null,
  };

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    insertMemoryItem(ctx.db, row);

    const emitEvent = (
      type: DomainEvent['type'],
      payload: Record<string, unknown>
    ): DomainEvent => {
      const eventId = randomUUID();
      const result = stmts.insertEvent.run(
        eventId,
        type,
        input.goalId,
        JSON.stringify(payload),
        now
      );
      return {
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type,
        goalId: input.goalId,
        payload,
        createdAt: now,
      };
    };

    toPublish.push(
      emitEvent('memory.item.created', {
        memoryItemId: id,
        goalId: input.goalId,
        type: input.type,
        status,
        sourceType: 'manual',
        sourceSessionId: null,
        sourceExtractionId: null,
      })
    );

    if (status === 'promoted') {
      toPublish.push(
        emitEvent('memory.item.promoted', {
          memoryItemId: id,
          goalId: input.goalId,
          type: input.type,
        })
      );
    }
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return row;
}

export type PatchMemoryInput = {
  type?: GoalMemoryItem['type'];
  content?: string;
  status?: GoalMemoryItem['status'];
};

export function patchMemoryItem(ctx: MemoryCtx, id: string, patch: PatchMemoryInput): GoalMemoryItem {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const current = getMemoryById(ctx.db, id);
  if (!current) throw new MemoryNotFoundError(id);

  const newStatus = patch.status ?? current.status;

  if (patch.status !== undefined && patch.status !== current.status) {
    const valid =
      (current.status === 'candidate' && patch.status === 'promoted') ||
      (current.status === 'candidate' && patch.status === 'archived') ||
      (current.status === 'promoted' && patch.status === 'archived');
    if (!valid) {
      throw new InvalidMemoryTransitionError(current.status, patch.status);
    }
  }

  let newContent: string | undefined;
  let newContentHash: string | undefined;

  if (patch.content !== undefined || patch.type !== undefined) {
    const raw = patch.content ?? current.content;
    const normalized = redactSecrets(normalizeText(raw));
    const resolvedType = patch.type ?? current.type;
    newContent = normalized;
    newContentHash = computeContentHash({ type: resolvedType, content: normalized });
  }

  const toPublish: DomainEvent[] = [];

  try {
    ctx.db.transaction(() => {
      const projPatch: Parameters<typeof updateMemoryItem>[2] = { updatedAt: now };
      if (patch.type !== undefined) projPatch.type = patch.type;
      if (newContent !== undefined) projPatch.content = newContent;
      if (newContentHash !== undefined) projPatch.contentHash = newContentHash;
      if (patch.status !== undefined) projPatch.status = patch.status;
      if (newStatus === 'promoted' && current.promotedAt === null) {
        projPatch.promotedAt = now;
      }
      if (newStatus === 'archived' && current.archivedAt === null) {
        projPatch.archivedAt = now;
      }

      updateMemoryItem(ctx.db, id, projPatch);

      const emitEvent = (
        type: DomainEvent['type'],
        payload: Record<string, unknown>
      ): DomainEvent => {
        const eventId = randomUUID();
        const result = stmts.insertEvent.run(
          eventId,
          type,
          current.goalId,
          JSON.stringify(payload),
          now
        );
        return {
          seq: Number(result.lastInsertRowid),
          id: eventId,
          type,
          goalId: current.goalId,
          payload,
          createdAt: now,
        };
      };

      toPublish.push(
        emitEvent('memory.item.updated', {
          memoryItemId: id,
          goalId: current.goalId,
          type: patch.type ?? current.type,
          status: newStatus,
        })
      );

      if (newStatus === 'promoted' && current.status !== 'promoted') {
        toPublish.push(
          emitEvent('memory.item.promoted', {
            memoryItemId: id,
            goalId: current.goalId,
            type: patch.type ?? current.type,
          })
        );
      }

      if (newStatus === 'archived' && current.status !== 'archived') {
        toPublish.push(
          emitEvent('memory.item.archived', {
            memoryItemId: id,
            goalId: current.goalId,
          })
        );
      }
    })();
  } catch (err) {
    if (isSqliteUniqueConstraintError(err)) {
      throw new MemoryDuplicateError(
        current.goalId,
        patch.type ?? current.type,
        newContentHash ?? current.contentHash
      );
    }
    throw err;
  }

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return getMemoryById(ctx.db, id)!;
}
