import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  insertConflictRow,
  updateConflictStatusRow,
  getConflictById,
  getExistingOpenConflict,
  getLinkedResolveConflictRec,
  listConflictsByGoal,
  resetPreparedStatements,
} from './projection.js';
import { conflictFingerprint } from './fingerprint.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-conflicts-proj-'));
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

const BASE_CONFLICT = {
  goalId: 'g1',
  conflictType: 'workspace_overlap',
  severity: 'warning',
  title: 'Two sessions on same workspace',
  description: 'Sessions s1 and s2 share workspace w1',
  sourcesJson: JSON.stringify([{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }]),
  fingerprint: conflictFingerprint('g1', 'workspace_overlap', ['s1', 's2']),
  detectedAt: NOW,
} as const;

afterEach(() => {
  resetPreparedStatements();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('insertConflictRow', () => {
  it('inserts a new conflict and returns isNew=true', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { isNew } = insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    expect(isNew).toBe(true);
    const c = getConflictById(db, 'c1');
    expect(c).not.toBeNull();
    expect(c!.conflictType).toBe('workspace_overlap');
    expect(c!.status).toBe('open');
    expect(c!.severity).toBe('warning');
    expect(c!.title).toBe('Two sessions on same workspace');
    expect(c!.sources).toHaveLength(2);
  });

  it('returns isNew=false on duplicate open fingerprint (OR IGNORE)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    const { isNew } = insertConflictRow(db, { ...BASE_CONFLICT, id: 'c2' });
    expect(isNew).toBe(false);
    // Only c1 exists
    expect(getConflictById(db, 'c2')).toBeNull();
    expect(getConflictById(db, 'c1')).not.toBeNull();
  });

  it('allows second insert after the first is resolved (no longer open)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    updateConflictStatusRow(db, 'c1', 'resolved', null, NOW);
    const { isNew } = insertConflictRow(db, { ...BASE_CONFLICT, id: 'c2' });
    expect(isNew).toBe(true);
    expect(getConflictById(db, 'c2')!.status).toBe('open');
  });
});

describe('getExistingOpenConflict', () => {
  it('returns the open conflict with matching fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    const c = getExistingOpenConflict(db, 'g1', BASE_CONFLICT.fingerprint);
    expect(c).not.toBeNull();
    expect(c!.id).toBe('c1');
  });

  it('returns null when no open conflict with that fingerprint', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    expect(getExistingOpenConflict(db, 'g1', BASE_CONFLICT.fingerprint)).toBeNull();
  });

  it('returns null after conflict is resolved', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    updateConflictStatusRow(db, 'c1', 'resolved', null, NOW);
    expect(getExistingOpenConflict(db, 'g1', BASE_CONFLICT.fingerprint)).toBeNull();
  });
});

describe('updateConflictStatusRow', () => {
  it('sets status, resolution_note, resolved_at', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    updateConflictStatusRow(db, 'c1', 'resolved', 'Fixed it', NOW);
    const c = getConflictById(db, 'c1')!;
    expect(c.status).toBe('resolved');
    expect(c.resolutionNote).toBe('Fixed it');
    expect(c.resolvedAt).toBe(NOW);
  });
});

describe('listConflictsByGoal', () => {
  it('returns open conflicts by default', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    const fp2 = conflictFingerprint('g1', 'blocker_reported', ['m1']);
    insertConflictRow(db, {
      ...BASE_CONFLICT,
      id: 'c2',
      conflictType: 'blocker_reported',
      fingerprint: fp2,
    });
    const { conflicts } = listConflictsByGoal(db, { goalId: 'g1' });
    expect(conflicts).toHaveLength(2);
  });

  it('filters by status', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    updateConflictStatusRow(db, 'c1', 'resolved', null, NOW);
    const { conflicts: open } = listConflictsByGoal(db, { goalId: 'g1', status: 'open' });
    expect(open).toHaveLength(0);
    const { conflicts: resolved } = listConflictsByGoal(db, { goalId: 'g1', status: 'resolved' });
    expect(resolved).toHaveLength(1);
  });

  it('filters by severity', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    const fp2 = conflictFingerprint('g1', 'blocker_reported', ['m1']);
    insertConflictRow(db, {
      ...BASE_CONFLICT,
      id: 'c2',
      conflictType: 'blocker_reported',
      severity: 'blocker',
      fingerprint: fp2,
    });
    const { conflicts } = listConflictsByGoal(db, { goalId: 'g1', severity: 'blocker' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('c2');
  });

  it('paginates correctly', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    for (let i = 1; i <= 3; i++) {
      const fp = conflictFingerprint('g1', 'workspace_overlap', [`s${i}`]);
      insertConflictRow(db, {
        goalId: 'g1',
        conflictType: 'workspace_overlap',
        severity: 'warning',
        title: `C${i}`,
        description: 'desc',
        sourcesJson: JSON.stringify([{ type: 'session', id: `s${i}` }]),
        fingerprint: fp,
        detectedAt: `2026-01-0${i}T00:00:00.000Z`,
        id: `c${i}`,
      });
    }
    const { conflicts: page1, nextCursor } = listConflictsByGoal(db, {
      goalId: 'g1',
      limit: 2,
    });
    expect(page1).toHaveLength(2);
    expect(nextCursor).not.toBeNull();
    const { conflicts: page2, nextCursor: nc2 } = listConflictsByGoal(db, {
      goalId: 'g1',
      limit: 2,
      cursor: nextCursor!,
    });
    expect(page2).toHaveLength(1);
    expect(nc2).toBeNull();
  });
});

describe('getLinkedResolveConflictRec', () => {
  it('returns null when no linked recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    expect(getLinkedResolveConflictRec(db, 'c1')).toBeNull();
  });

  it('returns the linked recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    insertConflictRow(db, { ...BASE_CONFLICT, id: 'c1' });
    // Seed a resolve_conflict recommendation linked to c1
    db.prepare(`
      INSERT INTO recommendations
        (id, goal_id, generation_id, type, status, source, title, rationale,
         proposed_action_json, confidence, sources_json, related_task_id,
         related_session_id, related_context_pkg_id, related_conflict_id,
         fingerprint, superseded_by_id, superseded_reason, created_at, updated_at, resolved_at)
      VALUES (?, ?, NULL, 'resolve_conflict', 'proposed', 'deterministic_provider',
              'Resolve conflict', 'Resolve it',
              '{"kind":"resolve_conflict","conflictId":"c1"}', 1.0, '[]', NULL,
              NULL, NULL, ?, 'fp-r1', NULL, NULL, ?, ?, NULL)
    `).run('r1', 'g1', 'c1', NOW, NOW);

    const linked = getLinkedResolveConflictRec(db, 'c1');
    expect(linked).not.toBeNull();
    expect(linked!.id).toBe('r1');
    expect(linked!.status).toBe('proposed');
    expect(linked!.type).toBe('resolve_conflict');
  });
});
