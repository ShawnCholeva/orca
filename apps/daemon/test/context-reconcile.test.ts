import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import {
  getAssembliesByStatus,
  insertContextAssembly,
  resetPreparedStatements as resetProjectionStmts,
} from '../src/context/projection.js';
import { reconcileStaleAssemblies } from '../src/context/reconcile.js';

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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-reconcile-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
}

function seedAssembly(
  db: Database.Database,
  id: string,
  goalId: string,
  status: string,
  overrides: { requestFingerprint?: string; failureCode?: string } = {}
): void {
  insertContextAssembly(db, {
    id,
    goalId,
    packageId: null,
    replacePackageId: null,
    adapterId: 'shell-manual',
    workspaceId: null,
    role: 'engineer',
    objectiveHash: 'hash-' + id,
    sourceFingerprint: 'fp-' + id,
    assemblerVersion: '0.1.0',
    requestFingerprint: overrides.requestFingerprint ?? 'rfp-' + id,
    status,
    trigger: 'prepare',
    failureCode: overrides.failureCode ?? null,
    failureMessage: null,
    requestedAt: '2026-01-01T10:00:00.000Z',
    startedAt: status === 'running' ? '2026-01-01T10:00:01.000Z' : null,
    finishedAt: status === 'succeeded' || status === 'failed' ? '2026-01-01T10:00:05.000Z' : null,
  });
}

function getAssemblyRow(
  db: Database.Database,
  id: string
): { status: string; failure_code: string | null; finished_at: string | null } | undefined {
  return db
    .prepare('SELECT status, failure_code, finished_at FROM context_assemblies WHERE id = ?')
    .get(id) as { status: string; failure_code: string | null; finished_at: string | null } | undefined;
}

const NOW = '2026-01-02T12:00:00.000Z';

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileStaleAssemblies', () => {
  it('no-ops when there are no pending or running assemblies', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    reconcileStaleAssemblies(db, bus, NOW);
    expect(published).toHaveLength(0);
  });

  it('marks two pending and one running as failed/daemon_restart and emits events', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedAssembly(db, 'asm-pending-1', 'goal-1', 'pending');
    seedAssembly(db, 'asm-pending-2', 'goal-1', 'pending');
    seedAssembly(db, 'asm-running', 'goal-1', 'running');

    reconcileStaleAssemblies(db, bus, NOW);

    // DB rows updated
    const p1 = getAssemblyRow(db, 'asm-pending-1')!;
    const p2 = getAssemblyRow(db, 'asm-pending-2')!;
    const r = getAssemblyRow(db, 'asm-running')!;

    expect(p1.status).toBe('failed');
    expect(p1.failure_code).toBe('daemon_restart');
    expect(p1.finished_at).toBe(NOW);

    expect(p2.status).toBe('failed');
    expect(p2.failure_code).toBe('daemon_restart');
    expect(p2.finished_at).toBe(NOW);

    expect(r.status).toBe('failed');
    expect(r.failure_code).toBe('daemon_restart');
    expect(r.finished_at).toBe(NOW);

    // Three events emitted after commit
    expect(published).toHaveLength(3);
    expect(published.every((e) => e.type === 'context.assembly.failed')).toBe(true);
    expect(
      published.every(
        (e) => (e.payload as Record<string, unknown>).failureCode === 'daemon_restart'
      )
    ).toBe(true);

    // No pending/running rows remain
    expect(getAssembliesByStatus(db, ['pending', 'running'])).toHaveLength(0);
  });

  it('does not touch succeeded or already-failed assemblies', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedAssembly(db, 'asm-succeeded', 'goal-1', 'succeeded');
    seedAssembly(db, 'asm-failed', 'goal-1', 'failed', { failureCode: 'internal_error' });

    reconcileStaleAssemblies(db, bus, NOW);

    expect(published).toHaveLength(0);

    const s = getAssemblyRow(db, 'asm-succeeded')!;
    const f = getAssemblyRow(db, 'asm-failed')!;

    expect(s.status).toBe('succeeded');
    expect(f.status).toBe('failed');
    expect(f.failure_code).toBe('internal_error');
  });

  it('is idempotent: second call with no pending/running rows is a no-op', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedAssembly(db, 'asm-1', 'goal-1', 'pending');

    reconcileStaleAssemblies(db, bus, NOW);
    reconcileStaleAssemblies(db, bus, NOW); // second call — no pending/running remain

    expect(published).toHaveLength(1);
    expect(getAssemblyRow(db, 'asm-1')!.status).toBe('failed');
  });

  it('event payloads are content-free (assemblyId, goalId, failureCode only)', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedAssembly(db, 'asm-1', 'goal-1', 'pending');

    reconcileStaleAssemblies(db, bus, NOW);

    expect(published).toHaveLength(1);
    const payload = published[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['assemblyId', 'failureCode', 'goalId']);
    expect(payload['assemblyId']).toBe('asm-1');
    expect(payload['goalId']).toBe('goal-1');
    expect(payload['failureCode']).toBe('daemon_restart');
  });

  it('events are persisted in DB within the transaction', () => {
    const db = openTestDb();
    const bus = new EventBus();

    seedGoal(db, 'goal-1');
    seedAssembly(db, 'asm-1', 'goal-1', 'running');

    reconcileStaleAssemblies(db, bus, NOW);

    const events = db
      .prepare("SELECT type, goal_id, payload FROM events WHERE type = 'context.assembly.failed'")
      .all() as { type: string; goal_id: string; payload: string }[];

    expect(events).toHaveLength(1);
    expect(events[0]!.goal_id).toBe('goal-1');
    const p = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(p['failureCode']).toBe('daemon_restart');
  });

  it('is wired after session and extraction reconcilers and before HTTP listen', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');

    const migrations = source.indexOf('runMigrations(db, migrationsDir)');
    const sessionReconciler = source.indexOf('reconcileSessionsOnBoot(db, eventBus, bootNow)');
    const extractionReconciler = source.indexOf('reconcileStaleExtractions(db, eventBus, bootNow)');
    const assemblyReconciler = source.indexOf('reconcileStaleAssemblies(db, eventBus, bootNow)');
    const listen = source.indexOf('await server.listen');

    expect(migrations).toBeGreaterThanOrEqual(0);
    expect(sessionReconciler).toBeGreaterThan(migrations);
    expect(extractionReconciler).toBeGreaterThan(sessionReconciler);
    expect(assemblyReconciler).toBeGreaterThan(extractionReconciler);
    expect(listen).toBeGreaterThan(assemblyReconciler);
  });

  it('works across multiple goals', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');
    seedAssembly(db, 'asm-g1', 'goal-1', 'pending');
    seedAssembly(db, 'asm-g2', 'goal-2', 'running');

    reconcileStaleAssemblies(db, bus, NOW);

    expect(published).toHaveLength(2);
    const goalIds = published.map((e) => e.goalId).sort();
    expect(goalIds).toEqual(['goal-1', 'goal-2']);
    expect(getAssemblyRow(db, 'asm-g1')!.status).toBe('failed');
    expect(getAssemblyRow(db, 'asm-g2')!.status).toBe('failed');
  });
});
