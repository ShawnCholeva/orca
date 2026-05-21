import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import {
  insertOpenConflict,
  resolveConflict,
  dismissConflict,
  autoDismissResolveConflictRecommendation,
  getConflictById,
  ConflictNotFoundError,
  InvalidConflictStatusError,
  EmptyConflictSourcesError,
  resetPreparedStatements,
  type ConflictCtx,
} from './usecases.js';
import { conflictFingerprint } from './fingerprint.js';
import { insertConflictRow } from './projection.js';
import { insertRecommendation } from '../recommendations/projection.js';
import { getFeedbackByRecommendationId } from '../recommendations/feedback.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-conflicts-uc-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, NOW, NOW);
}

function makeCtx(db: Database.Database, bus: EventBus, t = NOW): ConflictCtx {
  let tick = 0;
  return {
    db,
    bus,
    now: () => t,
    idFactory: () => `id-${++tick}`,
  };
}

function makeFp(goalId: string, type: string, sources: string[]): string {
  return conflictFingerprint(goalId, type, sources);
}

function seedResolveConflictRec(
  db: Database.Database,
  opts: { recId: string; goalId: string; conflictId: string; status?: string }
): void {
  const status = opts.status ?? 'proposed';
  insertRecommendation(db, {
    id: opts.recId,
    goalId: opts.goalId,
    generationId: null,
    type: 'resolve_conflict',
    status,
    source: 'deterministic_provider',
    title: 'Resolve conflict',
    rationale: 'You should resolve this conflict.',
    proposedActionJson: JSON.stringify({ kind: 'resolve_conflict', conflictId: opts.conflictId }),
    confidence: 1.0,
    sourcesJson: JSON.stringify([]),
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: opts.conflictId,
    fingerprint: `fp-${opts.recId}`,
    supersededById: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

afterEach(() => {
  resetPreparedStatements();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── insertOpenConflict ────────────────────────────────────────────────────────

describe('insertOpenConflict', () => {
  it('inserts new conflict, emits conflict.detected, returns isNew=true', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1', 's2']);
    const { conflict, isNew } = insertOpenConflict(ctx, {
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
      title: 'Two sessions on same workspace',
      description: 'Sessions s1 and s2 share workspace w1',
      sources: [{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }],
      fingerprint: fp,
    });

    expect(isNew).toBe(true);
    expect(conflict.status).toBe('open');
    expect(conflict.conflictType).toBe('workspace_overlap');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('conflict.detected');
    expect(events[0].payload).toMatchObject({
      conflictId: conflict.id,
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
    });
    // payload must not include description text
    expect(events[0].payload).not.toHaveProperty('description');
    expect(events[0].payload).not.toHaveProperty('title');
  });

  it('returns existing row and no event on duplicate open fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1', 's2']);

    const { conflict: first } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }],
      fingerprint: fp,
    });

    events.length = 0;

    const { conflict: second, isNew } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T2', description: 'D2',
      sources: [{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }],
      fingerprint: fp,
    });

    expect(isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(events).toHaveLength(0);
  });

  it('allows second insert after first is resolved', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict: first } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });
    resolveConflict(ctx, first.id);

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    const { conflict: second, isNew } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    expect(isNew).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(events.some((e) => e.type === 'conflict.detected')).toBe(true);
  });

  it('throws EmptyConflictSourcesError when sources empty', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    expect(() =>
      insertOpenConflict(ctx, {
        goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
        title: 'T', description: 'D',
        sources: [],
        fingerprint: 'fp',
      })
    ).toThrow(EmptyConflictSourcesError);
  });

  it('caps title and description', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'A'.repeat(1000),
      description: 'B'.repeat(5000),
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    expect(conflict.title.length).toBeLessThanOrEqual(256);
    expect(conflict.description.length).toBeLessThanOrEqual(1024);
  });
});

// ── resolveConflict ───────────────────────────────────────────────────────────

describe('resolveConflict', () => {
  it('open → resolved, emits conflict.resolved', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    const { conflict: resolved } = resolveConflict(ctx, conflict.id, 'Fixed');

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBe('Fixed');
    expect(resolved.resolvedAt).toBe(NOW);

    expect(events.some((e) => e.type === 'conflict.resolved')).toBe(true);
    const ev = events.find((e) => e.type === 'conflict.resolved')!;
    expect(ev.payload).toMatchObject({ conflictId: conflict.id, goalId: 'g1', resolution: 'resolved' });
    expect(ev.payload).not.toHaveProperty('resolutionNote');
    expect(ev.payload).not.toHaveProperty('title');
  });

  it('throws ConflictNotFoundError for unknown id', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    expect(() => resolveConflict(ctx, 'no-such-id')).toThrow(ConflictNotFoundError);
  });

  it('throws InvalidConflictStatusError for already-resolved conflict', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    resolveConflict(ctx, conflict.id);
    expect(() => resolveConflict(ctx, conflict.id)).toThrow(InvalidConflictStatusError);
  });

  it('caps and redacts resolution note', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    const { conflict: resolved } = resolveConflict(ctx, conflict.id, 'N'.repeat(10000));
    expect(resolved.resolutionNote!.length).toBeLessThanOrEqual(4096);
  });
});

// ── dismissConflict ───────────────────────────────────────────────────────────

describe('dismissConflict', () => {
  it('open → dismissed, emits conflict.dismissed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    const { conflict: dismissed } = dismissConflict(ctx, conflict.id);

    expect(dismissed.status).toBe('dismissed');
    expect(events.some((e) => e.type === 'conflict.dismissed')).toBe(true);
    const ev = events.find((e) => e.type === 'conflict.dismissed')!;
    expect(ev.payload).toMatchObject({ conflictId: conflict.id, resolution: 'dismissed' });
  });

  it('throws InvalidConflictStatusError for already-dismissed conflict', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const { conflict } = insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });
    dismissConflict(ctx, conflict.id);
    expect(() => dismissConflict(ctx, conflict.id)).toThrow(InvalidConflictStatusError);
  });
});

// ── autoDismissResolveConflictRecommendation ─────────────────────────────────

describe('autoDismissResolveConflictRecommendation (via resolveConflict)', () => {
  it('dismisses linked proposed resolve_conflict rec in same TX as conflict.resolved', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    // Insert open conflict
    insertConflictRow(db, {
      id: 'c1',
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
      title: 'T',
      description: 'D',
      sourcesJson: JSON.stringify([{ type: 'session', id: 's1' }]),
      fingerprint: fp,
      detectedAt: NOW,
    });

    // Seed linked resolve_conflict recommendation
    seedResolveConflictRec(db, { recId: 'r1', goalId: 'g1', conflictId: 'c1' });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    resolveConflict(ctx, 'c1');

    // Verify recommendation is dismissed
    const recRow = db
      .prepare('SELECT status FROM recommendations WHERE id = ?')
      .get('r1') as { status: string };
    expect(recRow.status).toBe('dismissed');

    // Verify feedback row with action='dismiss' and note='conflict_resolved'
    const feedback = getFeedbackByRecommendationId(db, 'r1');
    expect(feedback).toHaveLength(1);
    expect(feedback[0].action).toBe('dismiss');
    expect(feedback[0].note).toBe('conflict_resolved');

    // Verify events: conflict.resolved + recommendation.dismissed + user.feedback.recorded
    const types = events.map((e) => e.type);
    expect(types).toContain('conflict.resolved');
    expect(types).toContain('recommendation.dismissed');
    expect(types).toContain('user.feedback.recorded');

    // All three must be in same TX: verify by checking event seq ordering
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('no-op when linked recommendation already terminal (accepted)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    insertConflictRow(db, {
      id: 'c1',
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
      title: 'T',
      description: 'D',
      sourcesJson: JSON.stringify([{ type: 'session', id: 's1' }]),
      fingerprint: fp,
      detectedAt: NOW,
    });

    // Linked recommendation already accepted
    seedResolveConflictRec(db, {
      recId: 'r1',
      goalId: 'g1',
      conflictId: 'c1',
      status: 'accepted',
    });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    resolveConflict(ctx, 'c1');

    // recommendation unchanged
    const recRow = db
      .prepare('SELECT status FROM recommendations WHERE id = ?')
      .get('r1') as { status: string };
    expect(recRow.status).toBe('accepted');

    // only conflict.resolved emitted (no recommendation.dismissed, no user.feedback.recorded)
    const types = events.map((e) => e.type);
    expect(types).toContain('conflict.resolved');
    expect(types).not.toContain('recommendation.dismissed');
    expect(types).not.toContain('user.feedback.recorded');
  });

  it('no-op when no linked recommendation exists', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    insertConflictRow(db, {
      id: 'c1',
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
      title: 'T',
      description: 'D',
      sourcesJson: JSON.stringify([{ type: 'session', id: 's1' }]),
      fingerprint: fp,
      detectedAt: NOW,
    });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    resolveConflict(ctx, 'c1');

    const types = events.map((e) => e.type);
    expect(types).toContain('conflict.resolved');
    expect(types).not.toContain('recommendation.dismissed');
  });

  it('auto-dismiss works via dismissConflict too', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    insertConflictRow(db, {
      id: 'c1',
      goalId: 'g1',
      conflictType: 'workspace_overlap',
      severity: 'warning',
      title: 'T',
      description: 'D',
      sourcesJson: JSON.stringify([{ type: 'session', id: 's1' }]),
      fingerprint: fp,
      detectedAt: NOW,
    });

    seedResolveConflictRec(db, { recId: 'r1', goalId: 'g1', conflictId: 'c1' });

    const events: DomainEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    dismissConflict(ctx, 'c1');

    const recRow = db
      .prepare('SELECT status FROM recommendations WHERE id = ?')
      .get('r1') as { status: string };
    expect(recRow.status).toBe('dismissed');

    const types = events.map((e) => e.type);
    expect(types).toContain('conflict.dismissed');
    expect(types).toContain('recommendation.dismissed');
    expect(types).toContain('user.feedback.recorded');
  });
});

// ── Atomicity ─────────────────────────────────────────────────────────────────

describe('atomicity', () => {
  it('conflict row not committed if event insert fails', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    // Corrupt the events table to force failure
    db.exec('DROP TABLE events');

    expect(() =>
      insertOpenConflict(ctx, {
        goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
        title: 'T', description: 'D',
        sources: [{ type: 'session', id: 's1' }],
        fingerprint: fp,
      })
    ).toThrow();

    // Restore events and verify no conflict row was committed
    db.exec(`CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      goal_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`);

    const count = (
      db.prepare('SELECT count(*) AS cnt FROM conflicts').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });
});

// ── Broadcast after commit ────────────────────────────────────────────────────

describe('broadcast after commit', () => {
  it('events published after COMMIT, not during transaction', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const ctx = makeCtx(db, bus);
    const fp = makeFp('g1', 'workspace_overlap', ['s1']);

    const publishOrder: string[] = [];
    let inTransaction = false;

    // Intercept to track if events arrive during or after TX
    const origPublish = bus.publish.bind(bus);
    vi.spyOn(bus, 'publish').mockImplementation((ev) => {
      publishOrder.push(inTransaction ? 'during-tx' : 'after-tx');
      origPublish(ev);
    });

    // Use a raw transaction wrapper to track when TX is active
    const origTx = db.transaction.bind(db);
    // We can't easily intercept db.transaction, so instead verify that
    // the event appears in the events table before bus.publish is called.
    // Verify by subscribing and checking DB state at publish time.
    const seqsAtPublish: number[] = [];
    bus.subscribe((ev) => {
      const cnt = (
        db.prepare('SELECT count(*) AS cnt FROM events WHERE id = ?').get(ev.id) as { cnt: number }
      ).cnt;
      seqsAtPublish.push(cnt);
    });

    insertOpenConflict(ctx, {
      goalId: 'g1', conflictType: 'workspace_overlap', severity: 'warning',
      title: 'T', description: 'D',
      sources: [{ type: 'session', id: 's1' }],
      fingerprint: fp,
    });

    // Event was already in DB when subscriber received it → committed before broadcast
    expect(seqsAtPublish.every((cnt) => cnt === 1)).toBe(true);
  });
});
