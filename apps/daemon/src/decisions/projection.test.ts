import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import type { GoalDecision } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  getDecisionById,
  insertDecision,
  listDecisionsByGoal,
  resetPreparedStatements,
  updateDecision,
} from './projection.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(dataDir?: string): Database.Database {
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'orca-decisions-projection-'));
  if (!dataDir) {
    tempDirs.push(dir);
  }
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
}

function decisionRow(overrides: Partial<GoalDecision> = {}): GoalDecision {
  return {
    id: overrides.id ?? 'dec-1',
    goalId: overrides.goalId ?? 'goal-1',
    title: overrides.title ?? 'Use SQLite',
    decisionText: overrides.decisionText ?? 'Use SQLite as the only internal storage boundary.',
    rationale: overrides.rationale ?? null,
    status: overrides.status ?? 'proposed',
    confirmationRequired: overrides.confirmationRequired ?? false,
    confidence: overrides.confidence ?? null,
    sourceType: overrides.sourceType ?? 'manual',
    sourceId: overrides.sourceId ?? null,
    sourceSessionId: overrides.sourceSessionId ?? null,
    sourceExtractionId: overrides.sourceExtractionId ?? null,
    sourceOffsetFirst: overrides.sourceOffsetFirst ?? null,
    sourceOffsetLast: overrides.sourceOffsetLast ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    confirmedAt: overrides.confirmedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('decision projections', () => {
  it('inserts, updates, and reads a decision', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    insertDecision(db, decisionRow());
    updateDecision(db, 'dec-1', {
      status: 'confirmed',
      rationale: 'Keeps the state boundary simple and deterministic.',
      updatedAt: '2026-01-02T00:00:00.000Z',
      confirmedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(getDecisionById(db, 'dec-1')).toEqual(
      decisionRow({
        status: 'confirmed',
        rationale: 'Keeps the state boundary simple and deterministic.',
        updatedAt: '2026-01-02T00:00:00.000Z',
        confirmedAt: '2026-01-02T00:00:00.000Z',
      })
    );
  });

  it('survives database reopen', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-decisions-projection-reopen-'));
    tempDirs.push(dir);

    let db = openTestDb(dir);
    seedGoal(db, 'goal-1');
    insertDecision(db, decisionRow());

    closeDatabase();
    resetPreparedStatements();

    db = openTestDb(dir);
    expect(getDecisionById(db, 'dec-1')).toEqual(decisionRow());
  });

  it('lists decisions for one goal in status groups with archived last', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');

    insertDecision(
      db,
      decisionRow({
        id: 'confirmed',
        status: 'confirmed',
        title: 'Confirmed',
        decisionText: 'Confirmed decision',
        confirmedAt: '2026-01-03T00:00:00.000Z',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
    );
    insertDecision(
      db,
      decisionRow({
        id: 'proposed-newer',
        title: 'Proposed newer',
        decisionText: 'Proposed decision newer',
        createdAt: '2026-01-04T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      })
    );
    insertDecision(
      db,
      decisionRow({
        id: 'archived',
        status: 'archived',
        title: 'Archived',
        decisionText: 'Archived decision',
        archivedAt: '2026-01-05T00:00:00.000Z',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
      })
    );
    insertDecision(
      db,
      decisionRow({
        id: 'proposed-older',
        title: 'Proposed older',
        decisionText: 'Proposed decision older',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
    );
    insertDecision(
      db,
      decisionRow({
        id: 'other-goal',
        goalId: 'goal-2',
        title: 'Other goal',
        decisionText: 'Other goal decision',
      })
    );

    expect(listDecisionsByGoal(db, 'goal-1').map((decision) => decision.id)).toEqual([
      'proposed-newer',
      'proposed-older',
      'confirmed',
      'archived',
    ]);
  });
});
