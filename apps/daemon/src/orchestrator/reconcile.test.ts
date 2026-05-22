import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS } from '@orca/contracts';
import { createDaemonContext } from '../daemon-context.js';
import { subscribeOrchestrationTriggers } from './triggers.js';
import { resetRunnerState } from './runner.js';
import { reconcileInFlightGenerations } from './reconcile.js';
import { resetPreparedStatements as resetTaskStmts } from '../tasks/projection.js';
import { resetPreparedStatements as resetRecStmts } from '../recommendations/projection.js';
import { resetPreparedStatements as resetConflictStmts } from '../conflicts/projection.js';
import { resetPreparedStatements as resetTriggerStmts } from './triggers.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T12:00:00.000Z';

function createConfig(dataDir: string, port = 8787): Config {
  return {
    dataDir,
    port,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-orch-reconcile-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, NOW, NOW);
}

function insertTaskGeneration(db: Database.Database, id: string, goalId: string, status: 'pending' | 'running' | 'succeeded' | 'failed'): void {
  db.prepare(
    `INSERT INTO task_generations
      (id, goal_id, trigger, trigger_source_id, generator_id, generator_version,
       input_fingerprint, request_fingerprint, status, failure_code, failure_message,
       task_ids_json, sparse, requested_at, started_at, finished_at)
     VALUES (?, ?, 'manual', null, 'det-task', 'v1', 'ifp', ?, ?, null, null, ?, 0, ?, ?, ?)`
  ).run(
    id,
    goalId,
    `req-${id}`,
    status,
    status === 'succeeded' ? '["task-1"]' : '[]',
    NOW,
    status === 'pending' ? null : NOW,
    status === 'pending' || status === 'running' ? null : NOW
  );
}

function insertRecommendationGeneration(
  db: Database.Database,
  id: string,
  goalId: string,
  status: 'pending' | 'running' | 'succeeded' | 'failed'
): void {
  db.prepare(
    `INSERT INTO recommendation_generations
      (id, goal_id, trigger, trigger_source_id, provider_id, provider_version,
       input_fingerprint, request_fingerprint, status, failure_code, failure_message,
       recommendation_ids_json, superseded_ids_json, sparse, requested_at, started_at, finished_at)
     VALUES (?, ?, 'manual', null, 'det-rec', 'v1', 'ifp', ?, ?, null, null, ?, '[]', 0, ?, ?, ?)`
  ).run(
    id,
    goalId,
    `req-${id}`,
    status,
    status === 'succeeded' ? '["rec-1"]' : '[]',
    NOW,
    status === 'pending' ? null : NOW,
    status === 'pending' || status === 'running' ? null : NOW
  );
}

function insertTask(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO tasks
      (id, goal_id, parent_task_id, workspace_id, role, status, origin, title, description,
       acceptance_criteria_json, validation_steps_json, dependencies_json, sources_json,
       generation_id, fingerprint, created_at, updated_at, archived_at)
     VALUES (?, ?, null, null, 'engineer', 'open', 'user', 'Keep me', 'stable', '[]', '[]', '[]', '[]', null, ?, ?, ?, null)`
  ).run(id, goalId, `fp-${id}`, NOW, NOW);
}

function insertRecommendation(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO recommendations
      (id, goal_id, generation_id, type, status, source, title, rationale, proposed_action_json,
       confidence, sources_json, related_task_id, related_session_id, related_context_pkg_id,
       related_conflict_id, fingerprint, superseded_by_id, superseded_reason, created_at, updated_at, resolved_at)
     VALUES (?, ?, null, 'ask_user', 'proposed', 'deterministic_provider', 'Keep me', 'stable', '{}',
             0.5, '[]', null, null, null, null, ?, null, null, ?, ?, null)`
  ).run(id, goalId, `fp-${id}`, NOW, NOW);
}

function insertConflict(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO conflicts
      (id, goal_id, conflict_type, severity, status, title, description, sources_json,
       fingerprint, resolution_note, detected_at, resolved_at)
     VALUES (?, ?, 'blocker_reported', 'warning', 'open', 'Keep me', 'stable', '[]', ?, null, ?, null)`
  ).run(id, goalId, `fp-${id}`, NOW);
}

function listFailureEvents(db: Database.Database): Array<{
  seq: number;
  type: string;
  goal_id: string;
  payload: string;
  created_at: string;
}> {
  return db
    .prepare(
      `SELECT seq, type, goal_id, payload, created_at
       FROM events
       WHERE type IN ('task.generation.failed', 'recommendation.generation.failed')
       ORDER BY seq ASC`
    )
    .all() as Array<{ seq: number; type: string; goal_id: string; payload: string; created_at: string }>;
}

function waitForEvent(
  bus: EventBus,
  predicate: (event: DomainEvent) => boolean,
  timeoutMs = 2000
): Promise<DomainEvent> {
  return new Promise<DomainEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForEvent timeout')), timeoutMs);
    const unsubscribe = bus.subscribe((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

afterEach(() => {
  closeDatabase();
  resetRunnerState();
  resetTaskStmts();
  resetRecStmts();
  resetConflictStmts();
  resetTriggerStmts();
  vi.resetModules();
  vi.unmock('./reconcile.js');

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileInFlightGenerations', () => {
  it('fails stale generation rows and emits content-free failure events without touching persisted task/recommendation/conflict rows', async () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    insertTaskGeneration(db, 'tg-pending', 'goal-1', 'pending');
    insertTaskGeneration(db, 'tg-running', 'goal-1', 'running');
    insertTaskGeneration(db, 'tg-succeeded', 'goal-1', 'succeeded');
    insertTaskGeneration(db, 'tg-failed', 'goal-1', 'failed');

    insertRecommendationGeneration(db, 'rg-pending', 'goal-1', 'pending');
    insertRecommendationGeneration(db, 'rg-running', 'goal-1', 'running');
    insertRecommendationGeneration(db, 'rg-succeeded', 'goal-1', 'succeeded');
    insertRecommendationGeneration(db, 'rg-failed', 'goal-1', 'failed');

    insertTask(db, 'task-1', 'goal-1');
    insertRecommendation(db, 'rec-1', 'goal-1');
    insertConflict(db, 'conf-1', 'goal-1');

    let eventSeq = 0;
    await reconcileInFlightGenerations(db, {
      now: NOW,
      idFactory: () => `evt-fixed-${++eventSeq}`,
    });

    const tgPending = db.prepare('SELECT status, failure_code, failure_message, finished_at FROM task_generations WHERE id = ?').get('tg-pending') as Record<string, string | null>;
    const tgRunning = db.prepare('SELECT status, failure_code, failure_message, finished_at FROM task_generations WHERE id = ?').get('tg-running') as Record<string, string | null>;
    const tgSucceeded = db.prepare('SELECT status, failure_code FROM task_generations WHERE id = ?').get('tg-succeeded') as Record<string, string | null>;

    expect(tgPending.status).toBe('failed');
    expect(tgPending.failure_code).toBe('daemon_restart');
    expect(tgPending.failure_message).toBe('reconciled at boot');
    expect(tgPending.finished_at).toBe(NOW);

    expect(tgRunning.status).toBe('failed');
    expect(tgRunning.failure_code).toBe('daemon_restart');
    expect(tgRunning.failure_message).toBe('reconciled at boot');
    expect(tgRunning.finished_at).toBe(NOW);

    expect(tgSucceeded.status).toBe('succeeded');
    expect(tgSucceeded.failure_code).toBeNull();

    const rgPending = db.prepare('SELECT status, failure_code, failure_message, finished_at FROM recommendation_generations WHERE id = ?').get('rg-pending') as Record<string, string | null>;
    const rgRunning = db.prepare('SELECT status, failure_code, failure_message, finished_at FROM recommendation_generations WHERE id = ?').get('rg-running') as Record<string, string | null>;
    const rgSucceeded = db.prepare('SELECT status, failure_code FROM recommendation_generations WHERE id = ?').get('rg-succeeded') as Record<string, string | null>;

    expect(rgPending.status).toBe('failed');
    expect(rgPending.failure_code).toBe('daemon_restart');
    expect(rgPending.failure_message).toBe('reconciled at boot');
    expect(rgPending.finished_at).toBe(NOW);

    expect(rgRunning.status).toBe('failed');
    expect(rgRunning.failure_code).toBe('daemon_restart');
    expect(rgRunning.failure_message).toBe('reconciled at boot');
    expect(rgRunning.finished_at).toBe(NOW);

    expect(rgSucceeded.status).toBe('succeeded');
    expect(rgSucceeded.failure_code).toBeNull();

    const taskRow = db.prepare('SELECT title, status FROM tasks WHERE id = ?').get('task-1') as { title: string; status: string };
    const recRow = db.prepare('SELECT title, status FROM recommendations WHERE id = ?').get('rec-1') as { title: string; status: string };
    const conflictRow = db.prepare('SELECT title, status FROM conflicts WHERE id = ?').get('conf-1') as { title: string; status: string };

    expect(taskRow).toEqual({ title: 'Keep me', status: 'open' });
    expect(recRow).toEqual({ title: 'Keep me', status: 'proposed' });
    expect(conflictRow).toEqual({ title: 'Keep me', status: 'open' });

    const events = listFailureEvents(db);
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event.created_at).toBe(NOW);
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      expect(payload.failureCode).toBe('daemon_restart');
      expect(payload.goalId).toBe('goal-1');
      expect(payload).not.toHaveProperty('failureMessage');
      expect(Object.keys(payload).sort()).toEqual(['failureCode', 'generationId', 'goalId']);
    }

    expect((tgPending.failure_message ?? '').length).toBeLessThanOrEqual(
      ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS
    );
  });

  it('is idempotent on repeated calls', async () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    insertTaskGeneration(db, 'tg-pending', 'goal-1', 'pending');
    insertRecommendationGeneration(db, 'rg-pending', 'goal-1', 'pending');

    await reconcileInFlightGenerations(db, { now: NOW });
    await reconcileInFlightGenerations(db, { now: '2026-01-02T00:00:00.000Z' });

    const events = listFailureEvents(db);
    expect(events).toHaveLength(2);

    const tg = db.prepare('SELECT status, finished_at FROM task_generations WHERE id = ?').get('tg-pending') as { status: string; finished_at: string };
    const rg = db.prepare('SELECT status, finished_at FROM recommendation_generations WHERE id = ?').get('rg-pending') as { status: string; finished_at: string };

    expect(tg.status).toBe('failed');
    expect(tg.finished_at).toBe(NOW);
    expect(rg.status).toBe('failed');
    expect(rg.finished_at).toBe(NOW);
  });

  it('reconciles stale rows after DB reopen and persists failure events before trigger subscriber emits new orchestration events', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-orch-restart-'));
    tempDirs.push(dir);
    const config = createConfig(dir);

    const firstDb = openDatabase(config);
    runMigrations(firstDb, defaultMigrationsDir());
    seedGoal(firstDb, 'goal-1');
    insertTaskGeneration(firstDb, 'tg-pending', 'goal-1', 'pending');
    insertRecommendationGeneration(firstDb, 'rg-pending', 'goal-1', 'pending');
    closeDatabase();

    const reopenedDb = openDatabase(config);
    runMigrations(reopenedDb, defaultMigrationsDir());

    await reconcileInFlightGenerations(reopenedDb, { now: NOW });

    const failedEvents = listFailureEvents(reopenedDb);
    expect(failedEvents).toHaveLength(2);
    const maxFailureSeq = failedEvents[failedEvents.length - 1]!.seq;

    const bus = new EventBus();
    const ctx = createDaemonContext(reopenedDb, bus);
    const unsubscribe = subscribeOrchestrationTriggers(ctx);

    const done = waitForEvent(
      bus,
      (event) =>
        event.type === 'task.generation.requested' ||
        event.type === 'recommendation.generation.requested'
    );

    bus.publish({
      seq: maxFailureSeq + 1,
      id: 'src-goal-refined',
      type: 'goal.refined',
      goalId: 'goal-1',
      payload: { goalId: 'goal-1', refinementId: 'ref-1' },
      createdAt: NOW,
    });

    const emitted = await done;
    expect(emitted.seq).toBeGreaterThan(maxFailureSeq);

    unsubscribe();
  });

  it('keeps HTTP unavailable until boot reconciliation completes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-orch-http-gate-'));
    tempDirs.push(dir);
    const port = await reservePort();

    const prevDataDir = process.env.ORCA_DATA_DIR;
    const prevPort = process.env.ORCA_PORT;
    const prevToken = process.env.ORCA_TOKEN;
    const prevLog = process.env.ORCA_LOG_LEVEL;

    process.env.ORCA_DATA_DIR = dir;
    process.env.ORCA_PORT = String(port);
    process.env.ORCA_TOKEN = 'test-token';
    process.env.ORCA_LOG_LEVEL = 'silent';

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.resetModules();
    vi.doMock('./reconcile.js', () => ({
      reconcileInFlightGenerations: vi.fn(async () => {
        await gate;
      }),
    }));

    try {
      const module = await import('../index.js');
      const startPromise = module.startDaemon();

      await expect(
        fetch(`http://127.0.0.1:${port}/v1/health`, {
          signal: AbortSignal.timeout(300),
        })
      ).rejects.toThrow();

      release();
      const handles = await startPromise;

      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(200);

      await handles.close();
    } finally {
      process.env.ORCA_DATA_DIR = prevDataDir;
      process.env.ORCA_PORT = prevPort;
      process.env.ORCA_TOKEN = prevToken;
      process.env.ORCA_LOG_LEVEL = prevLog;
    }
  });
});
