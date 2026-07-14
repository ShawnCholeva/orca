import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import { FakeRecommendationProvider } from '../recommendations/provider.js';
import { FakeTaskGenerator } from '../tasks/rules.js';
import { FakeConflictDetector } from '../conflicts/detectors.js';
import { resetRunnerState } from './runner.js';
import { TRIGGER_MAP, subscribeOrchestrationTriggers, resetPreparedStatements as resetTriggerStmts } from './triggers.js';
import type { DaemonContext } from '../daemon-context.js';
import { resetPreparedStatements as resetTaskStmts } from '../tasks/projection.js';
import { resetPreparedStatements as resetRecStmts } from '../recommendations/projection.js';
import { resetPreparedStatements as resetConflictStmts } from '../conflicts/projection.js';
import { resetPreparedStatements as resetConflictUsecaseStmts } from '../conflicts/usecases.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';
let _idSeq = 0;
let _nowSeq = 0;

function nextId(): string {
  return `id-${++_idSeq}`;
}

function nextNow(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, _nowSeq++)).toISOString();
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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-triggers-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, NOW, NOW);
}

function makeCtx(
  db: Database.Database,
  bus: EventBus,
  opts?: {
    provider?: FakeRecommendationProvider;
    generator?: FakeTaskGenerator;
    detector?: FakeConflictDetector;
  }
): DaemonContext {
  return {
    db,
    bus,
    contextAssembler: null as unknown as DaemonContext['contextAssembler'],
    taskGenerator: opts?.generator ?? new FakeTaskGenerator({ candidates: [], sparse: true, warnings: [] }),
    recommendationProvider: opts?.provider ?? new FakeRecommendationProvider(),
    conflictDetector: opts?.detector ?? new FakeConflictDetector(),
    readinessService: null as unknown as DaemonContext['readinessService'],
    modelProviderRegistry: null as unknown as DaemonContext['modelProviderRegistry'],
    operatorRegistry: null as unknown as DaemonContext['operatorRegistry'],
    adapterDispatcher: null as unknown as DaemonContext['adapterDispatcher'],
    orchestrationTransportBroker: null as unknown as DaemonContext['orchestrationTransportBroker'],
    stepDispatchCapabilities: null as unknown as DaemonContext['stepDispatchCapabilities'],
    workflowSessionLauncher: { launch: async () => { throw new Error("direct_launch_unsupported"); } },
    now: nextNow,
    idFactory: nextId,
  };
}

/** Resolves when the bus publishes an event matching `predicate`, or rejects after timeout. */
function waitForEvent(
  bus: EventBus,
  predicate: (e: DomainEvent) => boolean,
  timeoutMs = 2000
): Promise<DomainEvent> {
  return new Promise<DomainEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForEvent timeout')), timeoutMs);
    const unsub = bus.subscribe((e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        unsub();
        resolve(e);
      }
    });
  });
}

afterEach(() => {
  closeDatabase();
  resetRunnerState();
  resetTaskStmts();
  resetRecStmts();
  resetConflictStmts();
  resetConflictUsecaseStmts();
  resetTriggerStmts();
  _idSeq = 0;
  _nowSeq = 0;
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Trigger map completeness ──────────────────────────────────────────────────

describe('TRIGGER_MAP completeness', () => {
  it('covers all event types listed in the orchestration trigger table', () => {
    const expectedKeys = [
      'goal.refined',
      'session.exited',
      'memory.item.promoted',
      'memory.item.archived',
      'decision.confirmed',
      'context.package.created',
      'task.created',
      'task.status_changed',
      'conflict.detected',
    ] as const;
    for (const key of expectedKeys) {
      expect(TRIGGER_MAP).toHaveProperty(key);
    }
  });

  it('has no entry for orchestration generation lifecycle events (re-entrancy guard)', () => {
    const orchestrationLifecycleEvents = [
      'task.generation.requested',
      'task.generated',
      'task.generation.failed',
      'recommendation.generation.requested',
      'recommendation.generated',
      'recommendation.generation.failed',
      'recommendation.accepted',
      'recommendation.rejected',
      'recommendation.dismissed',
      'recommendation.modified',
      'recommendation.superseded',
      'conflict.resolved',
      'conflict.dismissed',
    ] as const;
    for (const key of orchestrationLifecycleEvents) {
      expect(TRIGGER_MAP).not.toHaveProperty(key);
    }
  });
});

// ── Static import check ───────────────────────────────────────────────────────

describe('static import safety', () => {
  it('triggers.ts does not import output-tail or transcript modules', () => {
    const src = readFileSync(
      path.resolve(__dirname, 'triggers.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/output-store/);
    expect(src).not.toMatch(/output-tail/);
    expect(src).not.toMatch(/transcript/);
  });
});

// ── context.package.created: triggers recommendation generation ───────────────

describe('context.package.created', () => {
  it('creates a recommendation generation row', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'g1');
    subscribeOrchestrationTriggers(ctx);

    const requestedEvent = waitForEvent(
      bus,
      (e) => e.type === 'recommendation.generation.requested',
      2000
    );

    const ev: DomainEvent = {
      seq: 1, id: 'ev-1', type: 'context.package.created',
      goalId: 'g1',
      payload: { contextPackageId: 'cp-1', goalId: 'g1' },
      createdAt: NOW,
    };
    bus.publish(ev);

    await requestedEvent;

    const rows = db.prepare(
      `SELECT id FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});

// ── session.exited: triggers recommendation generation ────────────────────────

describe('session.exited trigger', () => {
  it('creates one recommendation generation row and emits expected events', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const captured: DomainEvent[] = [];
    bus.subscribe((e) => captured.push(e));
    const ctx = makeCtx(db, bus);
    seedGoal(db, 'g1');
    subscribeOrchestrationTriggers(ctx);

    const done = waitForEvent(
      bus,
      (e) => e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed'
    );

    const ev: DomainEvent = {
      seq: 1, id: 'src-ev-1', type: 'session.exited',
      goalId: 'g1',
      payload: { sessionId: 'sess-1', goalId: 'g1' },
      createdAt: NOW,
    };
    bus.publish(ev);

    await done;

    const rows = db.prepare(
      `SELECT id, status FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('succeeded');

    const types = captured.map((e) => e.type);
    expect(types).toContain('recommendation.generation.requested');
    expect(types).toContain('recommendation.generated');
  });

  it('runs conflict detection synchronously before generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');

    // Fake detector returns a workspace overlap candidate
    const detector = new FakeConflictDetector();
    detector.setFixtures([
      {
        conflictType: 'workspace_overlap',
        severity: 'warning',
        title: 'Two running sessions on same workspace',
        description: 'Workspace has two running sessions.',
        sources: [
          { type: 'session', id: 'sess-a', role: 'subject_a' },
          { type: 'session', id: 'sess-b', role: 'subject_b' },
          { type: 'workspace', id: 'ws-1', role: 'context' },
        ],
        recommendationSources: [{ type: 'workspace', id: 'ws-1', reason: 'context' }],
        sourceUpdatedAts: [],
      },
    ]);

    const ctx = makeCtx(db, bus, { detector });
    subscribeOrchestrationTriggers(ctx);

    const conflictDone = waitForEvent(bus, (e) => e.type === 'conflict.detected');
    const recDone = waitForEvent(
      bus,
      (e) => e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed'
    );

    bus.publish({
      seq: 1, id: 'ev-session-exit', type: 'session.exited',
      goalId: 'g1',
      payload: { sessionId: 'sess-x', goalId: 'g1' },
      createdAt: NOW,
    });

    const [conflictEvt] = await Promise.all([conflictDone, recDone]);

    // conflict.detected must be present
    expect(conflictEvt.type).toBe('conflict.detected');
    const conflictId = conflictEvt.payload.conflictId as string;

    // conflict row exists
    const conflictRow = db.prepare(`SELECT id, status FROM conflicts WHERE id = ?`).get(conflictId) as
      | { id: string; status: string }
      | undefined;
    expect(conflictRow).toBeDefined();
    expect(conflictRow!.status).toBe('open');

    // linked resolve_conflict recommendation created in same TX
    const linkedRec = db.prepare(
      `SELECT id FROM recommendations WHERE related_conflict_id = ?`
    ).get(conflictId) as { id: string } | undefined;
    expect(linkedRec).toBeDefined();
  });
});

// ── goal.refined: triggers task generation when no tasks exist ────────────────

describe('goal.refined trigger', () => {
  it('triggers task generation when goal has zero active tasks', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const generator = new FakeTaskGenerator({
      candidates: [
        {
          title: 'Implement feature',
          description: 'Build the feature.',
          role: 'engineer',
          workspaceId: null,
          sources: [],
        },
      ],
      sparse: false,
      warnings: [],
    });
    const ctx = makeCtx(db, bus, { generator });
    seedGoal(db, 'g1');
    subscribeOrchestrationTriggers(ctx);

    const taskDone = waitForEvent(
      bus,
      (e) => e.type === 'task.generated' || e.type === 'task.generation.failed'
    );

    bus.publish({
      seq: 1, id: 'ev-refined', type: 'goal.refined',
      goalId: 'g1',
      payload: { refinementId: 'ref-1', goalId: 'g1' },
      createdAt: NOW,
    });

    await taskDone;

    const taskRows = db.prepare(`SELECT id FROM tasks WHERE goal_id = 'g1'`).all() as { id: string }[];
    expect(taskRows.length).toBeGreaterThan(0);
  });

  it('skips task generation when goal already has active tasks', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');

    // Insert an existing task
    db.prepare(
      `INSERT INTO tasks (id, goal_id, role, status, origin, title, description, sources_json, fingerprint, created_at, updated_at)
       VALUES ('existing-task', 'g1', 'engineer', 'open', 'user', 'Existing', '', '[]', 'fp-manual', ?, ?)`
    ).run(NOW, NOW);

    const generator = new FakeTaskGenerator({
      candidates: [
        { title: 'New task', description: '', role: 'engineer', workspaceId: null, sources: [] },
      ],
      sparse: false,
      warnings: [],
    });
    const ctx = makeCtx(db, bus, { generator });
    subscribeOrchestrationTriggers(ctx);

    // Allow time for any spurious generation
    const unexpectedTaskGen = waitForEvent(
      bus,
      (e) => e.type === 'task.generation.requested',
      200
    );

    bus.publish({
      seq: 1, id: 'ev-refined', type: 'goal.refined',
      goalId: 'g1',
      payload: { refinementId: 'ref-1', goalId: 'g1' },
      createdAt: NOW,
    });

    await expect(unexpectedTaskGen).rejects.toThrow('waitForEvent timeout');
  });
});

// ── Single-flight + dirty-flag re-evaluation ──────────────────────────────────

describe('single-flight and dirty-flag re-evaluation', () => {
  it('collapses concurrent triggers into one generation + one re-evaluation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');

    let resolveFirstGeneration: (() => void) | null = null;
    const firstGenerationStarted = new Promise<void>((res) => {
      resolveFirstGeneration = res;
    });
    let firstGenerationUnblock: (() => void) | null = null;
    const firstGenerationGate = new Promise<void>((res) => {
      firstGenerationUnblock = res;
    });

    const provider = new FakeRecommendationProvider();
    let callCount = 0;
    // Override generate to control timing
    const originalGenerate = provider.generate.bind(provider);
    provider.generate = async (input) => {
      callCount++;
      if (callCount === 1) {
        resolveFirstGeneration!();
        await firstGenerationGate;
      }
      return originalGenerate(input);
    };

    const ctx = makeCtx(db, bus, { provider });
    subscribeOrchestrationTriggers(ctx);

    const ev1: DomainEvent = {
      seq: 1, id: 'ev-1', type: 'session.exited',
      goalId: 'g1', payload: { sessionId: 's1', goalId: 'g1' }, createdAt: NOW,
    };
    const ev2: DomainEvent = {
      seq: 2, id: 'ev-2', type: 'session.exited',
      goalId: 'g1', payload: { sessionId: 's2', goalId: 'g1' }, createdAt: NOW,
    };

    // Wait for the re-evaluation generation (second 'recommendation.generated' event)
    let generatedCount = 0;
    const bothDone = new Promise<void>((resolve) => {
      bus.subscribe((e) => {
        if (e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed') {
          generatedCount++;
          if (generatedCount >= 2) resolve();
        }
      });
    });

    // Emit first trigger, wait for generation to start (gate)
    bus.publish(ev1);
    await firstGenerationStarted;

    // Emit second trigger while first is in-flight
    bus.publish(ev2);

    // Unblock first generation
    firstGenerationUnblock!();

    await bothDone;

    // Exactly two generation rows: original + re-evaluation
    const genRows = db.prepare(
      `SELECT id FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { id: string }[];
    expect(genRows.length).toBe(2);

    // Both must be succeeded
    const statuses = db.prepare(
      `SELECT status FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { status: string }[];
    expect(statuses.every((r) => r.status === 'succeeded')).toBe(true);
  });
});

// ── Payload-based dispatch ────────────────────────────────────────────────────

describe('payload-based dispatch', () => {
  it('memory.extraction.completed with summaryId → session_summary_created generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const done = waitForEvent(bus, (e) => e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed');

    bus.publish({
      seq: 1, id: 'ev-extract', type: 'memory.extraction.completed',
      goalId: 'g1',
      payload: { extractionId: 'ext-1', goalId: 'g1', sessionId: 'sess-1', summaryId: 'sum-1' },
      createdAt: NOW,
    });

    await done;

    const rows = db.prepare(
      `SELECT trigger FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { trigger: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe('session_summary_created');
  });

  it('memory.extraction.completed without summaryId → no generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const unexpected = waitForEvent(bus, (e) => e.type === 'recommendation.generation.requested', 200);

    bus.publish({
      seq: 1, id: 'ev-extract', type: 'memory.extraction.completed',
      goalId: 'g1',
      payload: { extractionId: 'ext-1', goalId: 'g1', sessionId: 'sess-1', summaryId: null },
      createdAt: NOW,
    });

    await expect(unexpected).rejects.toThrow('waitForEvent timeout');
  });

  it('decision.created with confirmationRequired=true → generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const done = waitForEvent(bus, (e) => e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed');

    bus.publish({
      seq: 1, id: 'ev-dec', type: 'decision.created',
      goalId: 'g1',
      payload: { decisionId: 'dec-1', goalId: 'g1', status: 'proposed', confirmationRequired: true },
      createdAt: NOW,
    });

    await done;

    const rows = db.prepare(
      `SELECT trigger FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { trigger: string }[];
    expect(rows[0]!.trigger).toBe('decision_confirmation_required');
  });

  it('decision.created with confirmationRequired=false → no generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const unexpected = waitForEvent(bus, (e) => e.type === 'recommendation.generation.requested', 200);

    bus.publish({
      seq: 1, id: 'ev-dec', type: 'decision.created',
      goalId: 'g1',
      payload: { decisionId: 'dec-1', goalId: 'g1', status: 'proposed', confirmationRequired: false },
      createdAt: NOW,
    });

    await expect(unexpected).rejects.toThrow('waitForEvent timeout');
  });

  it('user.feedback.recorded with action=modify → re-evaluation generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const done = waitForEvent(bus, (e) => e.type === 'recommendation.generated' || e.type === 'recommendation.generation.failed');

    bus.publish({
      seq: 1, id: 'ev-fb', type: 'user.feedback.recorded',
      goalId: 'g1',
      payload: { feedbackId: 'fb-1', goalId: 'g1', action: 'modify', recommendationId: 'rec-1' },
      createdAt: NOW,
    });

    await done;

    const rows = db.prepare(
      `SELECT trigger FROM recommendation_generations WHERE goal_id = 'g1'`
    ).all() as { trigger: string }[];
    expect(rows[0]!.trigger).toBe('user_feedback_recorded');
  });

  it('user.feedback.recorded with action=accept → no generation', async () => {
    const db = freshDb();
    const bus = new EventBus();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const unexpected = waitForEvent(bus, (e) => e.type === 'recommendation.generation.requested', 200);

    bus.publish({
      seq: 1, id: 'ev-fb', type: 'user.feedback.recorded',
      goalId: 'g1',
      payload: { feedbackId: 'fb-1', goalId: 'g1', action: 'accept', recommendationId: 'rec-1' },
      createdAt: NOW,
    });

    await expect(unexpected).rejects.toThrow('waitForEvent timeout');
  });
});

// ── Events without goalId are ignored ─────────────────────────────────────────

describe('events without goalId', () => {
  it('ignores events with null goalId', async () => {
    const db = freshDb();
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    subscribeOrchestrationTriggers(ctx);

    const unexpected = waitForEvent(bus, (e) => e.type === 'recommendation.generation.requested', 200);

    bus.publish({
      seq: 1, id: 'ev-skill', type: 'skill.invoked',
      goalId: null,
      payload: { skillId: 'some-skill' },
      createdAt: NOW,
    });

    await expect(unexpected).rejects.toThrow('waitForEvent timeout');
  });
});
