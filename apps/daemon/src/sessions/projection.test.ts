import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  getSessionDetail,
  insertSession,
  listSessionsByGoal,
  resetPreparedStatements,
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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-sess-proj-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null)`
  ).run(id);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `/tmp/ws/${id}`, 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, id, '2026-01-01T00:00:00.000Z');
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('insertSession + getSessionDetail round-trip', () => {
  it('returns the inserted session with all fields', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');

    insertSession(db, {
      id: 'sess-1',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      role: 'Engineer',
      instruction: 'do stuff',
      title: 'My Session',
      status: 'created',
      createdAt: '2026-05-01T10:00:00.000Z',
    });

    const detail = getSessionDetail(db, 'sess-1');
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('sess-1');
    expect(detail!.goalId).toBe('g1');
    expect(detail!.workspaceId).toBe('ws1');
    expect(detail!.adapterId).toBe('claude-code');
    expect(detail!.role).toBe('Engineer');
    expect(detail!.instruction).toBe('do stuff');
    expect(detail!.title).toBe('My Session');
    expect(detail!.status).toBe('created');
    expect(detail!.createdAt).toBe('2026-05-01T10:00:00.000Z');
    expect(detail!.pid).toBeNull();
    expect(detail!.command).toBeNull();
    expect(detail!.args).toBeNull();
    expect(detail!.cwd).toBeNull();
    expect(detail!.exitCode).toBeNull();
    expect(detail!.failureReason).toBeNull();
    expect(detail!.archivedAt).toBeNull();
  });

  it('returns null for missing session', () => {
    const db = freshDb();
    expect(getSessionDetail(db, 'no-such')).toBeNull();
  });
});

describe('listSessionsByGoal', () => {
  it('returns sessions ordered by created_at DESC', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');

    insertSession(db, {
      id: 'sess-a',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'A',
      status: 'created',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertSession(db, {
      id: 'sess-b',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'B',
      status: 'created',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    insertSession(db, {
      id: 'sess-c',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'C',
      status: 'created',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const summaries = listSessionsByGoal(db, 'g1');
    expect(summaries).toHaveLength(3);
    expect(summaries.map((s) => s.id)).toEqual(['sess-b', 'sess-c', 'sess-a']);
  });

  it('returns empty array for unknown goal', () => {
    const db = freshDb();
    expect(listSessionsByGoal(db, 'no-goal')).toEqual([]);
  });

  it('scopes list to the given goal', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedWorkspace(db, 'ws1', 'g1');
    seedWorkspace(db, 'ws2', 'g2');

    insertSession(db, {
      id: 'sess-g1',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'for g1',
      status: 'created',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertSession(db, {
      id: 'sess-g2',
      goalId: 'g2',
      workspaceId: 'ws2',
      adapterId: 'claude-code',
      title: 'for g2',
      status: 'created',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const g1Sessions = listSessionsByGoal(db, 'g1');
    expect(g1Sessions).toHaveLength(1);
    expect(g1Sessions[0]!.id).toBe('sess-g1');
  });

  it('surfaces latest extraction details and latest summary headline when present', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');

    insertSession(db, {
      id: 'sess-1',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'Session with extraction',
      status: 'exited',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    db.prepare(
      `INSERT INTO memory_extractions (
        id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
        source_offset_first, source_offset_last, summary_id, item_count, decision_count,
        promoted_count, failure_code, failure_message, requested_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ext-1',
      'g1',
      'sess-1',
      'manual',
      'failed',
      'memory-test-v1',
      'fp-1',
      0,
      25,
      null,
      0,
      0,
      0,
      'timeout',
      'Timed out',
      '2026-01-01T00:10:00.000Z',
      '2026-01-01T00:10:01.000Z',
      '2026-01-01T00:10:30.000Z'
    );

    db.prepare(
      `INSERT INTO memory_extractions (
        id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
        source_offset_first, source_offset_last, summary_id, item_count, decision_count,
        promoted_count, failure_code, failure_message, requested_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ext-0',
      'g1',
      'sess-1',
      'manual',
      'succeeded',
      'memory-test-v1',
      'fp-0',
      0,
      10,
      'sum-1',
      1,
      0,
      0,
      null,
      null,
      '2026-01-01T00:08:00.000Z',
      '2026-01-01T00:08:01.000Z',
      '2026-01-01T00:08:30.000Z'
    );

    db.prepare(
      `INSERT INTO session_summaries (
        id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
        source_offset_first, source_offset_last, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'sum-1',
      'sess-1',
      'g1',
      'ext-0',
      'Most recent completed summary',
      'Summary text',
      1,
      0,
      10,
      '2026-01-01T00:09:00.000Z'
    );

    const summary = listSessionsByGoal(db, 'g1')[0];
    const detail = getSessionDetail(db, 'sess-1');

    expect(summary).toMatchObject({
      latestExtraction: {
        id: 'ext-1',
        status: 'failed',
        requestedAt: '2026-01-01T00:10:00.000Z',
        finishedAt: '2026-01-01T00:10:30.000Z',
        failureCode: 'timeout',
        truncated: false,
      },
      latestSummaryHeadline: 'Most recent completed summary',
    });
    expect(detail).toMatchObject({
      latestExtraction: {
        id: 'ext-1',
        status: 'failed',
        requestedAt: '2026-01-01T00:10:00.000Z',
        finishedAt: '2026-01-01T00:10:30.000Z',
        failureCode: 'timeout',
        truncated: false,
      },
      latestSummaryHeadline: 'Most recent completed summary',
    });
  });

  it('keeps latest extraction undefined and latest summary headline null when absent', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');

    insertSession(db, {
      id: 'sess-1',
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      title: 'Session without extraction',
      status: 'created',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const summary = listSessionsByGoal(db, 'g1')[0]!;
    const detail = getSessionDetail(db, 'sess-1')!;

    expect(summary.latestExtraction).toBeUndefined();
    expect(summary.latestSummaryHeadline).toBeNull();
    expect(detail.latestExtraction).toBeUndefined();
    expect(detail.latestSummaryHeadline).toBeNull();
  });
});
