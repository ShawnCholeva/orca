import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent, SessionOutputSnapshot } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertSession, setSessionStatus } from '../sessions/projection.js';
import type { SessionOutputStore } from '../sessions/output-store.js';
import {
  listPendingExtractions,
  resetPreparedStatements as resetProjectionStmts,
} from './projection.js';
import { resetPreparedStatements as resetUsecasesStmts } from './usecases.js';
import { resetPreparedStatements as resetCommitStmts } from './commit.js';
import { resetPreparedStatements as resetMemoryStmts } from '../memory/projection.js';
import { resetPreparedStatements as resetDecisionStmts } from '../decisions/projection.js';
import { resetPreparedStatements as resetRefinementSeedStmts } from '../memory/refinement-seed.js';
import { enqueueEligibleForGoal } from './goal-open.js';
import type { ExtractionRunner } from './runner.js';

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-goal-open-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): string {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
  return goalId;
}

function seedWorkspace(db: Database.Database, wsId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, `/tmp/ws/${wsId}`, 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, wsId, '2026-01-01T00:00:00.000Z');
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  wsId: string,
  status: 'created' | 'running' | 'exited' | 'failed' | 'stopped' = 'exited'
): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId: wsId,
    adapterId: 'claude-code',
    title: sessionId,
    status: 'created',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  if (status !== 'created') {
    const terminalStatuses = ['exited', 'failed', 'stopped'];
    if (terminalStatuses.includes(status)) {
      setSessionStatus(db, sessionId, status as 'exited' | 'failed' | 'stopped', {
        exitCode: status === 'exited' ? 0 : 1,
        exitedAt: '2026-01-01T00:01:00.000Z',
      });
    }
  }
}

function makeEmptyOutputStore(): SessionOutputStore {
  const emptySnapshot = (sessionId: string): SessionOutputSnapshot => ({
    sessionId,
    firstByteOffset: 0,
    nextSeq: 0,
    totalBytesKept: 0,
    chunks: [],
  });
  return {
    appendChunk: () => ({ seq: 0, byteOffset: 0 }),
    readTail: emptySnapshot,
  };
}

function makeRunner(notifyFn?: () => void): ExtractionRunner {
  return {
    notify: notifyFn ?? (() => {}),
    start: () => {},
    stop: () => {},
  } as unknown as ExtractionRunner;
}

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  resetUsecasesStmts();
  resetCommitStmts();
  resetMemoryStmts();
  resetDecisionStmts();
  resetRefinementSeedStmts();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('enqueueEligibleForGoal', () => {
  it('enqueues terminal sessions belonging to the opened Goal', () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const notifySpy = vi.fn();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 's1', 'goal-1', 'ws-1', 'exited');
    seedSession(db, 's2', 'goal-1', 'ws-1', 'stopped');

    enqueueEligibleForGoal(
      { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner(notifySpy) },
      'goal-1'
    );

    const pending = listPendingExtractions(db);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.sessionId).sort()).toEqual(['s1', 's2'].sort());
    expect(notifySpy).toHaveBeenCalledOnce();
  });

  it('does not enqueue non-terminal sessions', () => {
    const db = openTestDb();
    const bus = new SpyBus();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 's-created', 'goal-1', 'ws-1', 'created');
    seedSession(db, 's-running', 'goal-1', 'ws-1', 'created');
    // leave s-running as created (can't set to running without PTY)

    enqueueEligibleForGoal(
      { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner() },
      'goal-1'
    );

    expect(listPendingExtractions(db)).toHaveLength(0);
  });

  it('does not enqueue sessions belonging to other Goals', () => {
    const db = openTestDb();
    const bus = new SpyBus();

    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedWorkspace(db, 'ws-2', 'goal-2');
    seedSession(db, 's1', 'goal-1', 'ws-1', 'exited');
    seedSession(db, 's2', 'goal-2', 'ws-2', 'exited');

    enqueueEligibleForGoal(
      { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner() },
      'goal-1'
    );

    const pending = listPendingExtractions(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sessionId).toBe('s1');
    expect(pending[0]!.goalId).toBe('goal-1');
  });

  it('double call with same fingerprint enqueues once (idempotent)', () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const notifySpy = vi.fn();

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 's1', 'goal-1', 'ws-1', 'exited');

    const ctx = { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner(notifySpy) };

    enqueueEligibleForGoal(ctx, 'goal-1');
    enqueueEligibleForGoal(ctx, 'goal-1');

    // s1 has succeeded or pending extraction — second call returns existing, no new row
    const pending = listPendingExtractions(db);
    expect(pending.length).toBeLessThanOrEqual(1);
    // The first call enqueued exactly one pending row; second call sees it and skips
    expect(pending).toHaveLength(1);
    // Second call finds s1 already has a pending extraction, so no new row and no notify
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('does not notify runner when no sessions are eligible', () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const notifySpy = vi.fn();

    seedGoal(db, 'goal-1');

    enqueueEligibleForGoal(
      { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner(notifySpy) },
      'goal-1'
    );

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('seeds refinement memory for the Goal', () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const now = '2026-01-01T00:00:00.000Z';

    seedGoal(db, 'goal-1');
    db.prepare(
      `INSERT INTO goal_refinements
       (goal_id, skill_id, constraints, success_criteria, assumptions, refined_at)
       VALUES (?, 'guided-goal-refinement', ?, ?, '[]', ?)`
    ).run('goal-1', JSON.stringify(['no side effects']), JSON.stringify(['all tests pass']), now);

    enqueueEligibleForGoal(
      { db, bus, outputStore: makeEmptyOutputStore(), runner: makeRunner() },
      'goal-1'
    );

    const memItems = db.prepare(`SELECT * FROM goal_memory_items WHERE goal_id = ?`).all('goal-1') as unknown[];
    expect(memItems.length).toBeGreaterThan(0);
    const createdEvents = bus.captured.filter((e) => e.type === 'memory.item.created');
    expect(createdEvents.length).toBeGreaterThan(0);
  });
});
