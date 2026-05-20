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
  createMemoryItem,
  patchMemoryItem,
  listMemoryByGoal,
  MemoryDuplicateError,
  MemoryNotFoundError,
  InvalidMemoryTransitionError,
  GoalArchivedError,
  GoalNotFoundError,
  resetPreparedStatements,
  type MemoryCtx,
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
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-memory-usecases-'));
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
let ctx: MemoryCtx;

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

describe('createMemoryItem', () => {
  it('creates a candidate memory item and emits memory.item.created', () => {
    seedGoal(db, 'goal-1');

    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Some note content',
    });

    expect(item.status).toBe('candidate');
    expect(item.type).toBe('note');
    expect(item.content).toBe('Some note content');
    expect(item.sourceType).toBe('manual');
    expect(item.promotedAt).toBeNull();
    expect(item.archivedAt).toBeNull();

    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe('memory.item.created');
    expect(bus.captured[0]!.payload).toMatchObject({
      memoryItemId: item.id,
      goalId: 'goal-1',
      type: 'note',
      status: 'candidate',
      sourceType: 'manual',
      sourceSessionId: null,
      sourceExtractionId: null,
    });
  });

  it('creates a promoted memory item and emits created + promoted events', () => {
    seedGoal(db, 'goal-1');

    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'constraint',
      content: 'Must use SQLite',
      status: 'promoted',
    });

    expect(item.status).toBe('promoted');
    expect(item.promotedAt).toBe('2026-05-01T00:00:00.000Z');

    expect(bus.captured).toHaveLength(2);
    expect(bus.captured[0]!.type).toBe('memory.item.created');
    expect(bus.captured[1]!.type).toBe('memory.item.promoted');
    expect(bus.captured[1]!.payload).toMatchObject({
      memoryItemId: item.id,
      goalId: 'goal-1',
      type: 'constraint',
    });
  });

  it('normalizes whitespace in content before storing', () => {
    seedGoal(db, 'goal-1');

    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: '  hello   world  ',
    });

    expect(item.content).toBe('hello world');
  });

  it('redacts password= patterns in content', () => {
    seedGoal(db, 'goal-1');

    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Set password=secret123 for the DB',
    });

    expect(item.content).not.toContain('secret123');
    expect(item.content).toContain('password=[redacted]');
  });

  it('throws GoalNotFoundError for unknown goal', () => {
    expect(() =>
      createMemoryItem(ctx, { goalId: 'nonexistent', type: 'note', content: 'Test' })
    ).toThrow(GoalNotFoundError);
    expect(bus.captured).toHaveLength(0);
  });

  it('throws GoalArchivedError for archived goal', () => {
    seedGoal(db, 'goal-1', true);

    expect(() =>
      createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Test' })
    ).toThrow(GoalArchivedError);
    expect(bus.captured).toHaveLength(0);
  });

  it('throws MemoryDuplicateError and emits no events for duplicate (goal_id, type, content_hash)', () => {
    seedGoal(db, 'goal-1');

    createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Same content' });
    bus.captured.length = 0; // reset spy

    expect(() =>
      createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Same content' })
    ).toThrow(MemoryDuplicateError);
    expect(bus.captured).toHaveLength(0);
  });

  it('allows same content under a different type', () => {
    seedGoal(db, 'goal-1');

    createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Content' });
    expect(() =>
      createMemoryItem(ctx, { goalId: 'goal-1', type: 'constraint', content: 'Content' })
    ).not.toThrow();
  });

  it('broadcasts events only after transaction commits (failed insert leaves no events)', () => {
    seedGoal(db, 'goal-1');

    createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'First' });
    bus.captured.length = 0;

    // Second insert with same content should fail in the tx; no events should appear
    expect(() =>
      createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'First' })
    ).toThrow();

    expect(bus.captured).toHaveLength(0);
    // DB should still only have one row
    const items = listMemoryByGoal(db, 'goal-1', { includeArchived: true });
    expect(items).toHaveLength(1);
  });
});

describe('patchMemoryItem', () => {
  it('patches candidate → promoted and emits updated + promoted events', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Note',
    });
    bus.captured.length = 0;

    const updated = patchMemoryItem(ctx, item.id, { status: 'promoted' });

    expect(updated.status).toBe('promoted');
    expect(updated.promotedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(bus.captured).toHaveLength(2);
    expect(bus.captured[0]!.type).toBe('memory.item.updated');
    expect(bus.captured[1]!.type).toBe('memory.item.promoted');
  });

  it('patches candidate → archived and emits archived event only', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Note',
    });
    bus.captured.length = 0;

    const updated = patchMemoryItem(ctx, item.id, { status: 'archived' });

    expect(updated.status).toBe('archived');
    expect(updated.archivedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(bus.captured.map((e) => e.type)).toEqual(['memory.item.archived']);
  });

  it('patches promoted → archived and emits archived event only', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Note',
      status: 'promoted',
    });
    bus.captured.length = 0;

    const updated = patchMemoryItem(ctx, item.id, { status: 'archived' });
    expect(updated.status).toBe('archived');
    expect(bus.captured.map((e) => e.type)).toEqual(['memory.item.archived']);
  });

  it('rejects archived → promoted with InvalidMemoryTransitionError', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Note',
    });
    patchMemoryItem(ctx, item.id, { status: 'archived' });
    bus.captured.length = 0;

    expect(() => patchMemoryItem(ctx, item.id, { status: 'promoted' })).toThrow(
      InvalidMemoryTransitionError
    );
    expect(bus.captured).toHaveLength(0);
  });

  it('rejects archived → candidate with InvalidMemoryTransitionError', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Note' });
    patchMemoryItem(ctx, item.id, { status: 'archived' });

    expect(() => patchMemoryItem(ctx, item.id, { status: 'candidate' })).toThrow(
      InvalidMemoryTransitionError
    );
  });

  it('patches content and recomputes content_hash', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, {
      goalId: 'goal-1',
      type: 'note',
      content: 'Original',
    });
    const originalHash = item.contentHash;

    const updated = patchMemoryItem(ctx, item.id, { content: 'Updated content' });
    expect(updated.content).toBe('Updated content');
    expect(updated.contentHash).not.toBe(originalHash);
  });

  it('throws MemoryNotFoundError for unknown id', () => {
    expect(() => patchMemoryItem(ctx, 'nonexistent', { status: 'promoted' })).toThrow(
      MemoryNotFoundError
    );
  });

  it('does not emit extra events when status is unchanged', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Note' });
    bus.captured.length = 0;

    const updated = patchMemoryItem(ctx, item.id, { content: 'Updated note' });
    expect(updated.status).toBe('candidate');
    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe('memory.item.updated');
  });

  it('list excludes archived items by default after archiving', () => {
    seedGoal(db, 'goal-1');
    const item = createMemoryItem(ctx, { goalId: 'goal-1', type: 'note', content: 'Note' });
    patchMemoryItem(ctx, item.id, { status: 'archived' });

    const items = listMemoryByGoal(db, 'goal-1', { includeArchived: false });
    expect(items).toHaveLength(0);

    const all = listMemoryByGoal(db, 'goal-1', { includeArchived: true });
    expect(all).toHaveLength(1);
  });
});
