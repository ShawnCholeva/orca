import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertSession } from '../sessions/projection.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';
import {
  enqueueExtraction,
  markExtractionStarted,
  markExtractionFailed,
  manualExtractEnqueue,
  SessionNotFoundForExtractionError,
  SessionNotTerminalError,
  SessionArchivedForExtractionError,
  ExtractionNotFoundError,
  InvalidExtractionTransitionError,
  resetPreparedStatements,
} from './usecases.js';

const tempDirs: string[] = [];

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-extractions-usecases-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
}

function seedWorkspace(db: Database.Database, workspaceId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(workspaceId, '/tmp/ws', 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, workspaceId, '2026-01-01T00:00:00.000Z');
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  workspaceId: string,
  status: 'created' | 'running' | 'exited' | 'failed' | 'stopped',
  archivedAt?: string | null
): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId,
    adapterId: 'claude-code',
    title: sessionId,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  if (archivedAt !== undefined) {
    db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(archivedAt, sessionId);
  }
}

function makeCtx(db: Database.Database, bus: EventBus, nowStr?: string) {
  return { db, bus, now: nowStr ? () => nowStr : undefined };
}

function makeOutputStore(firstByteOffset: number, totalBytesKept: number) {
  return {
    readTail: () => ({ firstByteOffset, totalBytesKept }),
  };
}

const NOW = '2026-01-01T12:00:00.000Z';

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('enqueueExtraction', () => {
  it('inserts a pending row and emits memory.extraction.requested in one tx', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const result = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 1024,
      extractorVersion: 'v1',
    });

    expect(result.status).toBe('pending');
    expect(result.goalId).toBe('goal-1');
    expect(result.sessionId).toBe('sess-1');
    expect(result.trigger).toBe('manual');
    expect(result.requestedAt).toBe(NOW);

    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('memory.extraction.requested');
    expect(published[0].payload).toMatchObject({
      extractionId: result.id,
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
    });

    const row = db
      .prepare('SELECT * FROM memory_extractions WHERE id = ?')
      .get(result.id) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
  });

  it('is idempotent: returns the same row on double enqueue with identical fingerprint', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const input = {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual' as const,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 1024,
      extractorVersion: 'v1',
    };

    const first = enqueueExtraction(makeCtx(db, bus, NOW), input);
    const second = enqueueExtraction(makeCtx(db, bus, NOW), input);

    expect(second.id).toBe(first.id);
    expect(published).toHaveLength(1); // only one event total
  });

  it('allows a new enqueue after a failed extraction (same fingerprint allowed)', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const input = {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual' as const,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 1024,
      extractorVersion: 'v1',
    };

    const first = enqueueExtraction(makeCtx(db, bus, NOW), input);
    // Mark the first extraction failed — it falls out of the active index
    markExtractionFailed(makeCtx(db, bus, NOW), first.id, { failureCode: 'internal_error' });

    // Now enqueue again — should create a new pending row
    const second = enqueueExtraction(makeCtx(db, bus, NOW), input);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
  });

  it('manualExtractEnqueue returns an existing active row for the current fingerprint', () => {
    const db = openTestDb();
    const bus = new EventBus();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const first = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 10,
      sourceOffsetLast: 20,
      extractorVersion: 'v1',
    });

    const result = manualExtractEnqueue(
      {
        ...makeCtx(db, bus, NOW),
        outputStore: makeOutputStore(10, 10),
        extractorVersion: 'v1',
      },
      'sess-1'
    );

    expect(result.created).toBe(false);
    expect(result.extraction.id).toBe(first.id);
  });

  it('manualExtractEnqueue creates a new pending row after a failed extraction for the same fingerprint', () => {
    const db = openTestDb();
    const bus = new EventBus();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const first = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 10,
      sourceOffsetLast: 20,
      extractorVersion: 'v1',
    });
    markExtractionFailed(makeCtx(db, bus, NOW), first.id, { failureCode: 'internal_error' });

    const result = manualExtractEnqueue(
      {
        ...makeCtx(db, bus, NOW),
        outputStore: makeOutputStore(10, 10),
        extractorVersion: 'v1',
      },
      'sess-1'
    );

    expect(result.created).toBe(true);
    expect(result.extraction.id).not.toBe(first.id);
    expect(result.extraction.status).toBe('pending');
  });

  it('throws SessionNotFoundForExtractionError for missing session', () => {
    const db = openTestDb();
    const bus = new EventBus();
    expect(() =>
      enqueueExtraction(makeCtx(db, bus, NOW), {
        goalId: 'goal-1',
        sessionId: 'no-such',
        trigger: 'manual',
        sourceOffsetFirst: 0,
        sourceOffsetLast: 100,
        extractorVersion: 'v1',
      })
    ).toThrow(SessionNotFoundForExtractionError);
  });

  it('throws SessionNotTerminalError for non-terminal session', () => {
    const db = openTestDb();
    const bus = new EventBus();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-running', 'goal-1', 'ws-1', 'running');

    expect(() =>
      enqueueExtraction(makeCtx(db, bus, NOW), {
        goalId: 'goal-1',
        sessionId: 'sess-running',
        trigger: 'manual',
        sourceOffsetFirst: 0,
        sourceOffsetLast: 100,
        extractorVersion: 'v1',
      })
    ).toThrow(SessionNotTerminalError);
  });

  it('throws SessionArchivedForExtractionError for archived session', () => {
    const db = openTestDb();
    const bus = new EventBus();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-archived', 'goal-1', 'ws-1', 'exited', '2026-01-01T00:00:00.000Z');

    expect(() =>
      enqueueExtraction(makeCtx(db, bus, NOW), {
        goalId: 'goal-1',
        sessionId: 'sess-archived',
        trigger: 'manual',
        sourceOffsetFirst: 0,
        sourceOffsetLast: 100,
        extractorVersion: 'v1',
      })
    ).toThrow(SessionArchivedForExtractionError);
  });
});

describe('markExtractionStarted', () => {
  it('transitions pending -> running and emits memory.extraction.started', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const enqueued = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'v1',
    });
    published.length = 0;

    const started = markExtractionStarted(makeCtx(db, bus, NOW), enqueued.id);
    expect(started.status).toBe('running');
    expect(started.startedAt).toBe(NOW);

    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('memory.extraction.started');
    expect(published[0].payload).toMatchObject({
      extractionId: enqueued.id,
      goalId: 'goal-1',
      sessionId: 'sess-1',
    });
  });

  it('rejects invalid transition: failed -> started', () => {
    const db = openTestDb();
    const bus = new EventBus();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const enqueued = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'v1',
    });
    markExtractionFailed(makeCtx(db, bus, NOW), enqueued.id, { failureCode: 'timeout' });

    expect(() => markExtractionStarted(makeCtx(db, bus, NOW), enqueued.id)).toThrow(
      InvalidExtractionTransitionError
    );
  });

  it('throws ExtractionNotFoundError for unknown id', () => {
    const db = openTestDb();
    const bus = new EventBus();
    expect(() => markExtractionStarted(makeCtx(db, bus, NOW), 'no-such')).toThrow(
      ExtractionNotFoundError
    );
  });
});

describe('markExtractionFailed', () => {
  it('transitions pending -> failed and emits memory.extraction.failed', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const enqueued = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'v1',
    });
    published.length = 0;

    const failed = markExtractionFailed(makeCtx(db, bus, NOW), enqueued.id, {
      failureCode: 'timeout',
      failureMessage: null,
    });

    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('timeout');
    expect(failed.finishedAt).toBe(NOW);

    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('memory.extraction.failed');
    expect(published[0].payload).toMatchObject({
      extractionId: enqueued.id,
      goalId: 'goal-1',
      sessionId: 'sess-1',
      failureCode: 'timeout',
    });
  });

  it('transitions running -> failed', () => {
    const db = openTestDb();
    const bus = new EventBus();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const enqueued = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'v1',
    });
    markExtractionStarted(makeCtx(db, bus, NOW), enqueued.id);
    const failed = markExtractionFailed(makeCtx(db, bus, NOW), enqueued.id, {
      failureCode: 'internal_error',
    });

    expect(failed.status).toBe('failed');
  });

  it('rejects invalid transition: succeeded -> failed', () => {
    const db = openTestDb();
    const bus = new EventBus();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const enqueued = enqueueExtraction(makeCtx(db, bus, NOW), {
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'v1',
    });
    // Manually force succeeded status to test the guard
    db.prepare(`UPDATE memory_extractions SET status = 'succeeded' WHERE id = ?`).run(enqueued.id);

    expect(() =>
      markExtractionFailed(makeCtx(db, bus, NOW), enqueued.id, { failureCode: 'internal_error' })
    ).toThrow(InvalidExtractionTransitionError);
  });
});
