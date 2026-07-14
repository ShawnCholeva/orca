import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { insertRecommendation } from './projection.js';
import {
  insertFeedback,
  getFeedbackById,
  getFeedbackByRecommendationId,
  getTerminalFeedbackByRecommendationId,
  resetFeedbackStatements,
} from './feedback.js';
import { recommendationFingerprint } from './fingerprint.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';
const PROPOSED_ACTION_JSON = JSON.stringify({ kind: 'ask_user', question: 'Proceed?' });

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-rec-fb-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoalAndRec(db: Database.Database, goalId = 'g1', recId = 'rec-1') {
  const now = NOW;
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, now, now);
  insertRecommendation(db, {
    id: recId,
    goalId,
    generationId: null,
    type: 'ask_user',
    status: 'proposed',
    source: 'deterministic_provider',
    title: 'Test',
    rationale: 'Test',
    proposedActionJson: PROPOSED_ACTION_JSON,
    confidence: 0.8,
    sourcesJson: '[]',
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: null,
    fingerprint: recommendationFingerprint('g1', 'ask_user', PROPOSED_ACTION_JSON),
    supersededById: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

afterEach(() => {
  closeDatabase();
  resetFeedbackStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('insertFeedback / getFeedbackById', () => {
  it('inserts and retrieves feedback', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, {
      id: 'fb-1',
      goalId: 'g1',
      recommendationId: 'rec-1',
      action: 'accept',
      note: null,
      modifiedPayloadJson: null,
      createdAt: NOW,
    });
    const fb = getFeedbackById(db, 'fb-1');
    expect(fb).not.toBeNull();
    expect(fb!.action).toBe('accept');
    expect(fb!.recommendationId).toBe('rec-1');
    expect(fb!.goalId).toBe('g1');
    expect(fb!.note).toBeNull();
    expect(fb!.modifiedPayloadJson).toBeNull();
  });
});

describe('terminal-action one-shot constraint', () => {
  it('rejects second accept feedback for same recommendation', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'accept', note: null, modifiedPayloadJson: null, createdAt: NOW });
    expect(() =>
      insertFeedback(db, { id: 'fb-2', goalId: 'g1', recommendationId: 'rec-1', action: 'accept', note: null, modifiedPayloadJson: null, createdAt: NOW })
    ).toThrow();
  });

  it('rejects second reject feedback for same recommendation', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'reject', note: null, modifiedPayloadJson: null, createdAt: NOW });
    expect(() =>
      insertFeedback(db, { id: 'fb-2', goalId: 'g1', recommendationId: 'rec-1', action: 'reject', note: null, modifiedPayloadJson: null, createdAt: NOW })
    ).toThrow();
  });

  it('rejects second dismiss feedback for same recommendation', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'dismiss', note: null, modifiedPayloadJson: null, createdAt: NOW });
    expect(() =>
      insertFeedback(db, { id: 'fb-2', goalId: 'g1', recommendationId: 'rec-1', action: 'dismiss', note: null, modifiedPayloadJson: null, createdAt: NOW })
    ).toThrow();
  });

  it('allows multiple modify feedback rows for same recommendation', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'modify', note: null, modifiedPayloadJson: '{}', createdAt: NOW });
    expect(() =>
      insertFeedback(db, { id: 'fb-2', goalId: 'g1', recommendationId: 'rec-1', action: 'modify', note: null, modifiedPayloadJson: '{}', createdAt: NOW })
    ).not.toThrow();
  });
});

describe('getFeedbackByRecommendationId', () => {
  it('returns feedback in chronological order', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'modify', note: null, modifiedPayloadJson: null, createdAt: '2026-01-01T00:00:00.000Z' });
    insertFeedback(db, { id: 'fb-2', goalId: 'g1', recommendationId: 'rec-1', action: 'accept', note: null, modifiedPayloadJson: null, createdAt: '2026-01-02T00:00:00.000Z' });
    const fbs = getFeedbackByRecommendationId(db, 'rec-1');
    expect(fbs).toHaveLength(2);
    expect(fbs[0].action).toBe('modify');
    expect(fbs[1].action).toBe('accept');
  });

  it('returns empty array for unknown recommendation', () => {
    const db = freshDb();
    expect(getFeedbackByRecommendationId(db, 'nope')).toHaveLength(0);
  });
});

describe('getTerminalFeedbackByRecommendationId', () => {
  it('returns null when no terminal feedback', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'modify', note: null, modifiedPayloadJson: null, createdAt: NOW });
    expect(getTerminalFeedbackByRecommendationId(db, 'rec-1')).toBeNull();
  });

  it('returns accept feedback when present', () => {
    const db = freshDb();
    seedGoalAndRec(db);
    insertFeedback(db, { id: 'fb-1', goalId: 'g1', recommendationId: 'rec-1', action: 'accept', note: null, modifiedPayloadJson: null, createdAt: NOW });
    const fb = getTerminalFeedbackByRecommendationId(db, 'rec-1');
    expect(fb).not.toBeNull();
    expect(fb!.action).toBe('accept');
  });
});
