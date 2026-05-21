import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  insertRecommendation,
  getRecommendationById,
  listRecommendationsByGoal,
  insertOrGetPendingRecommendationGeneration,
  markRecommendationGenerationRunning,
  markRecommendationGenerationSucceeded,
  markRecommendationGenerationFailed,
  getRecommendationGenerationById,
  getActiveRecommendationGenerationByFp,
  listRecommendationGenerationsByGoal,
  updateRecommendationStatusRow,
  resetPreparedStatements,
} from './projection.js';
import { recommendationFingerprint, recommendationGenerationRequestFingerprint } from './fingerprint.js';

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-rec-proj-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, now, now);
}

const NOW = '2026-01-01T00:00:00.000Z';
const PROPOSED_ACTION_JSON = JSON.stringify({ kind: 'ask_user', question: 'Should we proceed?' });

function makeRec(goalId: string, overrides: Partial<{
  id: string;
  status: string;
  type: string;
  fingerprint: string;
}> = {}) {
  const id = overrides.id ?? 'rec-1';
  const type = overrides.type ?? 'ask_user';
  return {
    id,
    goalId,
    generationId: null,
    type,
    status: overrides.status ?? 'proposed',
    source: 'deterministic_provider' as const,
    title: 'Test recommendation',
    rationale: 'Because reasons',
    proposedActionJson: PROPOSED_ACTION_JSON,
    confidence: 0.8,
    sourcesJson: '[]',
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: null,
    fingerprint: overrides.fingerprint ?? recommendationFingerprint(goalId, type, PROPOSED_ACTION_JSON),
    supersededById: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('insertRecommendation / getRecommendationById', () => {
  it('inserts and retrieves a recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertRecommendation(db, makeRec('g1'));
    const rec = getRecommendationById(db, 'rec-1');
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('rec-1');
    expect(rec!.goalId).toBe('g1');
    expect(rec!.status).toBe('proposed');
    expect(rec!.proposedAction).toEqual(JSON.parse(PROPOSED_ACTION_JSON));
    expect(rec!.sources).toEqual([]);
  });

  it('returns null for missing id', () => {
    const db = freshDb();
    expect(getRecommendationById(db, 'nope')).toBeNull();
  });
});

describe('listRecommendationsByGoal', () => {
  it('filters by status', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertRecommendation(db, makeRec('g1', { id: 'r1', status: 'proposed' }));
    insertRecommendation(db, makeRec('g1', {
      id: 'r2',
      status: 'accepted',
      fingerprint: recommendationFingerprint('g1', 'ask_user', JSON.stringify({ kind: 'ask_user', question: 'X?' })),
    }));
    const { recommendations } = listRecommendationsByGoal(db, { goalId: 'g1', status: 'proposed' });
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].id).toBe('r1');
  });

  it('filters by type', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertRecommendation(db, makeRec('g1', { id: 'r1', type: 'ask_user' }));
    insertRecommendation(db, makeRec('g1', {
      id: 'r2',
      type: 'pause_work',
      fingerprint: recommendationFingerprint('g1', 'pause_work',
        JSON.stringify({ kind: 'pause_work', reason: 'blocked', relatedTaskIds: [] })),
      status: 'accepted',
    }));
    const { recommendations } = listRecommendationsByGoal(db, { goalId: 'g1', type: 'ask_user' });
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].id).toBe('r1');
  });

  it('paginates via cursor', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    for (let i = 1; i <= 3; i++) {
      insertRecommendation(db, makeRec('g1', {
        id: `r${i}`,
        fingerprint: recommendationFingerprint('g1', 'ask_user',
          JSON.stringify({ kind: 'ask_user', question: `Q${i}?` })),
      }));
    }
    const first = listRecommendationsByGoal(db, { goalId: 'g1', limit: 2 });
    expect(first.recommendations).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = listRecommendationsByGoal(db, { goalId: 'g1', limit: 2, cursor: first.nextCursor! });
    expect(second.recommendations).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('returns no nextCursor when all fit', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertRecommendation(db, makeRec('g1'));
    const { nextCursor } = listRecommendationsByGoal(db, { goalId: 'g1', limit: 10 });
    expect(nextCursor).toBeNull();
  });
});

describe('active fingerprint uniqueness', () => {
  it('rejects duplicate proposed fingerprint via DB constraint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const rec = makeRec('g1');
    insertRecommendation(db, rec);
    expect(() => insertRecommendation(db, { ...rec, id: 'rec-dupe' })).toThrow();
  });

  it('allows same fingerprint after status leaves proposed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const rec = makeRec('g1');
    insertRecommendation(db, rec);
    updateRecommendationStatusRow(db, 'rec-1', 'accepted', NOW, NOW);
    expect(() =>
      insertRecommendation(db, { ...rec, id: 'rec-2', status: 'proposed' })
    ).not.toThrow();
  });

  it('modified row does not block new proposed with same fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertRecommendation(db, makeRec('g1'));
    updateRecommendationStatusRow(db, 'rec-1', 'modified', null as unknown as string, NOW);
    // Modified rows are NOT in the partial index (status = 'proposed' only),
    // so a new 'proposed' row with the same fingerprint can be inserted.
    expect(() =>
      insertRecommendation(db, { ...makeRec('g1'), id: 'rec-new', status: 'proposed' })
    ).not.toThrow();
  });
});

describe('generation lifecycle', () => {
  const GEN_ID = 'gen-1';

  function makeGenInput(goalId: string) {
    return {
      id: GEN_ID,
      goalId,
      trigger: 'manual' as const,
      triggerSourceId: null,
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      inputFingerprint: 'inputfp',
      requestFingerprint: recommendationGenerationRequestFingerprint(
        goalId, 'manual', null, 'test-provider', '0.1.0', 'inputfp'
      ),
      requestedAt: NOW,
    };
  }

  it('inserts a pending generation and returns isNew=true', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation, isNew } = insertOrGetPendingRecommendationGeneration(db, makeGenInput('g1'));
    expect(isNew).toBe(true);
    expect(generation.id).toBe(GEN_ID);
    expect(generation.status).toBe('pending');
  });

  it('returns existing on duplicate insert (isNew=false)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertOrGetPendingRecommendationGeneration(db, makeGenInput('g1'));
    const { isNew, generation } = insertOrGetPendingRecommendationGeneration(db, {
      ...makeGenInput('g1'),
      id: 'gen-2',
    });
    expect(isNew).toBe(false);
    expect(generation.id).toBe(GEN_ID);
  });

  it('transitions pending → running → succeeded', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertOrGetPendingRecommendationGeneration(db, makeGenInput('g1'));
    markRecommendationGenerationRunning(db, GEN_ID, NOW);
    const running = getRecommendationGenerationById(db, GEN_ID);
    expect(running!.status).toBe('running');

    markRecommendationGenerationSucceeded(db, GEN_ID, ['r1', 'r2'], ['r0'], false, NOW);
    const done = getRecommendationGenerationById(db, GEN_ID);
    expect(done!.status).toBe('succeeded');
    expect(done!.sparse).toBe(false);
  });

  it('transitions pending → running → failed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertOrGetPendingRecommendationGeneration(db, makeGenInput('g1'));
    markRecommendationGenerationRunning(db, GEN_ID, NOW);
    markRecommendationGenerationFailed(db, GEN_ID, 'provider_error', 'something went wrong', NOW);
    const gen = getRecommendationGenerationById(db, GEN_ID);
    expect(gen!.status).toBe('failed');
    expect(gen!.failureCode).toBe('provider_error');
  });

  it('failed row excluded from active idempotency (retry creates new row)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const input = makeGenInput('g1');
    insertOrGetPendingRecommendationGeneration(db, input);
    markRecommendationGenerationRunning(db, GEN_ID, NOW);
    markRecommendationGenerationFailed(db, GEN_ID, 'internal_error', null, NOW);

    const { isNew, generation } = insertOrGetPendingRecommendationGeneration(db, {
      ...input,
      id: 'gen-retry',
    });
    expect(isNew).toBe(true);
    expect(generation.id).toBe('gen-retry');
  });

  it('getActiveRecommendationGenerationByFp returns null for failed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const input = makeGenInput('g1');
    insertOrGetPendingRecommendationGeneration(db, input);
    markRecommendationGenerationFailed(db, GEN_ID, 'internal_error', null, NOW);
    const active = getActiveRecommendationGenerationByFp(db, 'g1', input.requestFingerprint);
    expect(active).toBeNull();
  });

  it('listRecommendationGenerationsByGoal returns most recent first', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const now1 = '2026-01-01T00:00:00.000Z';
    const now2 = '2026-01-02T00:00:00.000Z';
    insertOrGetPendingRecommendationGeneration(db, { ...makeGenInput('g1'), requestedAt: now1 });
    markRecommendationGenerationFailed(db, GEN_ID, 'internal_error', null, now1);
    const fp2 = recommendationGenerationRequestFingerprint('g1', 'manual', 'src2', 'test-provider', '0.1.0', 'inputfp');
    insertOrGetPendingRecommendationGeneration(db, {
      ...makeGenInput('g1'),
      id: 'gen-2',
      triggerSourceId: 'src2',
      requestFingerprint: fp2,
      requestedAt: now2,
    });
    const gens = listRecommendationGenerationsByGoal(db, 'g1', 10);
    expect(gens[0].id).toBe('gen-2');
    expect(gens[1].id).toBe('gen-1');
  });
});
