import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { insertGoalRefinement, resetPreparedStatements as resetGoalRefinementStmts } from '../goal-refinements.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { listMemoryByGoal, resetPreparedStatements as resetMemoryProjectionStmts } from './projection.js';
import { seedRefinementMemory } from './refinement-seed.js';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-refinement-seed-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, now, now);
}

let db: Database.Database;
let bus: SpyBus;

beforeEach(() => {
  db = openTestDb();
  bus = new SpyBus();
});

afterEach(() => {
  closeDatabase();
  resetGoalRefinementStmts();
  resetMemoryProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('seedRefinementMemory', () => {
  it('seeds promoted constraint and success criterion memory from the latest refinement', () => {
    seedGoal(db, 'goal-1');
    insertGoalRefinement(db, {
      goalId: 'goal-1',
      skillId: 'guided-goal-refinement',
      constraints: ['  Use   SQLite  ', 'Keep logs local'],
      successCriteria: ['Pass all tests'],
      assumptions: ['Ignored assumption'],
      refinedAt: '2026-01-01T00:10:00.000Z',
    });

    const result = seedRefinementMemory(
      { db, bus, now: () => '2026-05-01T00:00:00.000Z' },
      'goal-1'
    );

    expect(result).toEqual({ insertedCount: 3, skippedCount: 0 });

    const items = listMemoryByGoal(db, 'goal-1', { includeArchived: true });
    expect(items).toHaveLength(3);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'constraint',
          status: 'promoted',
          content: 'Use SQLite',
          sourceType: 'refinement',
          sourceId: 'goal-1',
          sourceSessionId: null,
          sourceExtractionId: null,
          promotedAt: '2026-05-01T00:00:00.000Z',
        }),
        expect.objectContaining({
          type: 'constraint',
          status: 'promoted',
          content: 'Keep logs local',
          sourceType: 'refinement',
          sourceId: 'goal-1',
        }),
        expect.objectContaining({
          type: 'success_criterion',
          status: 'promoted',
          content: 'Pass all tests',
          sourceType: 'refinement',
          sourceId: 'goal-1',
        }),
      ])
    );

    expect(bus.captured.map((event) => event.type)).toEqual([
      'memory.item.created',
      'memory.item.promoted',
      'memory.item.created',
      'memory.item.promoted',
      'memory.item.created',
      'memory.item.promoted',
    ]);
  });

  it('is idempotent on rerun and emits no events for duplicates', () => {
    seedGoal(db, 'goal-1');
    insertGoalRefinement(db, {
      goalId: 'goal-1',
      skillId: 'guided-goal-refinement',
      constraints: ['Use SQLite'],
      successCriteria: ['Pass all tests'],
      assumptions: [],
      refinedAt: '2026-01-01T00:10:00.000Z',
    });

    const ctx = { db, bus, now: () => '2026-05-01T00:00:00.000Z' };
    expect(seedRefinementMemory(ctx, 'goal-1')).toEqual({ insertedCount: 2, skippedCount: 0 });

    bus.captured.length = 0;

    expect(seedRefinementMemory(ctx, 'goal-1')).toEqual({ insertedCount: 0, skippedCount: 2 });
    expect(listMemoryByGoal(db, 'goal-1', { includeArchived: true })).toHaveLength(2);
    expect(bus.captured).toHaveLength(0);
  });

  it('returns zero counts when the goal has no refinement', () => {
    seedGoal(db, 'goal-1');

    expect(
      seedRefinementMemory({ db, bus, now: () => '2026-05-01T00:00:00.000Z' }, 'goal-1')
    ).toEqual({ insertedCount: 0, skippedCount: 0 });
    expect(listMemoryByGoal(db, 'goal-1', { includeArchived: true })).toHaveLength(0);
    expect(bus.captured).toHaveLength(0);
  });

  it('returns zero counts when refinement constraints and success criteria are empty', () => {
    seedGoal(db, 'goal-1');
    insertGoalRefinement(db, {
      goalId: 'goal-1',
      skillId: 'guided-goal-refinement',
      constraints: [],
      successCriteria: [],
      assumptions: ['Ignored assumption'],
      refinedAt: '2026-01-01T00:10:00.000Z',
    });

    expect(
      seedRefinementMemory({ db, bus, now: () => '2026-05-01T00:00:00.000Z' }, 'goal-1')
    ).toEqual({ insertedCount: 0, skippedCount: 0 });
    expect(listMemoryByGoal(db, 'goal-1', { includeArchived: true })).toHaveLength(0);
    expect(bus.captured).toHaveLength(0);
  });
});
