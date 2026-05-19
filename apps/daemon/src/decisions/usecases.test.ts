import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import {
  createDecision,
  patchDecision,
  listDecisionsByGoal,
  DecisionNotFoundError,
  InvalidDecisionTransitionError,
  GoalArchivedError,
  GoalNotFoundError,
  resetPreparedStatements,
  type DecisionCtx,
} from './usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';

const tempDirs: string[] = [];

class SpyBus extends EventBus {
  readonly captured: DomainEvent[] = [];

  override publish(event: DomainEvent): void {
    this.captured.push(event);
    super.publish(event);
  }
}

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-decision-usecases-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string, archived = false): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, ?)`
  ).run(goalId, now, now, archived ? now : null);
}

let db: Database.Database;
let bus: SpyBus;
let ctx: DecisionCtx;

beforeEach(() => {
  db = openTestDb();
  bus = new SpyBus();
  ctx = { db, bus, now: () => '2026-05-01T00:00:00.000Z' };
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createDecision', () => {
  it('creates a proposed decision and emits decision.created', () => {
    seedGoal(db, 'goal-1');

    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite is the only internal storage boundary.',
    });

    expect(item.status).toBe('proposed');
    expect(item.title).toBe('Use SQLite');
    expect(item.sourceType).toBe('manual');
    expect(item.confirmedAt).toBeNull();
    expect(item.archivedAt).toBeNull();

    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe('decision.created');
    expect(bus.captured[0]!.payload).toMatchObject({
      decisionId: item.id,
      goalId: 'goal-1',
      status: 'proposed',
      sourceType: 'manual',
      sourceSessionId: null,
      sourceExtractionId: null,
    });
  });

  it('creates a confirmed decision and emits created + confirmed events', () => {
    seedGoal(db, 'goal-1');

    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use TypeScript',
      decisionText: 'All code must be TypeScript with strict mode.',
      status: 'confirmed',
    });

    expect(item.status).toBe('confirmed');
    expect(item.confirmedAt).toBe('2026-05-01T00:00:00.000Z');

    expect(bus.captured).toHaveLength(2);
    expect(bus.captured[0]!.type).toBe('decision.created');
    expect(bus.captured[1]!.type).toBe('decision.confirmed');
    expect(bus.captured[1]!.payload).toMatchObject({
      decisionId: item.id,
      goalId: 'goal-1',
    });
  });

  it('throws GoalNotFoundError for unknown goal', () => {
    expect(() =>
      createDecision(ctx, {
        goalId: 'nonexistent',
        title: 'Test',
        decisionText: 'Test decision',
      })
    ).toThrow(GoalNotFoundError);
    expect(bus.captured).toHaveLength(0);
  });

  it('throws GoalArchivedError for archived goal', () => {
    seedGoal(db, 'goal-1', true);

    expect(() =>
      createDecision(ctx, {
        goalId: 'goal-1',
        title: 'Test',
        decisionText: 'Test decision',
      })
    ).toThrow(GoalArchivedError);
    expect(bus.captured).toHaveLength(0);
  });

  it('stores confirmationRequired flag', () => {
    seedGoal(db, 'goal-1');

    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'High impact',
      decisionText: 'Critical architectural decision',
      confirmationRequired: true,
    });

    expect(item.confirmationRequired).toBe(true);
  });
});

describe('patchDecision', () => {
  it('patches proposed → confirmed and emits updated + confirmed events', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    bus.captured.length = 0;

    const updated = patchDecision(ctx, item.id, { status: 'confirmed' });

    expect(updated.status).toBe('confirmed');
    expect(updated.confirmedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(bus.captured).toHaveLength(2);
    expect(bus.captured[0]!.type).toBe('decision.updated');
    expect(bus.captured[1]!.type).toBe('decision.confirmed');
  });

  it('patches proposed → archived and emits updated + archived events', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    bus.captured.length = 0;

    const updated = patchDecision(ctx, item.id, { status: 'archived' });

    expect(updated.status).toBe('archived');
    expect(updated.archivedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(bus.captured.map((e) => e.type)).toEqual(['decision.updated', 'decision.archived']);
  });

  it('patches confirmed → archived and emits updated + archived events', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    patchDecision(ctx, item.id, { status: 'confirmed' });
    bus.captured.length = 0;

    const updated = patchDecision(ctx, item.id, { status: 'archived' });
    expect(updated.status).toBe('archived');
    expect(bus.captured.map((e) => e.type)).toEqual(['decision.updated', 'decision.archived']);
  });

  it('rejects archived → proposed with InvalidDecisionTransitionError', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    patchDecision(ctx, item.id, { status: 'archived' });
    bus.captured.length = 0;

    expect(() => patchDecision(ctx, item.id, { status: 'proposed' })).toThrow(
      InvalidDecisionTransitionError
    );
    expect(bus.captured).toHaveLength(0);
  });

  it('rejects confirmed → proposed with InvalidDecisionTransitionError', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    patchDecision(ctx, item.id, { status: 'confirmed' });

    expect(() => patchDecision(ctx, item.id, { status: 'proposed' })).toThrow(
      InvalidDecisionTransitionError
    );
  });

  it('patches title and decisionText without changing status', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Old title',
      decisionText: 'Old text',
    });
    bus.captured.length = 0;

    const updated = patchDecision(ctx, item.id, {
      title: 'New title',
      decisionText: 'New decision text',
    });

    expect(updated.title).toBe('New title');
    expect(updated.decisionText).toBe('New decision text');
    expect(updated.status).toBe('proposed');
    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe('decision.updated');
  });

  it('throws DecisionNotFoundError for unknown id', () => {
    expect(() => patchDecision(ctx, 'nonexistent', { status: 'confirmed' })).toThrow(
      DecisionNotFoundError
    );
  });

  it('list includes archived decisions', () => {
    seedGoal(db, 'goal-1');
    const item = createDecision(ctx, {
      goalId: 'goal-1',
      title: 'Use SQLite',
      decisionText: 'SQLite only',
    });
    patchDecision(ctx, item.id, { status: 'archived' });

    const decisions = listDecisionsByGoal(db, 'goal-1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('archived');
  });
});
