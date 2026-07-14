import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertSession, setSessionStatus } from '../sessions/projection.js';
import type { SessionOutputStore } from '../sessions/output-store.js';
import { getExtractionById, insertExtraction, resetPreparedStatements as resetProjectionStmts } from './projection.js';
import { resetPreparedStatements as resetUsecasesStmts } from './usecases.js';
import { resetPreparedStatements as resetMemoryStmts } from '../memory/projection.js';
import { resetPreparedStatements as resetDecisionStmts } from '../decisions/projection.js';
import { FakeExtractor } from './fake-extractor.js';

vi.mock('./commit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commit.js')>();
  return {
    ...actual,
    commitExtractionResult: vi.fn(() => {
      throw new Error('forced commit failure');
    }),
    commitExtractionFailure: vi.fn(actual.commitExtractionFailure),
  };
});

const { ExtractionRunner } = await import('./runner.js');
const commitModule = await import('./commit.js');
const commitExtractionFailureMock = vi.mocked(commitModule.commitExtractionFailure);

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-runner-commit-failure-'));
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

function seedSession(db: Database.Database, sessionId: string, goalId: string, wsId: string): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId: wsId,
    adapterId: 'claude-code',
    title: sessionId,
    status: 'created',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  setSessionStatus(db, sessionId, 'exited', {
    exitCode: 0,
    exitedAt: '2026-01-01T00:01:00.000Z',
  });
}

function seedPendingExtraction(db: Database.Database, id: string, goalId: string, sessionId: string): void {
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
    requestedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  });
}

function outputStore(sessionId: string): SessionOutputStore {
  return {
    appendChunk: () => ({ seq: 0, byteOffset: 0 }),
    readTail: () => ({
      sessionId,
      firstByteOffset: 0,
      nextSeq: 0,
      totalBytesKept: 0,
      chunks: [],
    }),
  };
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

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  resetUsecasesStmts();
  resetMemoryStmts();
  resetDecisionStmts();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ExtractionRunner commit failure handling', () => {
  it('marks a running extraction failed when commitExtractionResult throws', async () => {
    const db = openTestDb();
    const bus = new EventBus();
    const extractor = new FakeExtractor();

    const goalId = 'goal-1';
    const sessionId = 'session-1';
    const wsId = 'ws-1';
    seedGoal(db, goalId);
    seedWorkspace(db, wsId, goalId);
    seedSession(db, sessionId, goalId, wsId);
    seedPendingExtraction(db, 'ext-1', goalId, sessionId);
    extractor.setOutput(sessionId, { memoryCandidates: [], decisionCandidates: [] });

    const runner = new ExtractionRunner({
      db,
      bus,
      outputStore: outputStore(sessionId),
      extractor,
      config: { memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 5000 },
    });

    runner.start();
    runner.notify();

    await waitFor(() => getExtractionById(db, 'ext-1')?.status === 'failed');

    expect(commitExtractionFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ db, bus }),
      'ext-1',
      { failureCode: 'internal_error', failureMessage: null }
    );
    expect(getExtractionById(db, 'ext-1')).toMatchObject({
      status: 'failed',
      failureCode: 'internal_error',
    });

    runner.stop();
  });
});
