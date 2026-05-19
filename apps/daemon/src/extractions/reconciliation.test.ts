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
import {
  getExtractionById,
  insertExtraction,
  listActiveAndRunningExtractions,
  resetPreparedStatements as resetProjectionStmts,
} from './projection.js';
import { reconcileStaleExtractions } from './reconciliation.js';

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
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-extractions-reconcile-'));
  tempDirs.push(dir);
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

function seedWorkspace(db: Database.Database, workspaceId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, '/tmp/ws', 'ws', 'folder', null, null, 'not_a_repo', '2026-01-01T00:00:00.000Z')`
  ).run(workspaceId, goalId);
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  workspaceId: string
): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId,
    adapterId: 'shell-manual',
    title: sessionId,
    status: 'exited',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

const NOW = '2026-01-01T12:00:00.000Z';

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileStaleExtractions', () => {
  it('no-ops when there are no pending or running extractions', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    reconcileStaleExtractions(db, bus, NOW);
    expect(published).toHaveLength(0);
  });

  it('marks two pending and one running extraction as failed/daemon_restart and emits events', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');
    seedSession(db, 'sess-2', 'goal-1', 'ws-1');

    insertExtraction(db, {
      id: 'ext-pending-1',
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'terminal_state',
      status: 'pending',
      extractorVersion: 'v1',
      sourceFingerprint: 'fp-1',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      summaryId: null,
      itemCount: 0,
      decisionCount: 0,
      promotedCount: 0,
      failureCode: null,
      failureMessage: null,
      requestedAt: '2026-01-01T11:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    });
    insertExtraction(db, {
      id: 'ext-pending-2',
      goalId: 'goal-1',
      sessionId: 'sess-2',
      trigger: 'terminal_state',
      status: 'pending',
      extractorVersion: 'v1',
      sourceFingerprint: 'fp-2',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 200,
      summaryId: null,
      itemCount: 0,
      decisionCount: 0,
      promotedCount: 0,
      failureCode: null,
      failureMessage: null,
      requestedAt: '2026-01-01T11:00:01.000Z',
      startedAt: null,
      finishedAt: null,
    });
    insertExtraction(db, {
      id: 'ext-running',
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      status: 'running',
      extractorVersion: 'v2',
      sourceFingerprint: 'fp-3',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 300,
      summaryId: null,
      itemCount: 0,
      decisionCount: 0,
      promotedCount: 0,
      failureCode: null,
      failureMessage: null,
      requestedAt: '2026-01-01T11:00:02.000Z',
      startedAt: '2026-01-01T11:00:03.000Z',
      finishedAt: null,
    });

    reconcileStaleExtractions(db, bus, NOW);

    expect(listActiveAndRunningExtractions(db)).toHaveLength(0);

    const p1 = getExtractionById(db, 'ext-pending-1')!;
    const p2 = getExtractionById(db, 'ext-pending-2')!;
    const r = getExtractionById(db, 'ext-running')!;

    expect(p1.status).toBe('failed');
    expect(p1.failureCode).toBe('daemon_restart');
    expect(p1.finishedAt).toBe(NOW);

    expect(p2.status).toBe('failed');
    expect(p2.failureCode).toBe('daemon_restart');

    expect(r.status).toBe('failed');
    expect(r.failureCode).toBe('daemon_restart');

    expect(published).toHaveLength(3);
    expect(published.every((e) => e.type === 'memory.extraction.failed')).toBe(true);
    expect(published.every((e) => (e.payload as Record<string, unknown>).failureCode === 'daemon_restart')).toBe(true);
  });

  it('does not touch succeeded or failed extractions', () => {
    const db = openTestDb();
    const bus = new EventBus();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');

    insertExtraction(db, {
      id: 'ext-succeeded',
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      status: 'succeeded',
      extractorVersion: 'v1',
      sourceFingerprint: 'fp-s',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      summaryId: null,
      itemCount: 2,
      decisionCount: 0,
      promotedCount: 1,
      failureCode: null,
      failureMessage: null,
      requestedAt: '2026-01-01T10:00:00.000Z',
      startedAt: '2026-01-01T10:00:01.000Z',
      finishedAt: '2026-01-01T10:00:05.000Z',
    });
    insertExtraction(db, {
      id: 'ext-failed',
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      status: 'failed',
      extractorVersion: 'v2',
      sourceFingerprint: 'fp-f',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      summaryId: null,
      itemCount: 0,
      decisionCount: 0,
      promotedCount: 0,
      failureCode: 'timeout',
      failureMessage: null,
      requestedAt: '2026-01-01T10:01:00.000Z',
      startedAt: null,
      finishedAt: '2026-01-01T10:01:01.000Z',
    });

    const published: DomainEvent[] = [];
    const bus2 = new EventBus();
    bus2.subscribe((e) => published.push(e));

    reconcileStaleExtractions(db, bus2, NOW);
    expect(published).toHaveLength(0);

    expect(getExtractionById(db, 'ext-succeeded')!.status).toBe('succeeded');
    expect(getExtractionById(db, 'ext-failed')!.failureCode).toBe('timeout');
  });

  it('is idempotent: calling a second time with no pending/running is a no-op', () => {
    const db = openTestDb();
    const bus = new EventBus();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');

    insertExtraction(db, {
      id: 'ext-1',
      goalId: 'goal-1',
      sessionId: 'sess-1',
      trigger: 'manual',
      status: 'pending',
      extractorVersion: 'v1',
      sourceFingerprint: 'fp-1',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      summaryId: null,
      itemCount: 0,
      decisionCount: 0,
      promotedCount: 0,
      failureCode: null,
      failureMessage: null,
      requestedAt: '2026-01-01T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    });

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    reconcileStaleExtractions(db, bus, NOW);
    reconcileStaleExtractions(db, bus, NOW); // second call — no pending/running rows remain

    expect(published).toHaveLength(1); // only the first call emitted
    expect(getExtractionById(db, 'ext-1')!.status).toBe('failed');
  });
});
