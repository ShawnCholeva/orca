import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  getTaskById,
  getTaskGenerationById,
  getActiveTaskGenerationByFp,
  insertTask,
  listTasksByGoal,
  listTaskGenerationsByGoal,
  insertOrGetPendingGeneration,
  markGenerationRunning,
  markGenerationSucceeded,
  markGenerationFailed,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-tasks-proj-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string, archived = false): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, ?)`
  ).run(id, now, now, archived ? now : null);
}

const BASE_TASK = {
  parentTaskId: null,
  workspaceId: null,
  role: 'engineer',
  status: 'proposed',
  origin: 'generator',
  title: 'Do something',
  description: 'some work',
  acceptanceCriteriaJson: '[]',
  validationStepsJson: '[]',
  dependenciesJson: '[]',
  sourcesJson: '[]',
  generationId: null,
  workflowStepRunId: null,
  fingerprint: 'fp-abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
};

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('insertTask / getTaskById', () => {
  it('round-trips task row', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK });
    const task = getTaskById(db, 't1');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('t1');
    expect(task!.goalId).toBe('g1');
    expect(task!.status).toBe('proposed');
    expect(task!.role).toBe('engineer');
  });

  it('returns null for unknown id', () => {
    const db = freshDb();
    expect(getTaskById(db, 'nope')).toBeNull();
  });
});

describe('listTasksByGoal', () => {
  it('returns tasks for goal only', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK });
    insertTask(db, { id: 't2', goalId: 'g2', ...BASE_TASK, fingerprint: 'fp-other' });
    const { tasks } = listTasksByGoal(db, { goalId: 'g1' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('excludes archived tasks by default', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK });
    insertTask(db, { id: 't2', goalId: 'g1', ...BASE_TASK, fingerprint: 'fp2', status: 'archived', archivedAt: '2026-01-01T00:00:00.000Z' });
    const { tasks } = listTasksByGoal(db, { goalId: 'g1' });
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t2');
  });

  it('includes archived when includeArchived=true', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK });
    insertTask(db, { id: 't2', goalId: 'g1', ...BASE_TASK, fingerprint: 'fp2', status: 'archived', archivedAt: '2026-01-01T00:00:00.000Z' });
    const { tasks } = listTasksByGoal(db, { goalId: 'g1', includeArchived: true });
    expect(tasks.map((t) => t.id)).toContain('t2');
  });

  it('filters by status', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK, status: 'open', fingerprint: 'fp1' });
    insertTask(db, { id: 't2', goalId: 'g1', ...BASE_TASK, status: 'proposed', fingerprint: 'fp2' });
    const { tasks } = listTasksByGoal(db, { goalId: 'g1', statuses: ['open'] });
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('filters by role', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertTask(db, { id: 't1', goalId: 'g1', ...BASE_TASK, role: 'engineer', fingerprint: 'fp1' });
    insertTask(db, { id: 't2', goalId: 'g1', ...BASE_TASK, role: 'reviewer', fingerprint: 'fp2' });
    const { tasks } = listTasksByGoal(db, { goalId: 'g1', role: 'reviewer' });
    expect(tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('paginates via cursor (created_at DESC, id DESC)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    // Insert tasks with different timestamps so order is deterministic
    for (let i = 1; i <= 5; i++) {
      const ts = `2026-01-0${i}T00:00:00.000Z`;
      insertTask(db, {
        id: `t${i}`,
        goalId: 'g1',
        ...BASE_TASK,
        fingerprint: `fp${i}`,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    const page1 = listTasksByGoal(db, { goalId: 'g1', limit: 3 });
    expect(page1.tasks).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listTasksByGoal(db, { goalId: 'g1', limit: 3, cursor: page1.nextCursor! });
    expect(page2.tasks).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.tasks.map((t) => t.id), ...page2.tasks.map((t) => t.id)];
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5);
  });
});

describe('task_generations lifecycle', () => {
  const BASE_GEN = {
    goalId: 'g1',
    trigger: 'manual' as const,
    triggerSourceId: null,
    generatorId: 'orca/test',
    generatorVersion: '0.1.0',
    inputFingerprint: 'ifp-1',
    requestFingerprint: 'rfp-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
  };

  it('inserts pending generation and retrieves it', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation, isNew } = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    expect(isNew).toBe(true);
    expect(generation.id).toBe('gen1');
    expect(generation.status).toBe('pending');
    expect(generation.sparse).toBe(false);
  });

  it('returns existing row on duplicate active fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const first = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    const second = insertOrGetPendingGeneration(db, { id: 'gen2', ...BASE_GEN });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.generation.id).toBe('gen1');
  });

  it('allows new row after failure (failed excluded from active index)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    markGenerationFailed(db, generation.id, 'provider_error', 'oops', '2026-01-01T00:01:00.000Z');

    // Same fingerprint now allowed since prior row is failed
    const retry = insertOrGetPendingGeneration(db, { id: 'gen2', ...BASE_GEN });
    expect(retry.isNew).toBe(true);
    expect(retry.generation.id).toBe('gen2');
  });

  it('markGenerationRunning updates status', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    markGenerationRunning(db, generation.id, '2026-01-01T00:01:00.000Z');
    const updated = getTaskGenerationById(db, generation.id);
    expect(updated!.status).toBe('running');
    expect(updated!.startedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('markGenerationSucceeded updates status and sparse', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    markGenerationSucceeded(db, generation.id, ['t1', 't2'], false, '2026-01-01T00:02:00.000Z');
    const updated = getTaskGenerationById(db, generation.id);
    expect(updated!.status).toBe('succeeded');
    expect(updated!.sparse).toBe(false);
  });

  it('markGenerationFailed records failure code', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    markGenerationFailed(db, generation.id, 'provider_error', 'service unavailable', '2026-01-01T00:01:00.000Z');
    const updated = getTaskGenerationById(db, generation.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.failureCode).toBe('provider_error');
    expect(updated!.failureMessage).toBe('service unavailable');
  });

  it('getActiveTaskGenerationByFp returns active row only', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN });
    const active = getActiveTaskGenerationByFp(db, 'g1', 'rfp-1');
    expect(active!.id).toBe('gen1');
  });

  it('listTaskGenerationsByGoal returns most recent first', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertOrGetPendingGeneration(db, { id: 'gen1', ...BASE_GEN, requestedAt: '2026-01-01T00:00:00.000Z', requestFingerprint: 'rfp-a', inputFingerprint: 'ifp-a' });
    insertOrGetPendingGeneration(db, { id: 'gen2', ...BASE_GEN, requestedAt: '2026-01-02T00:00:00.000Z', requestFingerprint: 'rfp-b', inputFingerprint: 'ifp-b' });
    const gens = listTaskGenerationsByGoal(db, 'g1', 5);
    expect(gens[0].id).toBe('gen2');
    expect(gens[1].id).toBe('gen1');
  });
});
