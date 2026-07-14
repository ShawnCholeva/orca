import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent, SessionExtractionOutput, SessionOutputSnapshot } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertSession, setSessionStatus } from '../sessions/projection.js';
import type { SessionOutputStore } from '../sessions/output-store.js';
import {
  getExtractionById,
  insertExtraction,
  listPendingExtractions,
  resetPreparedStatements as resetProjectionStmts,
} from './projection.js';
import {
  resetPreparedStatements as resetUsecasesStmts,
} from './usecases.js';
import {
  resetPreparedStatements as resetCommitStmts,
} from './commit.js';
import { ExtractionRunner } from './runner.js';
import { FakeExtractor } from './fake-extractor.js';
import { reconcileStaleExtractions } from './reconciliation.js';
import { resetPreparedStatements as resetMemoryStmts } from '../memory/projection.js';
import { resetPreparedStatements as resetDecisionStmts } from '../decisions/projection.js';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-runner-'));
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

function seedWorkspace(db: Database.Database, wsId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, '/tmp/ws', 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, wsId, '2026-01-01T00:00:00.000Z');
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  wsId: string,
  status: 'exited' | 'failed' | 'stopped' = 'exited'
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
  setSessionStatus(db, sessionId, status, {
    exitCode: status === 'exited' ? 0 : 1,
    exitedAt: '2026-01-01T00:01:00.000Z',
  });
}

function makeFakeOutputStore(
  snapshot: Partial<SessionOutputSnapshot> = {}
): SessionOutputStore {
  const defaultSnapshot: SessionOutputSnapshot = {
    sessionId: 'session-1',
    firstByteOffset: 0,
    nextSeq: 0,
    totalBytesKept: 0,
    chunks: [],
    ...snapshot,
  };
  return {
    appendChunk: () => ({ seq: 0, byteOffset: 0 }),
    readTail: () => defaultSnapshot,
  };
}

function seedPendingExtraction(
  db: Database.Database,
  id: string,
  goalId: string,
  sessionId: string
): void {
  const now = '2026-01-01T00:00:00.000Z';
  insertExtraction(db, {
    id,
    goalId,
    sessionId,
    trigger: 'terminal_state',
    status: 'pending',
    extractorVersion: 'fake-1.0.0',
    sourceFingerprint: `fp-${id}`,
    sourceOffsetFirst: 0,
    sourceOffsetLast: 0,
    summaryId: null,
    itemCount: 0,
    decisionCount: 0,
    promotedCount: 0,
    failureCode: null,
    failureMessage: null,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
  });
}

const EMPTY_OUTPUT: SessionExtractionOutput = {
  memoryCandidates: [],
  decisionCandidates: [],
};

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  resetUsecasesStmts();
  resetCommitStmts();
  resetMemoryStmts();
  resetDecisionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
      } else {
        setTimeout(check, 20);
      }
    };
    setTimeout(check, 0);
  });
}

describe('ExtractionRunner', () => {
  it('processes a pending extraction to succeeded', async () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const extractor = new FakeExtractor();
    extractor.setOutput('session-1', EMPTY_OUTPUT);

    const goalId = 'goal-1';
    const sessionId = 'session-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);
    seedSession(db, sessionId, goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-1', goalId, sessionId);

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: makeFakeOutputStore({ sessionId }),
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => {
      const ext = getExtractionById(db, 'ext-1');
      return ext?.status === 'succeeded';
    });

    const ext = getExtractionById(db, 'ext-1')!;
    expect(ext.status).toBe('succeeded');
    expect(bus.captured.some((e) => e.type === 'memory.extraction.completed')).toBe(true);

    runner.stop();
  });

  it('processes multiple pending extractions serially and stops cleanly', async () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const extractor = new FakeExtractor();

    const goalId = 'goal-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);

    for (const sid of ['s1', 's2', 's3']) {
      extractor.setOutput(sid, EMPTY_OUTPUT);
      seedSession(db, sid, goalId, wsId, 'exited');
      seedPendingExtraction(db, `ext-${sid}`, goalId, sid);
    }

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: {
        appendChunk: () => ({ seq: 0, byteOffset: 0 }),
        readTail: (sid) => ({
          sessionId: sid,
          firstByteOffset: 0,
          nextSeq: 0,
          totalBytesKept: 0,
          chunks: [],
        }),
      },
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => {
      const pending = listPendingExtractions(db);
      return pending.length === 0;
    });

    const completedEvents = bus.captured.filter((e) => e.type === 'memory.extraction.completed');
    expect(completedEvents).toHaveLength(3);

    runner.stop();
  });

  it('commits failure with timeout when extractor exceeds timeout', async () => {
    const db = openTestDb();
    const bus = new SpyBus();

    const goalId = 'goal-1';
    const sessionId = 'session-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);
    seedSession(db, sessionId, goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-1', goalId, sessionId);

    const slowExtractor = {
      version: 'slow-1.0.0',
      extract: () => new Promise<SessionExtractionOutput>((resolve) => setTimeout(resolve, 10000)),
    };

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: makeFakeOutputStore({ sessionId }),
      extractor: slowExtractor,
      config: { memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 50 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => {
      const ext = getExtractionById(db, 'ext-1');
      return ext?.status === 'failed';
    }, 3000);

    const ext = getExtractionById(db, 'ext-1')!;
    expect(ext.status).toBe('failed');
    expect(ext.failureCode).toBe('timeout');
    expect(bus.captured.some((e) => e.type === 'memory.extraction.failed')).toBe(true);

    runner.stop();
  });

  it('commits failure with invalid_output when extractor returns bad schema', async () => {
    const db = openTestDb();
    const bus = new SpyBus();

    const goalId = 'goal-1';
    const sessionId = 'session-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);
    seedSession(db, sessionId, goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-1', goalId, sessionId);

    const badExtractor = {
      version: 'bad-1.0.0',
      extract: () => Promise.resolve({ memoryCandidates: 'not-an-array' } as unknown as SessionExtractionOutput),
    };

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: makeFakeOutputStore({ sessionId }),
      extractor: badExtractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => {
      const ext = getExtractionById(db, 'ext-1');
      return ext?.status === 'failed';
    });

    const ext = getExtractionById(db, 'ext-1')!;
    expect(ext.status).toBe('failed');
    expect(ext.failureCode).toBe('invalid_output');

    runner.stop();
  });

  it('continues processing queue after a single extractor failure', async () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const extractor = new FakeExtractor();

    const goalId = 'goal-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);

    seedSession(db, 's-fail', goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-fail', goalId, 's-fail');
    extractor.setError('s-fail', 'boom');

    seedSession(db, 's-ok', goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-ok', goalId, 's-ok');
    extractor.setOutput('s-ok', EMPTY_OUTPUT);

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: {
        appendChunk: () => ({ seq: 0, byteOffset: 0 }),
        readTail: (sid) => ({
          sessionId: sid,
          firstByteOffset: 0,
          nextSeq: 0,
          totalBytesKept: 0,
          chunks: [],
        }),
      },
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => {
      const fail = getExtractionById(db, 'ext-fail');
      const ok = getExtractionById(db, 'ext-ok');
      return fail?.status === 'failed' && ok?.status === 'succeeded';
    });

    expect(getExtractionById(db, 'ext-fail')!.status).toBe('failed');
    expect(getExtractionById(db, 'ext-ok')!.status).toBe('succeeded');

    runner.stop();
  });

  it('does not pick up reconciled-failed rows after restart', async () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const extractor = new FakeExtractor();

    const goalId = 'goal-1';
    const sessionId = 'session-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);
    seedSession(db, sessionId, goalId, wsId, 'exited');
    seedPendingExtraction(db, 'ext-1', goalId, sessionId);

    const now = '2026-01-01T12:00:00.000Z';
    reconcileStaleExtractions(db, bus, now);

    const ext = getExtractionById(db, 'ext-1')!;
    expect(ext.status).toBe('failed');
    expect(ext.failureCode).toBe('daemon_restart');

    const capturedBefore = bus.captured.length;

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: makeFakeOutputStore({ sessionId }),
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitMs(200);

    expect(getExtractionById(db, 'ext-1')!.status).toBe('failed');
    expect(bus.captured.length).toBe(capturedBefore);

    runner.stop();
  });

  it('stop() halts the loop without leaving rows stuck', async () => {
    const db = openTestDb();
    const bus = new SpyBus();
    const extractor = new FakeExtractor();

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: makeFakeOutputStore(),
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.stop();

    await waitMs(150);

    const pending = listPendingExtractions(db);
    expect(pending).toHaveLength(0);
  });
});
