import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DomainEvent, GoalDecision } from '@orca/contracts';
import { GoalArchivedError, GoalNotFoundError } from '../sessions/errors.js';
import type { EventBus } from '../events.js';
import {
  getDecisionById,
  insertDecision,
  listDecisionsByGoal,
  updateDecision,
} from './projection.js';

export { GoalNotFoundError, GoalArchivedError, listDecisionsByGoal };

export interface DecisionCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
}

export class DecisionNotFoundError extends Error {
  readonly code = 'decision_not_found' as const;
  constructor(id: string) {
    super(`Decision not found: ${id}`);
    this.name = 'DecisionNotFoundError';
  }
}

export class InvalidDecisionTransitionError extends Error {
  readonly code = 'invalid_status_transition' as const;
  constructor(from: string, to: string) {
    super(`Invalid decision status transition: ${from} -> ${to}`);
    this.name = 'InvalidDecisionTransitionError';
  }
}

const TITLE_MAX = 200;
const TEXT_MAX = 4000;

function capText(text: string, max: number): string {
  return text.trim().slice(0, max);
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

export type CreateDecisionInput = {
  goalId: string;
  title: string;
  decisionText: string;
  rationale?: string;
  status?: 'proposed' | 'confirmed';
  confidence?: number;
  confirmationRequired?: boolean;
};

export function createDecision(ctx: DecisionCtx, input: CreateDecisionInput): GoalDecision {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const goalRow = stmts.selectGoal.get(input.goalId) as GoalRow | undefined;
  if (!goalRow) throw new GoalNotFoundError(input.goalId);
  if (goalRow.archived_at !== null) throw new GoalArchivedError(input.goalId);

  const status = input.status ?? 'proposed';
  const confirmationRequired = input.confirmationRequired ?? false;
  const id = randomUUID();
  const confirmedAt = status === 'confirmed' ? now : null;

  const row: GoalDecision = {
    id,
    goalId: input.goalId,
    title: capText(input.title, TITLE_MAX),
    decisionText: capText(input.decisionText, TEXT_MAX),
    rationale: input.rationale !== undefined ? capText(input.rationale, TEXT_MAX) : null,
    status,
    confirmationRequired,
    confidence: input.confidence ?? null,
    sourceType: 'manual',
    sourceId: null,
    sourceSessionId: null,
    sourceExtractionId: null,
    sourceOffsetFirst: null,
    sourceOffsetLast: null,
    createdAt: now,
    updatedAt: now,
    confirmedAt,
    archivedAt: null,
  };

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    insertDecision(ctx.db, row);

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
      emitEvent('decision.created', {
        decisionId: id,
        goalId: input.goalId,
        status,
        confirmationRequired,
        sourceType: 'manual',
        sourceSessionId: null,
        sourceExtractionId: null,
      })
    );

    if (status === 'confirmed') {
      toPublish.push(
        emitEvent('decision.confirmed', {
          decisionId: id,
          goalId: input.goalId,
        })
      );
    }
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return row;
}

export type PatchDecisionInput = {
  title?: string;
  decisionText?: string;
  rationale?: string;
  status?: GoalDecision['status'];
};

export function patchDecision(ctx: DecisionCtx, id: string, patch: PatchDecisionInput): GoalDecision {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensureStmts(ctx.db);

  const current = getDecisionById(ctx.db, id);
  if (!current) throw new DecisionNotFoundError(id);

  const newStatus = patch.status ?? current.status;

  if (patch.status !== undefined && patch.status !== current.status) {
    const valid =
      (current.status === 'proposed' && patch.status === 'confirmed') ||
      (current.status === 'proposed' && patch.status === 'archived') ||
      (current.status === 'confirmed' && patch.status === 'archived');
    if (!valid) {
      throw new InvalidDecisionTransitionError(current.status, patch.status);
    }
  }

  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    const projPatch: Parameters<typeof updateDecision>[2] = { updatedAt: now };
    if (patch.title !== undefined) projPatch.title = capText(patch.title, TITLE_MAX);
    if (patch.decisionText !== undefined) projPatch.decisionText = capText(patch.decisionText, TEXT_MAX);
    if (patch.rationale !== undefined) projPatch.rationale = capText(patch.rationale, TEXT_MAX);
    if (patch.status !== undefined) projPatch.status = patch.status;
    if (newStatus === 'confirmed' && current.confirmedAt === null) {
      projPatch.confirmedAt = now;
    }
    if (newStatus === 'archived' && current.archivedAt === null) {
      projPatch.archivedAt = now;
    }

    updateDecision(ctx.db, id, projPatch);

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
      emitEvent('decision.updated', {
        decisionId: id,
        goalId: current.goalId,
        status: newStatus,
      })
    );

    if (newStatus === 'confirmed' && current.status !== 'confirmed') {
      toPublish.push(
        emitEvent('decision.confirmed', {
          decisionId: id,
          goalId: current.goalId,
        })
      );
    }

    if (newStatus === 'archived' && current.status !== 'archived') {
      toPublish.push(
        emitEvent('decision.archived', {
          decisionId: id,
          goalId: current.goalId,
        })
      );
    }
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  return getDecisionById(ctx.db, id)!;
}
