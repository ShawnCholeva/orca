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
  detectWorkspaceOverlap,
  detectContradictoryDecisions,
  detectReviewerRejection,
  detectBlockerReported,
  detectUnresolvedQuestion,
  type ConflictCandidate,
  type ConflictDetector,
  type ConflictSnapshot,
} from './detectors.js';
import {
  detectAndPersist,
  dismissConflict,
  getConflictById,
  resetPreparedStatements,
  type ConflictCtx,
} from './usecases.js';
import { getRecommendationById } from '../recommendations/projection.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';
const FUTURE = '2026-01-03T00:00:00.000Z';
let idTick = 0;

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-conflicts-detectors-'));
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

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `/tmp/${id}`, id, '', NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, id, NOW);
}

function seedSession(
  db: Database.Database,
  input: {
    id: string;
    goalId: string;
    workspaceId: string;
    status: string;
    role?: string | null;
    taskId?: string | null;
    createdAt?: string;
    exitedAt?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO sessions
      (id, goal_id, workspace_id, adapter_id, role, title, status, created_at, exited_at, task_id)
     VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.goalId,
    input.workspaceId,
    input.role ?? null,
    input.id,
    input.status,
    input.createdAt ?? NOW,
    input.exitedAt ?? null,
    input.taskId ?? null
  );
}

function baseSnapshot(overrides: Partial<ConflictSnapshot> = {}): ConflictSnapshot {
  return {
    goalId: 'g1',
    sessions: [],
    sessionSummaries: [],
    tasks: [],
    memoryItems: [],
    decisions: [],
    workspaces: [],
    ...overrides,
  };
}

function makeCtx(
  db: Database.Database,
  bus: EventBus,
  detector?: ConflictDetector,
  now = NOW
): ConflictCtx {
  return {
    db,
    bus,
    ...(detector ? { conflictDetector: detector } : {}),
    now: () => now,
    idFactory: () => `id-${++idTick}`,
  };
}

function fakeDetector(candidates: ConflictCandidate[]): ConflictDetector {
  return { run: () => candidates };
}

function candidate(updatedAt = NOW): ConflictCandidate {
  return {
    conflictType: 'workspace_overlap',
    severity: 'warning',
    title: 'Workspace has overlapping running sessions',
    description: 'Two running sessions are attached to the same workspace.',
    sources: [
      { type: 'session', id: 's1', role: 'subject_a' },
      { type: 'session', id: 's2', role: 'subject_b' },
      { type: 'workspace', id: 'w1', role: 'context' },
    ],
    recommendationSources: [{ type: 'workspace', id: 'w1', reason: 'context' }],
    sourceUpdatedAts: [updatedAt],
  };
}

afterEach(() => {
  idTick = 0;
  resetPreparedStatements();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('detector rules', () => {
  it('no-conflict baseline returns zero detections', () => {
    const snapshot = baseSnapshot();
    expect(detectWorkspaceOverlap(snapshot)).toHaveLength(0);
    expect(detectContradictoryDecisions(snapshot)).toHaveLength(0);
    expect(detectReviewerRejection(snapshot)).toHaveLength(0);
    expect(detectBlockerReported(snapshot)).toHaveLength(0);
    expect(detectUnresolvedQuestion(snapshot)).toHaveLength(0);
  });

  it('workspace_overlap detects shared running workspace and escalates same task', () => {
    const snapshot = baseSnapshot({
      sessions: [
        { id: 's1', workspaceId: 'w1', taskId: 't1', status: 'running', role: 'engineer', createdAt: NOW, exitedAt: null },
        { id: 's2', workspaceId: 'w1', taskId: 't1', status: 'running', role: 'engineer', createdAt: NOW, exitedAt: null },
      ],
      tasks: [{ id: 't1', workspaceId: 'w1', status: 'in_progress', sources: [], updatedAt: NOW }],
      workspaces: [{ id: 'w1', attachedAt: NOW }],
    });

    const conflicts = detectWorkspaceOverlap(snapshot);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe('blocker');
    expect(conflicts[0]!.sources.map((source) => source.type)).toEqual([
      'session',
      'session',
      'workspace',
      'task',
    ]);
  });

  it('contradictory_decisions detects overlapping confirmed titles with negation mismatch', () => {
    const snapshot = baseSnapshot({
      decisions: [
        {
          id: 'd1',
          title: 'Use SQLite storage',
          decisionText: 'We should use SQLite for internal storage.',
          status: 'confirmed',
          confirmationRequired: false,
          updatedAt: NOW,
        },
        {
          id: 'd2',
          title: 'Use SQLite storage',
          decisionText: 'We should not use SQLite for internal storage.',
          status: 'confirmed',
          confirmationRequired: false,
          updatedAt: NOW,
        },
      ],
    });

    const conflicts = detectContradictoryDecisions(snapshot);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictType).toBe('contradictory_decisions');
  });

  it('reviewer_rejection detects failed reviewer session with a summary', () => {
    const snapshot = baseSnapshot({
      sessions: [
        { id: 's1', workspaceId: 'w1', taskId: 't1', status: 'failed', role: 'reviewer', createdAt: NOW, exitedAt: LATER },
      ],
      sessionSummaries: [{ id: 'sum1', sessionId: 's1', createdAt: LATER }],
      tasks: [{ id: 't1', workspaceId: 'w1', status: 'in_progress', sources: [], updatedAt: NOW }],
    });

    const conflicts = detectReviewerRejection(snapshot);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.sources.map((source) => source.type)).toContain('session_summary');
  });

  it('blocker_reported escalates when linked task is in progress', () => {
    const snapshot = baseSnapshot({
      memoryItems: [
        { id: 'm1', type: 'blocker', status: 'promoted', sourceId: null, sourceSessionId: null, updatedAt: NOW },
      ],
      tasks: [
        {
          id: 't1',
          workspaceId: null,
          status: 'in_progress',
          sources: [{ type: 'memory_item', id: 'm1' }],
          updatedAt: NOW,
        },
      ],
    });

    const conflicts = detectBlockerReported(snapshot);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe('blocker');
  });

  it('unresolved_question detects question linked to confirmation-required decision', () => {
    const snapshot = baseSnapshot({
      memoryItems: [
        { id: 'm1', type: 'open_question', status: 'candidate', sourceId: 'd1', sourceSessionId: null, updatedAt: NOW },
      ],
      decisions: [
        {
          id: 'd1',
          title: 'Confirm API shape',
          decisionText: 'Need confirmation.',
          status: 'proposed',
          confirmationRequired: true,
          updatedAt: NOW,
        },
      ],
    });

    const conflicts = detectUnresolvedQuestion(snapshot);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe('info');
  });
});

describe('detectAndPersist', () => {
  it('persists detected conflicts and linked resolve_conflict recommendations in one cascade', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'w1', 'g1');
    seedSession(db, { id: 's1', goalId: 'g1', workspaceId: 'w1', status: 'running' });
    seedSession(db, { id: 's2', goalId: 'g1', workspaceId: 'w1', status: 'running' });

    const bus = new EventBus();
    const published: DomainEvent[] = [];
    bus.subscribe((event) => published.push(event));

    const result = detectAndPersist(makeCtx(db, bus), { goalId: 'g1' });

    expect(result.conflictIds).toHaveLength(1);
    expect(result.recommendationIds).toHaveLength(1);

    const conflict = getConflictById(db, result.conflictIds[0]!);
    expect(conflict?.status).toBe('open');

    const recommendation = getRecommendationById(db, result.recommendationIds[0]!);
    expect(recommendation?.type).toBe('resolve_conflict');
    expect(recommendation?.relatedConflictId).toBe(conflict?.id);
    expect(recommendation?.sources.some((source) => source.type === 'conflict')).toBe(true);

    const eventRows = db
      .prepare('SELECT seq, type, payload FROM events ORDER BY seq ASC')
      .all() as { seq: number; type: string; payload: string }[];
    expect(eventRows.map((row) => row.type)).toEqual([
      'recommendation.generation.requested',
      'conflict.detected',
      'recommendation.generated',
    ]);
    expect(eventRows[1]!.seq).toBe(eventRows[0]!.seq + 1);
    expect(eventRows[2]!.seq).toBe(eventRows[1]!.seq + 1);
    expect(JSON.parse(eventRows[1]!.payload)).not.toHaveProperty('description');
    expect(JSON.parse(eventRows[2]!.payload)).toMatchObject({
      recommendationIds: result.recommendationIds,
      count: 1,
    });
    expect(published.map((event) => event.type)).toEqual([
      'recommendation.generation.requested',
      'conflict.detected',
      'recommendation.generated',
    ]);
  });

  it('does not duplicate an already-open conflict fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();
    const detector = fakeDetector([candidate()]);
    const ctx = makeCtx(db, bus, detector);

    const first = detectAndPersist(ctx, { goalId: 'g1' });
    const second = detectAndPersist(ctx, { goalId: 'g1' });

    expect(first.conflictIds).toHaveLength(1);
    expect(second.conflictIds).toHaveLength(0);
    expect(second.skippedCount).toBe(1);
    const openCount = (
      db.prepare("SELECT count(*) AS c FROM conflicts WHERE goal_id = 'g1' AND status = 'open'").get() as { c: number }
    ).c;
    expect(openCount).toBe(1);
  });

  it('reopens a dismissed fingerprint only after a source timestamp advances', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const bus = new EventBus();

    const first = detectAndPersist(makeCtx(db, bus, fakeDetector([candidate(NOW)]), NOW), {
      goalId: 'g1',
    });
    dismissConflict(makeCtx(db, bus, undefined, LATER), first.conflictIds[0]!);

    const unchanged = detectAndPersist(makeCtx(db, bus, fakeDetector([candidate(NOW)]), LATER), {
      goalId: 'g1',
    });
    expect(unchanged.conflictIds).toHaveLength(0);

    const advanced = detectAndPersist(makeCtx(db, bus, fakeDetector([candidate(FUTURE)]), FUTURE), {
      goalId: 'g1',
    });
    expect(advanced.conflictIds).toHaveLength(1);
    expect(getConflictById(db, advanced.conflictIds[0]!)?.status).toBe('open');
  });
});
