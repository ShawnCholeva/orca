import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import {
  runGeneration,
  setGoalReEvaluator,
  resetRunnerState,
  SchemaValidationError,
  type RunGenerationCtx,
  type RunTaskGenerationOpts,
  type RunRecommendationGenerationOpts,
} from './runner.js';
import { getTaskGenerationById, resetPreparedStatements as resetTaskStmts } from '../tasks/projection.js';
import { getRecommendationGenerationById, resetPreparedStatements as resetRecStmts } from '../recommendations/projection.js';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-runner-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, now, now);
}

afterEach(() => {
  closeDatabase();
  resetRunnerState();
  resetTaskStmts();
  resetRecStmts();
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

let _seq = 0;
function makeCtx(db: Database.Database, bus: EventBus): RunGenerationCtx {
  return {
    db, bus,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, _seq++)).toISOString(),
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
  };
}

function baseTaskOpts(
  ctx: RunGenerationCtx,
  execute: RunTaskGenerationOpts['execute'] = async () => ({ taskIds: [], sparse: false })
): RunTaskGenerationOpts {
  return {
    kind: 'task',
    goalId: 'goal-1',
    trigger: 'manual',
    triggerSourceId: null,
    providerId: 'orca/deterministic-task-generator',
    providerVersion: '0.1.0',
    inputFingerprint: 'ifp-001',
    ctx,
    execute,
  };
}

function baseRecOpts(
  ctx: RunGenerationCtx,
  execute: RunRecommendationGenerationOpts['execute'] = async () => ({
    recommendationIds: [], supersededIds: [], sparse: false,
  })
): RunRecommendationGenerationOpts {
  return {
    kind: 'recommendation',
    goalId: 'goal-1',
    trigger: 'manual',
    triggerSourceId: null,
    providerId: 'orca/deterministic-recommendation-provider',
    providerVersion: '0.1.0',
    inputFingerprint: 'ifp-001',
    ctx,
    execute,
  };
}

// ── Task generation tests ─────────────────────────────────────────────────────

describe('runGeneration (task)', () => {
  it('inserts new pending generation and emits requested event', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const result = await runGeneration(baseTaskOpts(ctx));
    // Wait for async execution to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(result.isNew).toBe(true);
    expect(result.dirtyQueued).toBe(false);
    expect(result.generationId).toBeTruthy();

    const gen = getTaskGenerationById(db, result.generationId as string);
    expect(gen).toBeTruthy();

    const requestedEvs = published.filter((e) => e.type === 'task.generation.requested');
    expect(requestedEvs).toHaveLength(1);
    expect(requestedEvs[0].payload.generationId).toBe(result.generationId);
    expect(requestedEvs[0].payload.goalId).toBe('goal-1');
  });

  it('returns existing row on duplicate submit (idempotency)', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    // Allow first to complete before second
    await runGeneration(baseTaskOpts(ctx));
    await new Promise((r) => setTimeout(r, 20));

    const result2 = await runGeneration(baseTaskOpts(ctx));
    await new Promise((r) => setTimeout(r, 20));

    // Same fingerprint → existing succeeded row returned, no new row
    const rows = db.prepare('SELECT * FROM task_generations WHERE goal_id = ?').all('goal-1') as unknown[];
    expect(rows).toHaveLength(1);
    expect(result2.isNew).toBe(false);
    expect(result2.dirtyQueued).toBe(false);
  });

  it('concurrent double-submit returns exactly one new row', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const opts = baseTaskOpts(ctx, async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { taskIds: [], sparse: false };
    });

    const [r1, r2] = await Promise.all([runGeneration(opts), runGeneration(opts)]);
    await new Promise((r) => setTimeout(r, 50));

    // One new, one dirty_queued (or the same row returned)
    const rows = db.prepare('SELECT * FROM task_generations WHERE goal_id = ?').all('goal-1') as unknown[];
    expect(rows.length).toBeLessThanOrEqual(1);
    expect([r1.isNew, r2.isNew].filter(Boolean)).toHaveLength(1);
  });

  it('marks generation failed with provider_error when execute throws', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const opts = baseTaskOpts(ctx, async () => {
      throw new Error('something went wrong');
    });

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getTaskGenerationById(db, result.generationId as string);
    expect(gen?.status).toBe('failed');
    expect(gen?.failureCode).toBe('provider_error');
    expect(gen?.failureMessage).toBeTruthy();
    expect(gen?.failureMessage!.length).toBeLessThanOrEqual(256);

    const failEvs = published.filter((e) => e.type === 'task.generation.failed');
    expect(failEvs).toHaveLength(1);
    expect(failEvs[0].payload.failureCode).toBe('provider_error');
    expect(failEvs[0].payload).not.toHaveProperty('failureMessage');
  });

  it('marks generation failed with invalid_output for SchemaValidationError', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const opts = baseTaskOpts(ctx, async () => {
      throw new SchemaValidationError('bad output shape');
    });

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getTaskGenerationById(db, result.generationId as string);
    expect(gen?.failureCode).toBe('invalid_output');
  });

  it('retry after failure creates a new generation row', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const failOpts = baseTaskOpts(ctx, async () => { throw new Error('fail'); });

    const r1 = await runGeneration(failOpts);
    await new Promise((r) => setTimeout(r, 30));

    const gen1 = getTaskGenerationById(db, r1.generationId as string);
    expect(gen1?.status).toBe('failed');

    // Retry with same fingerprint — failed row excluded from active idempotency
    const r2 = await runGeneration(baseTaskOpts(ctx));
    await new Promise((r) => setTimeout(r, 30));

    expect(r2.isNew).toBe(true);
    expect(r2.generationId).not.toBe(r1.generationId);

    const rows = db
      .prepare('SELECT * FROM task_generations WHERE goal_id = ?')
      .all('goal-1') as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('failure message is redacted and capped to 256 chars', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const longMsg = 'token=supersecret ' + 'x'.repeat(300);
    const opts = baseTaskOpts(ctx, async () => { throw new Error(longMsg); });

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getTaskGenerationById(db, result.generationId as string);
    expect(gen?.failureMessage).not.toBeNull();
    expect(gen!.failureMessage!.length).toBeLessThanOrEqual(256);
    expect(gen!.failureMessage).not.toContain('supersecret');
  });

  it('marks generation succeeded with task.generated event', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const taskIds = ['t-1', 't-2'];
    const opts = baseTaskOpts(ctx, async () => ({ taskIds, sparse: false }));

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getTaskGenerationById(db, result.generationId as string);
    expect(gen?.status).toBe('succeeded');

    const genEvs = published.filter((e) => e.type === 'task.generated');
    expect(genEvs).toHaveLength(1);
    expect(genEvs[0].payload.taskIds).toEqual(taskIds);
    expect(genEvs[0].payload.count).toBe(2);
    expect(genEvs[0].payload.sparse).toBe(false);
  });
});

// ── Recommendation generation tests ───────────────────────────────────────────

describe('runGeneration (recommendation)', () => {
  it('inserts new pending generation and emits requested event', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const result = await runGeneration(baseRecOpts(ctx));
    await new Promise((r) => setTimeout(r, 20));

    expect(result.isNew).toBe(true);

    const requestedEvs = published.filter((e) => e.type === 'recommendation.generation.requested');
    expect(requestedEvs).toHaveLength(1);

    const failEvs = published.filter((e) => e.type === 'recommendation.generation.failed');
    expect(failEvs).toHaveLength(0);
  });

  it('marks failed with provider_error when execute throws', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const opts = baseRecOpts(ctx, async () => { throw new Error('rec fail'); });

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getRecommendationGenerationById(db, result.generationId as string);
    expect(gen?.status).toBe('failed');
    expect(gen?.failureCode).toBe('provider_error');
  });

  it('retry after failure creates a new row', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const failOpts = baseRecOpts(ctx, async () => { throw new Error('fail'); });
    const r1 = await runGeneration(failOpts);
    await new Promise((r) => setTimeout(r, 20));

    const r2 = await runGeneration(baseRecOpts(ctx));
    await new Promise((r) => setTimeout(r, 20));

    expect(r2.isNew).toBe(true);
    expect(r2.generationId).not.toBe(r1.generationId);
  });

  it('marks succeeded with recommendation.generated event', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const recIds = ['r-1', 'r-2'];
    const opts = baseRecOpts(ctx, async () => ({
      recommendationIds: recIds,
      supersededIds: ['old-r-1'],
      sparse: false,
    }));

    const result = await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const gen = getRecommendationGenerationById(db, result.generationId as string);
    expect(gen?.status).toBe('succeeded');

    const genEvs = published.filter((e) => e.type === 'recommendation.generated');
    expect(genEvs).toHaveLength(1);
    expect(genEvs[0].payload.recommendationIds).toEqual(recIds);
    expect(genEvs[0].payload.supersededIds).toEqual(['old-r-1']);
  });
});

// ── Dirty-flag / single-flight tests ─────────────────────────────────────────

describe('single-flight and dirty-flag', () => {
  it('second concurrent trigger for same goal returns dirty_queued', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    let unblock: (() => void) | null = null;
    const slowExecute: RunTaskGenerationOpts['execute'] = async () => {
      await new Promise<void>((res) => { unblock = res; });
      return { taskIds: [], sparse: false };
    };

    const opts = baseTaskOpts(ctx, slowExecute);
    const r1Promise = runGeneration(opts);
    // Yield to let r1 start async execution
    await new Promise((r) => setTimeout(r, 5));

    const r2 = await runGeneration({ ...opts, inputFingerprint: 'ifp-002' });
    expect(r2.dirtyQueued).toBe(true);
    expect(r2.generationId).toBeNull();

    unblock!();
    await r1Promise;
    await new Promise((r) => setTimeout(r, 20));
  });

  it('dirty-flag triggers re-evaluation exactly once (not twice)', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    let reEvalCount = 0;
    let unblock: (() => void) | null = null;

    const slowExecute: RunTaskGenerationOpts['execute'] = async () => {
      await new Promise<void>((res) => { unblock = res; });
      return { taskIds: [], sparse: false };
    };

    // On re-evaluation, run a new generation with a different fingerprint
    setGoalReEvaluator((goalId) => {
      reEvalCount++;
      void runGeneration({
        ...baseTaskOpts(ctx),
        goalId,
        inputFingerprint: `re-eval-${reEvalCount}`,
      });
    });

    // First trigger: starts slow execution (pass slowExecute explicitly)
    const r1 = runGeneration(baseTaskOpts(ctx, slowExecute));
    // Give the IIFE time to start executing and call slowExecute (setting unblock)
    await new Promise((r) => setTimeout(r, 5));

    // Second trigger during execution → dirty
    await runGeneration({ ...baseTaskOpts(ctx), inputFingerprint: 'ifp-002' });
    // Third trigger during execution → dirty already set, no additional queuing
    await runGeneration({ ...baseTaskOpts(ctx), inputFingerprint: 'ifp-003' });

    unblock!();
    await r1;
    await new Promise((r) => setTimeout(r, 50));

    // Re-evaluator should have been called exactly once
    expect(reEvalCount).toBe(1);

    // Total generations: 1 (original) + 1 (re-eval) = 2
    const rows = db.prepare('SELECT * FROM task_generations WHERE goal_id = ?').all('goal-1') as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('multiple goals run independently (no cross-goal single-flight)', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');

    let unblock1: (() => void) | null = null;
    let unblock2: (() => void) | null = null;

    const makeSlowExec = (unblockRef: (fn: () => void) => void): RunTaskGenerationOpts['execute'] =>
      async () => {
        await new Promise<void>((res) => { unblockRef(res); });
        return { taskIds: [], sparse: false };
      };

    const opts1 = { ...baseTaskOpts(ctx), goalId: 'goal-1', execute: makeSlowExec((f) => { unblock1 = f; }) };
    const opts2 = { ...baseTaskOpts(ctx), goalId: 'goal-2', execute: makeSlowExec((f) => { unblock2 = f; }) };

    const r1 = runGeneration(opts1);
    const r2 = runGeneration(opts2);

    await new Promise((r) => setTimeout(r, 5));

    unblock1!();
    unblock2!();
    const [res1, res2] = await Promise.all([r1, r2]);

    await new Promise((r) => setTimeout(r, 30));

    // Both started independently
    expect(res1.isNew).toBe(true);
    expect(res2.isNew).toBe(true);
    expect(res1.dirtyQueued).toBe(false);
    expect(res2.dirtyQueued).toBe(false);
  });
});

// ── Content-free events ───────────────────────────────────────────────────────

describe('event payload content rules', () => {
  it('task.generation.failed payload has no failureMessage field', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const opts = baseTaskOpts(ctx, async () => { throw new Error('some message'); });
    await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    const failEv = published.find((e) => e.type === 'task.generation.failed');
    expect(failEv).toBeTruthy();
    expect(failEv!.payload).not.toHaveProperty('failureMessage');
    expect(failEv!.payload).toHaveProperty('failureCode');
    expect(failEv!.payload).toHaveProperty('generationId');
    expect(failEv!.payload).toHaveProperty('goalId');
  });

  it('event payloads are under 4 KiB serialized', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const taskIds = Array.from({ length: 100 }, (_, i) => `task-${i}`);
    const opts = baseTaskOpts(ctx, async () => ({ taskIds, sparse: false }));

    await runGeneration(opts);
    await new Promise((r) => setTimeout(r, 20));

    for (const ev of published) {
      const size = Buffer.byteLength(JSON.stringify(ev.payload), 'utf8');
      expect(size).toBeLessThanOrEqual(4096);
    }
  });
});
