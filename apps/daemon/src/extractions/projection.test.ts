import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import type { MemoryExtraction, SessionMemorySummary } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertSession } from '../sessions/projection.js';
import {
  getExtractionById,
  getLatestExtractionForSession,
  getLatestSummaryForSession,
  insertExtraction,
  insertSummary,
  listActiveAndRunningExtractions,
  listEligibleSessionsForGoal,
  resetPreparedStatements,
  updateExtractionStatus,
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
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(dataDir?: string): Database.Database {
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'orca-extractions-projection-'));
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

function seedWorkspace(db: Database.Database, workspaceId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(workspaceId, `/tmp/ws/${workspaceId}`, 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, workspaceId, '2026-01-01T00:00:00.000Z');
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  workspaceId: string,
  status: 'created' | 'running' | 'exited' | 'failed' | 'stopped'
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
}

function extractionRow(overrides: Partial<MemoryExtraction> = {}): MemoryExtraction {
  return {
    id: overrides.id ?? 'ext-1',
    goalId: overrides.goalId ?? 'goal-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    trigger: overrides.trigger ?? 'manual',
    status: overrides.status ?? 'pending',
    extractorVersion: overrides.extractorVersion ?? 'memory-test-v1',
    sourceFingerprint: overrides.sourceFingerprint ?? 'fp-1',
    sourceOffsetFirst: overrides.sourceOffsetFirst ?? 0,
    sourceOffsetLast: overrides.sourceOffsetLast ?? 10,
    summaryId: overrides.summaryId ?? null,
    itemCount: overrides.itemCount ?? 0,
    decisionCount: overrides.decisionCount ?? 0,
    promotedCount: overrides.promotedCount ?? 0,
    failureCode: overrides.failureCode ?? null,
    failureMessage: overrides.failureMessage ?? null,
    requestedAt: overrides.requestedAt ?? '2026-01-01T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
  };
}

function summaryRow(overrides: Partial<SessionMemorySummary> = {}): SessionMemorySummary {
  return {
    id: overrides.id ?? 'sum-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    goalId: overrides.goalId ?? 'goal-1',
    extractionId: overrides.extractionId ?? 'ext-1',
    headline: overrides.headline ?? 'Summary',
    summaryText: overrides.summaryText ?? 'Summary text',
    truncated: overrides.truncated ?? false,
    sourceOffsetFirst: overrides.sourceOffsetFirst ?? 0,
    sourceOffsetLast: overrides.sourceOffsetLast ?? 10,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('extraction projections', () => {
  it('inserts, updates, and reads an extraction and summary', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    const extractionId = insertExtraction(db, extractionRow());
    expect(extractionId).toBe('ext-1');

    updateExtractionStatus(db, 'ext-1', {
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:05.000Z',
      finishedAt: '2026-01-01T00:00:10.000Z',
      summaryId: 'sum-1',
      itemCount: 2,
      decisionCount: 1,
      promotedCount: 1,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 10,
    });
    insertSummary(db, summaryRow());

    expect(getExtractionById(db, 'ext-1')).toEqual(
      extractionRow({
        status: 'succeeded',
        summaryId: 'sum-1',
        itemCount: 2,
        decisionCount: 1,
        promotedCount: 1,
        startedAt: '2026-01-01T00:00:05.000Z',
        finishedAt: '2026-01-01T00:00:10.000Z',
      })
    );
    expect(getLatestSummaryForSession(db, 'sess-1')).toEqual(summaryRow());
  });

  it('survives database reopen', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-extractions-projection-reopen-'));
    tempDirs.push(dir);

    let db = openTestDb(dir);
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');
    insertExtraction(db, extractionRow());

    closeDatabase();
    resetPreparedStatements();

    db = openTestDb(dir);
    expect(getExtractionById(db, 'ext-1')).toEqual(extractionRow());
  });

  it('returns null when there is no latest extraction', () => {
    const db = openTestDb();
    expect(getLatestExtractionForSession(db, 'missing-session')).toBeNull();
  });

  it('lists only terminal sessions for the goal without active or succeeded extractions', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedWorkspace(db, 'ws-2', 'goal-2');

    seedSession(db, 'sess-exited', 'goal-1', 'ws-1', 'exited');
    seedSession(db, 'sess-failed', 'goal-1', 'ws-1', 'failed');
    seedSession(db, 'sess-stopped', 'goal-1', 'ws-1', 'stopped');
    seedSession(db, 'sess-running', 'goal-1', 'ws-1', 'running');
    seedSession(db, 'sess-other-goal', 'goal-2', 'ws-2', 'exited');

    insertExtraction(
      db,
      extractionRow({
        id: 'ext-succeeded',
        sessionId: 'sess-exited',
        sourceFingerprint: 'fp-succeeded',
        status: 'succeeded',
      })
    );
    insertExtraction(
      db,
      extractionRow({
        id: 'ext-running',
        sessionId: 'sess-failed',
        sourceFingerprint: 'fp-running',
        status: 'running',
      })
    );
    insertExtraction(
      db,
      extractionRow({
        id: 'ext-failed',
        sessionId: 'sess-stopped',
        sourceFingerprint: 'fp-failed',
        status: 'failed',
      })
    );

    expect(listEligibleSessionsForGoal(db, 'goal-1').map((session) => session.id)).toEqual([
      'sess-stopped',
    ]);
  });

  it('lists pending and running extractions for reconciliation', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1', 'exited');

    insertExtraction(db, extractionRow({ id: 'ext-pending', status: 'pending' }));
    insertExtraction(
      db,
      extractionRow({
        id: 'ext-running',
        status: 'running',
        sourceFingerprint: 'fp-2',
        requestedAt: '2026-01-01T00:01:00.000Z',
      })
    );
    insertExtraction(
      db,
      extractionRow({
        id: 'ext-succeeded',
        status: 'succeeded',
        sourceFingerprint: 'fp-3',
        requestedAt: '2026-01-01T00:02:00.000Z',
      })
    );

    expect(listActiveAndRunningExtractions(db).map((extraction) => extraction.id)).toEqual([
      'ext-pending',
      'ext-running',
    ]);
  });
});
