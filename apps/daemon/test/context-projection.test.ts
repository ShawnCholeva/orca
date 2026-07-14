import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import {
  ContextProjectionError,
  getActiveAssemblyByFingerprint,
  getAssembliesByStatus,
  getContextPackageById,
  insertContextAssembly,
  insertContextPackage,
  listContextPackagesByGoal,
  setSessionContextPackageId,
  updateAssemblyFailed,
  updateAssemblyStarted,
  updateAssemblySucceeded,
  type InsertContextAssemblyInput,
  type InsertContextPackageInput,
} from '../src/context/projection.js';
import { getSessionDetail } from '../src/sessions/projection.js';

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
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-proj-'));
  if (!dataDir) tempDirs.push(dir);
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

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, '/tmp/ws', 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, id, '2026-01-01T00:00:00.000Z');
}

function seedSession(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
     VALUES (?, ?, ?, 'claude-code', 'Session', 'created', '2026-01-01T00:00:00.000Z')`
  ).run(id, goalId, workspaceId);
}

function makePackageInput(overrides: Partial<InsertContextPackageInput> = {}): InsertContextPackageInput {
  return {
    id: overrides.id ?? 'pkg-1',
    goalId: overrides.goalId ?? 'goal-1',
    supersedesPackageId: overrides.supersedesPackageId ?? null,
    adapterId: overrides.adapterId ?? 'claude-code',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    role: overrides.role ?? 'engineer',
    objective: overrides.objective ?? 'Fix the bug',
    status: overrides.status ?? 'ready',
    renderedContext: overrides.renderedContext ?? '# Objective\nFix the bug\n',
    renderedBytes: overrides.renderedBytes ?? 22,
    estimatedTokens: overrides.estimatedTokens ?? 6,
    truncated: overrides.truncated ?? false,
    sparse: overrides.sparse ?? false,
    sourceCount: overrides.sourceCount ?? 1,
    sources: overrides.sources ?? [
      {
        type: 'goal',
        id: 'goal-1',
        label: 'Goal',
        reason: 'required',
        marker: '[goal:goal-1]',
      },
    ],
    warnings: overrides.warnings ?? [],
    sourceFingerprint: overrides.sourceFingerprint ?? 'fp-abc',
    assemblerVersion: overrides.assemblerVersion ?? '0.1.0',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function makeAssemblyInput(overrides: Partial<InsertContextAssemblyInput> = {}): InsertContextAssemblyInput {
  return {
    id: overrides.id ?? 'asm-1',
    goalId: overrides.goalId ?? 'goal-1',
    packageId: overrides.packageId ?? null,
    replacePackageId: overrides.replacePackageId ?? null,
    adapterId: overrides.adapterId ?? 'claude-code',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    role: overrides.role ?? 'engineer',
    objectiveHash: overrides.objectiveHash ?? 'obj-hash',
    sourceFingerprint: overrides.sourceFingerprint ?? 'fp-abc',
    assemblerVersion: overrides.assemblerVersion ?? '0.1.0',
    requestFingerprint: overrides.requestFingerprint ?? 'req-fp',
    status: overrides.status ?? 'pending',
    trigger: overrides.trigger ?? 'prepare',
    failureCode: overrides.failureCode ?? null,
    failureMessage: overrides.failureMessage ?? null,
    requestedAt: overrides.requestedAt ?? '2026-01-01T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('context-projection: package insert and read', () => {
  it('inserts and reads back all fields including JSON arrays, truncated, sparse', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    const input = makePackageInput({
      id: 'pkg-1',
      sources: [
        { type: 'goal', id: 'goal-1', label: 'Goal', reason: 'required', marker: '[goal:goal-1]' },
        { type: 'memory_item', id: 'mem-1', label: 'Constraint', reason: 'high_confidence', marker: '[mem:mem-1]' },
      ],
      warnings: ['no_decisions', 'goal_not_refined'],
      truncated: true,
      sparse: false,
    });

    insertContextPackage(db, input);
    const pkg = getContextPackageById(db, 'pkg-1');

    expect(pkg).not.toBeNull();
    expect(pkg!.id).toBe('pkg-1');
    expect(pkg!.goalId).toBe('goal-1');
    expect(pkg!.adapterId).toBe('claude-code');
    expect(pkg!.role).toBe('engineer');
    expect(pkg!.objective).toBe('Fix the bug');
    expect(pkg!.status).toBe('ready');
    expect(pkg!.renderedContext).toBe('# Objective\nFix the bug\n');
    expect(pkg!.renderedBytes).toBe(22);
    expect(pkg!.estimatedTokens).toBe(6);
    expect(pkg!.truncated).toBe(true);
    expect(pkg!.sparse).toBe(false);
    expect(pkg!.sourceCount).toBe(1);
    expect(pkg!.sources).toHaveLength(2);
    expect(pkg!.sources[0]).toMatchObject({ type: 'goal', id: 'goal-1', marker: '[goal:goal-1]' });
    expect(pkg!.sources[1]).toMatchObject({ type: 'memory_item', id: 'mem-1' });
    expect(pkg!.warnings).toEqual(['no_decisions', 'goal_not_refined']);
    expect(pkg!.sourceFingerprint).toBe('fp-abc');
    expect(pkg!.assemblerVersion).toBe('0.1.0');
  });

  it('returns null for unknown package id', () => {
    const db = openTestDb();
    expect(getContextPackageById(db, 'no-such-pkg')).toBeNull();
  });

  it('throws ContextProjectionError on corrupted sources_json', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextPackage(db, makePackageInput());
    // Corrupt the JSON directly
    db.prepare(`UPDATE context_packages SET sources_json = 'not-json' WHERE id = 'pkg-1'`).run();
    expect(() => getContextPackageById(db, 'pkg-1')).toThrow(ContextProjectionError);
  });
});

describe('context-projection: package round-trip after DB reopen', () => {
  it('row survives DB close and reopen', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-proj-reopen-'));
    tempDirs.push(dir);

    const db1 = openTestDb(dir);
    seedGoal(db1, 'goal-1');
    seedWorkspace(db1, 'ws-1', 'goal-1');
    insertContextPackage(db1, makePackageInput({
      sources: [{ type: 'goal', id: 'goal-1', label: 'Goal', reason: 'required', marker: '[goal:goal-1]' }],
      warnings: ['no_decisions'],
    }));
    closeDatabase();

    const db2 = openTestDb(dir);
    const pkg = getContextPackageById(db2, 'pkg-1');
    expect(pkg).not.toBeNull();
    expect(pkg!.sources).toHaveLength(1);
    expect(pkg!.warnings).toEqual(['no_decisions']);
  });
});

describe('context-projection: assembly lifecycle', () => {
  it('inserts pending assembly and reads back via getActiveAssemblyByFingerprint', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextAssembly(db, makeAssemblyInput());

    const asm = getActiveAssemblyByFingerprint(db, 'goal-1', 'req-fp');
    expect(asm).not.toBeNull();
    expect(asm!.id).toBe('asm-1');
    expect(asm!.status).toBe('pending');
    expect(asm!.trigger).toBe('prepare');
    expect(asm!.failureCode).toBeNull();
  });

  it('updateAssemblyStarted transitions to running', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextAssembly(db, makeAssemblyInput());
    updateAssemblyStarted(db, 'asm-1', '2026-01-01T00:00:01.000Z');

    const asm = getActiveAssemblyByFingerprint(db, 'goal-1', 'req-fp');
    expect(asm!.status).toBe('running');
    expect(asm!.startedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('updateAssemblySucceeded transitions to succeeded with packageId', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextAssembly(db, makeAssemblyInput());
    insertContextPackage(db, makePackageInput());
    updateAssemblySucceeded(db, 'asm-1', { packageId: 'pkg-1', finishedAt: '2026-01-01T00:00:02.000Z' });

    const asm = getActiveAssemblyByFingerprint(db, 'goal-1', 'req-fp');
    expect(asm!.status).toBe('succeeded');
    expect(asm!.packageId).toBe('pkg-1');
    expect(asm!.finishedAt).toBe('2026-01-01T00:00:02.000Z');
  });

  it('updateAssemblyFailed transitions to failed and is excluded from active lookup', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextAssembly(db, makeAssemblyInput());
    updateAssemblyFailed(db, 'asm-1', {
      failureCode: 'internal_error',
      failureMessage: 'something went wrong',
      finishedAt: '2026-01-01T00:00:02.000Z',
    });

    // Failed row excluded from active lookup
    const active = getActiveAssemblyByFingerprint(db, 'goal-1', 'req-fp');
    expect(active).toBeNull();

    // But visible via getAssembliesByStatus
    const failed = getAssembliesByStatus(db, ['failed']);
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect(failed[0].failureCode).toBe('internal_error');
    expect(failed[0].failureMessage).toBe('something went wrong');
  });

  it('getActiveAssemblyByFingerprint returns null for failed row, allowing retry', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-1', requestFingerprint: 'fp-x' }));
    updateAssemblyFailed(db, 'asm-1', { failureCode: 'internal_error', failureMessage: null, finishedAt: '2026-01-01T00:00:01.000Z' });

    expect(getActiveAssemblyByFingerprint(db, 'goal-1', 'fp-x')).toBeNull();

    // New pending row with same fingerprint is allowed (failed excluded from unique index)
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-2', requestFingerprint: 'fp-x' }));
    const active = getActiveAssemblyByFingerprint(db, 'goal-1', 'fp-x');
    expect(active).not.toBeNull();
    expect(active!.id).toBe('asm-2');
  });
});

describe('context-projection: listContextPackagesByGoal', () => {
  it('orders by created_at DESC and respects limit', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    insertContextPackage(db, makePackageInput({ id: 'pkg-1', createdAt: '2026-01-01T00:00:01.000Z' }));
    insertContextPackage(db, makePackageInput({ id: 'pkg-2', createdAt: '2026-01-01T00:00:03.000Z' }));
    insertContextPackage(db, makePackageInput({ id: 'pkg-3', createdAt: '2026-01-01T00:00:02.000Z' }));

    const { packages } = listContextPackagesByGoal(db, 'goal-1', { limit: 2 });
    expect(packages).toHaveLength(2);
    expect(packages[0].id).toBe('pkg-2');
    expect(packages[1].id).toBe('pkg-3');
  });

  it('joins recent assemblies for the same goal', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    insertContextPackage(db, makePackageInput());
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-1', status: 'succeeded' }));
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-2', status: 'failed', requestFingerprint: 'fp-2' }));

    const { packages, assemblies } = listContextPackagesByGoal(db, 'goal-1', { limit: 20 });
    expect(packages).toHaveLength(1);
    expect(assemblies).toHaveLength(2);
  });

  it('filters by adapterId when provided', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    insertContextPackage(db, makePackageInput({ id: 'pkg-1', adapterId: 'codex' }));
    insertContextPackage(db, makePackageInput({ id: 'pkg-2', adapterId: 'claude-code' }));

    const { packages } = listContextPackagesByGoal(db, 'goal-1', { adapterId: 'claude-code', limit: 20 });
    expect(packages).toHaveLength(1);
    expect(packages[0].id).toBe('pkg-2');
  });

  it('filters by sessionId and returns empty when session has no package', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');

    insertContextPackage(db, makePackageInput());

    // Session has no package yet
    const { packages } = listContextPackagesByGoal(db, 'goal-1', { sessionId: 'sess-1', limit: 20 });
    expect(packages).toHaveLength(0);
  });

  it('filters by sessionId and returns the linked package', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');

    insertContextPackage(db, makePackageInput({ id: 'pkg-1' }));
    insertContextPackage(db, makePackageInput({ id: 'pkg-2', createdAt: '2026-01-02T00:00:00.000Z' }));
    setSessionContextPackageId(db, 'sess-1', 'pkg-1');

    const { packages } = listContextPackagesByGoal(db, 'goal-1', { sessionId: 'sess-1', limit: 20 });
    expect(packages).toHaveLength(1);
    expect(packages[0].id).toBe('pkg-1');
  });
});

describe('context-projection: getAssembliesByStatus', () => {
  it('returns empty array for empty statuses list', () => {
    const db = openTestDb();
    expect(getAssembliesByStatus(db, [])).toEqual([]);
  });

  it('returns only assemblies matching the given statuses', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-pending', status: 'pending', requestFingerprint: 'fp-1' }));
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-running', status: 'running', requestFingerprint: 'fp-2' }));
    insertContextAssembly(db, makeAssemblyInput({ id: 'asm-failed', status: 'failed', requestFingerprint: 'fp-3' }));

    const stale = getAssembliesByStatus(db, ['pending', 'running']);
    expect(stale.map((a) => a.id).sort()).toEqual(['asm-pending', 'asm-running'].sort());
  });
});

describe('context-projection: setSessionContextPackageId', () => {
  it('updates sessions.context_package_id and getSessionDetail returns it', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');
    insertContextPackage(db, makePackageInput({ id: 'pkg-1' }));

    const before = getSessionDetail(db, 'sess-1');
    expect(before!.contextPackageId).toBeNull();

    setSessionContextPackageId(db, 'sess-1', 'pkg-1');

    const after = getSessionDetail(db, 'sess-1');
    expect(after!.contextPackageId).toBe('pkg-1');
  });
});
