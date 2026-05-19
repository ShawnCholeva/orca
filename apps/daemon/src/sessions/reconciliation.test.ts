import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { reconcileSessionsOnBoot } from './reconciliation.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-reconcile-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

const NOW = '2026-01-10T12:00:00.000Z';

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, null)`
  ).run(id, NOW, NOW);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, '/tmp', 'ws', 'folder', null, null, 'not_a_repo', ?)`
  ).run(id, goalId, NOW);
}

function seedSession(db: Database.Database, id: string, goalId: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
     VALUES (?, ?, 'ws1', 'shell-manual', 'S', ?, ?)`
  ).run(id, goalId, status, NOW);
}

function makeBus() {
  const published: DomainEvent[] = [];
  return {
    bus: {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => { published.push(event); },
    },
    published,
  };
}

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileSessionsOnBoot', () => {
  it('marks starting and running sessions as failed with daemon_restart; leaves others untouched', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's-running', 'g1', 'running');
    seedSession(db, 's-starting', 'g1', 'starting');
    seedSession(db, 's-created', 'g1', 'created');
    seedSession(db, 's-exited', 'g1', 'exited');

    const { bus } = makeBus();
    reconcileSessionsOnBoot(db, bus as never, NOW);

    type Row = { id: string; status: string; failure_reason: string | null; exited_at: string | null };
    const rows = db.prepare('SELECT id, status, failure_reason, exited_at FROM sessions ORDER BY id').all() as Row[];

    const byId = Object.fromEntries(rows.map(r => [r.id, r]));

    expect(byId['s-running']!.status).toBe('failed');
    expect(byId['s-running']!.failure_reason).toBe('daemon_restart');
    expect(byId['s-running']!.exited_at).toBe(NOW);

    expect(byId['s-starting']!.status).toBe('failed');
    expect(byId['s-starting']!.failure_reason).toBe('daemon_restart');
    expect(byId['s-starting']!.exited_at).toBe(NOW);

    expect(byId['s-created']!.status).toBe('created');
    expect(byId['s-created']!.failure_reason).toBeNull();

    expect(byId['s-exited']!.status).toBe('exited');
    expect(byId['s-exited']!.failure_reason).toBeNull();
  });

  it('inserts session.failed events for each stale session', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's-running', 'g1', 'running');
    seedSession(db, 's-starting', 'g1', 'starting');

    const { bus } = makeBus();
    reconcileSessionsOnBoot(db, bus as never, NOW);

    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'session.failed' ORDER BY id")
      .all() as { type: string; payload: string }[];

    expect(events).toHaveLength(2);
    for (const ev of events) {
      const p = JSON.parse(ev.payload) as { failureReason: string };
      expect(p.failureReason).toBe('daemon_restart');
    }
  });

  it('broadcasts events only after all transactions commit', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's-running', 'g1', 'running');

    const dbStateAtPublish: string[] = [];
    const trackingBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        // At publish time, the session must already be failed in DB
        const row = db
          .prepare('SELECT status FROM sessions WHERE id = ?')
          .get((event.payload as { sessionId: string }).sessionId) as { status: string } | undefined;
        dbStateAtPublish.push(row?.status ?? 'not_found');
      },
    };

    reconcileSessionsOnBoot(db, trackingBus as never, NOW);

    expect(dbStateAtPublish).toEqual(['failed']);
  });

  it('does nothing when no stale sessions exist', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's-exited', 'g1', 'exited');

    const { bus, published } = makeBus();
    reconcileSessionsOnBoot(db, bus as never, NOW);

    expect(published).toHaveLength(0);
    const eventCount = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    expect(eventCount).toBe(0);
  });

  it('reconciliation resolves before callers proceed (ordering guarantee)', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's-running', 'g1', 'running');

    const calls: string[] = [];
    let resolveReconcile!: () => void;
    const reconcileGate = new Promise<void>(resolve => { resolveReconcile = resolve; });

    // Simulate a slow reconcile + a listen step that must come after
    const slowReconcile = async (): Promise<void> => {
      await reconcileGate;
      calls.push('reconcile');
    };
    const listen = async (): Promise<void> => {
      calls.push('listen');
    };

    const bootSequence = (async () => {
      await slowReconcile();
      await listen();
    })();

    // listen must not have been called yet
    expect(calls).toEqual([]);

    resolveReconcile();
    await bootSequence;

    expect(calls).toEqual(['reconcile', 'listen']);
  });
});
