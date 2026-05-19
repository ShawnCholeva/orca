import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import type { GoalMemoryItem } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  getMemoryById,
  insertMemoryItem,
  listMemoryByGoal,
  MemoryDuplicateError,
  resetPreparedStatements,
  updateMemoryItem,
} from './projection.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(dataDir?: string): Database.Database {
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'orca-memory-projection-'));
  if (!dataDir) {
    tempDirs.push(dir);
  }
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
}

function memoryRow(overrides: Partial<GoalMemoryItem> = {}): GoalMemoryItem {
  return {
    id: overrides.id ?? 'mem-1',
    goalId: overrides.goalId ?? 'goal-1',
    type: overrides.type ?? 'note',
    status: overrides.status ?? 'candidate',
    content: overrides.content ?? 'Remember this',
    contentHash: overrides.contentHash ?? 'hash-1',
    confidence: overrides.confidence ?? null,
    sourceType: overrides.sourceType ?? 'manual',
    sourceId: overrides.sourceId ?? null,
    sourceSessionId: overrides.sourceSessionId ?? null,
    sourceExtractionId: overrides.sourceExtractionId ?? null,
    sourceOffsetFirst: overrides.sourceOffsetFirst ?? null,
    sourceOffsetLast: overrides.sourceOffsetLast ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    promotedAt: overrides.promotedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory projections', () => {
  it('inserts, updates, and reads a memory item', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    insertMemoryItem(db, memoryRow());
    updateMemoryItem(db, 'mem-1', {
      content: 'Remember this instead',
      status: 'promoted',
      updatedAt: '2026-01-02T00:00:00.000Z',
      promotedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(getMemoryById(db, 'mem-1')).toEqual(
      memoryRow({
        content: 'Remember this instead',
        status: 'promoted',
        updatedAt: '2026-01-02T00:00:00.000Z',
        promotedAt: '2026-01-02T00:00:00.000Z',
      })
    );
  });

  it('survives database reopen', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-memory-projection-reopen-'));
    tempDirs.push(dir);

    let db = openTestDb(dir);
    seedGoal(db, 'goal-1');
    insertMemoryItem(db, memoryRow());

    closeDatabase();
    resetPreparedStatements();

    db = openTestDb(dir);
    expect(getMemoryById(db, 'mem-1')).toEqual(memoryRow());
  });

  it('raises MemoryDuplicateError on live dedupe-index violation', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    insertMemoryItem(db, memoryRow({ id: 'mem-1', contentHash: 'same-hash' }));

    expect(() =>
      insertMemoryItem(
        db,
        memoryRow({
          id: 'mem-2',
          content: 'Different content but same normalized hash',
          contentHash: 'same-hash',
        })
      )
    ).toThrow(MemoryDuplicateError);
    expect(() =>
      insertMemoryItem(
        db,
        memoryRow({
          id: 'mem-2',
          content: 'Different content but same normalized hash',
          contentHash: 'same-hash',
        })
      )
    ).toThrow(expect.objectContaining({ code: 'memory_duplicate' }));
  });

  it('lists promoted first, then candidate, then archived when requested', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    insertMemoryItem(
      db,
      memoryRow({
        id: 'candidate-older',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    insertMemoryItem(
      db,
      memoryRow({
        id: 'promoted-newer',
        status: 'promoted',
        contentHash: 'hash-2',
        createdAt: '2026-01-04T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
        promotedAt: '2026-01-04T00:00:00.000Z',
      })
    );
    insertMemoryItem(
      db,
      memoryRow({
        id: 'candidate-newer',
        contentHash: 'hash-3',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
    );
    insertMemoryItem(
      db,
      memoryRow({
        id: 'archived',
        status: 'archived',
        contentHash: 'hash-4',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        archivedAt: '2026-01-05T00:00:00.000Z',
      })
    );
    insertMemoryItem(
      db,
      memoryRow({
        id: 'promoted-older',
        status: 'promoted',
        contentHash: 'hash-5',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        promotedAt: '2026-01-02T00:00:00.000Z',
      })
    );

    expect(listMemoryByGoal(db, 'goal-1', { includeArchived: false }).map((item) => item.id)).toEqual([
      'promoted-newer',
      'promoted-older',
      'candidate-newer',
      'candidate-older',
    ]);
    expect(listMemoryByGoal(db, 'goal-1', { includeArchived: true }).map((item) => item.id)).toEqual([
      'promoted-newer',
      'promoted-older',
      'candidate-newer',
      'candidate-older',
      'archived',
    ]);
  });
});
