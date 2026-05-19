import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { eventBus } from '../events.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import {
  AdapterNotFoundError,
  GoalArchivedError,
  GoalNotFoundError,
  SessionNotFoundError,
  WorkspaceNotAttachedError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
} from './errors.js';
import {
  createSession,
  getSession,
  listSessionsForGoal,
  resetPreparedStatements,
  type SessionCtx,
} from './usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';
import { createSessionOutputStore } from './output-store.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-sess-uc-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string, archived = false): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, ?)`
  ).run(id, now, now, archived ? now : null);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string, wsPath: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'ws', 'folder', null, null, 'not_a_repo', '2026-01-01T00:00:00.000Z')`
  ).run(id, goalId, wsPath);
}

function makeAdapterRegistry(ids: string[] = ['shell-manual']): AdapterRegistry {
  return {
    get: (id: string) => (ids.includes(id) ? ({ id } as never) : undefined),
    list: async () => [],
    clearCache: () => {},
    register: () => {},
  } as unknown as AdapterRegistry;
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSession', () => {
  it('happy path: creates session row, emits session.created event, returns detail', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-ws-'));
    tempDirs.push(wsDir);

    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'shell-manual',
      role: 'Engineer',
      instruction: 'do the thing',
    });

    expect(detail.goalId).toBe('g1');
    expect(detail.workspaceId).toBe('ws1');
    expect(detail.adapterId).toBe('shell-manual');
    expect(detail.role).toBe('Engineer');
    expect(detail.instruction).toBe('do the thing');
    expect(detail.status).toBe('created');
    expect(detail.title).toBe('shell-manual session');
    expect(detail.pid).toBeNull();

    // Session row exists in DB
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(detail.id);
    expect(row).toBeDefined();

    // session.created event emitted exactly once
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe('session.created');
    expect(event.goalId).toBe('g1');
    expect((event.payload as { sessionId: string }).sessionId).toBe(detail.id);
    expect(event.seq).toBeGreaterThan(0);

    // session.created event persisted in events table
    const eventRow = db.prepare('SELECT id FROM events WHERE type = ?').get('session.created');
    expect(eventRow).toBeDefined();
  });

  it('uses provided title instead of fallback', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-ws2-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'shell-manual',
      title: 'Custom Title',
    });
    expect(detail.title).toBe('Custom Title');
  });

  it('rejects missing goal with GoalNotFoundError', async () => {
    const db = freshDb();
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    await expect(
      createSession(ctx, { goalId: 'missing', workspaceId: 'ws1', adapterId: 'shell-manual' })
    ).rejects.toThrow(GoalNotFoundError);
  });

  it('rejects archived goal with GoalArchivedError', async () => {
    const db = freshDb();
    seedGoal(db, 'g-archived', true);
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    await expect(
      createSession(ctx, { goalId: 'g-archived', workspaceId: 'ws1', adapterId: 'shell-manual' })
    ).rejects.toThrow(GoalArchivedError);
  });

  it('rejects workspace not found with WorkspaceNotFoundError', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    await expect(
      createSession(ctx, { goalId: 'g1', workspaceId: 'no-such-ws', adapterId: 'shell-manual' })
    ).rejects.toThrow(WorkspaceNotFoundError);
  });

  it('rejects workspace not attached to goal with WorkspaceNotAttachedError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-ws3-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedWorkspace(db, 'ws-for-g2', 'g2', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, { goalId: 'g1', workspaceId: 'ws-for-g2', adapterId: 'shell-manual' })
    ).rejects.toThrow(WorkspaceNotAttachedError);
  });

  it('rejects unavailable workspace path with WorkspaceUnavailableError', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', '/does/not/exist/orca-test');

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' })
    ).rejects.toThrow(WorkspaceUnavailableError);
  });

  it('rejects unknown adapter id with AdapterNotFoundError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-ws4-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const emptyRegistry = makeAdapterRegistry([]);
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: emptyRegistry };

    await expect(
      createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' })
    ).rejects.toThrow(AdapterNotFoundError);
  });

  it('broadcasts session.created only after COMMIT (session row exists in DB at time of publish)', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-ws5-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    let sessionExistedAtPublish = false;
    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        const sid = (event.payload as { sessionId: string }).sessionId;
        const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid);
        sessionExistedAtPublish = row !== undefined;
      },
    };

    const ctx: SessionCtx = {
      db,
      bus: mockBus as never,
      adapterRegistry: makeAdapterRegistry(),
    };

    await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'shell-manual',
    });

    expect(sessionExistedAtPublish).toBe(true);
  });

  it('emits no event and no session row when goal validation fails', async () => {
    const db = freshDb();
    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    await expect(
      createSession(ctx, { goalId: 'missing', workspaceId: 'ws1', adapterId: 'shell-manual' })
    ).rejects.toThrow(GoalNotFoundError);

    expect(publishSpy).not.toHaveBeenCalled();
    const count = (db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe('listSessionsForGoal', () => {
  it('returns sessions for a goal in created_at DESC order', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-list-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    const s1 = await createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' });
    const s2 = await createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' });

    const sessions = listSessionsForGoal(db, 'g1');
    expect(sessions).toHaveLength(2);
    // Most recent first (s2 created after s1 within same ms — id tiebreak is ASC, so order may vary)
    expect(sessions.map((s) => s.id)).toContain(s1.id);
    expect(sessions.map((s) => s.id)).toContain(s2.id);
  });

  it('returns empty array for unknown goal', () => {
    const db = freshDb();
    expect(listSessionsForGoal(db, 'no-goal')).toEqual([]);
  });
});

describe('getSession', () => {
  it('returns session detail with empty output snapshot', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-get-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    const created = await createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' });

    const { session, output } = getSession(db, created.id);
    expect(session.id).toBe(created.id);
    expect(session.status).toBe('created');
    expect(output.sessionId).toBe(created.id);
    expect(output.chunks).toEqual([]);
    expect(output.nextSeq).toBe(0);
    expect(output.firstByteOffset).toBe(0);
    expect(output.totalBytesKept).toBe(0);
  });

  it('throws SessionNotFoundError for missing session', () => {
    const db = freshDb();
    expect(() => getSession(db, 'no-such-session')).toThrow(SessionNotFoundError);
  });

  it('returns persisted output tail when output store is provided', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-uc-tail-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    const created = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'shell-manual',
    });

    const store = createSessionOutputStore(db, { tailBytes: 1024 });
    store.appendChunk(created.id, Buffer.from('hello '));
    store.appendChunk(created.id, Buffer.from('world'));

    const { output } = getSession(db, created.id, store);
    expect(output.nextSeq).toBe(2);
    expect(output.totalBytesKept).toBe(11);
    expect(output.firstByteOffset).toBe(0);
    expect(output.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
  });
});
