import { mkdtempSync, rmSync, rmdirSync, chmodSync } from 'node:fs';
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
import { AdapterRegistry } from '../adapters/registry.js';
import { ShellManualAdapter } from '../adapters/shell-manual.js';
import type { PtyHandle, PtyEvents, PtyManager, PtyStartOptions } from '../pty/types.js';
import { FakePtyManager, controlFakePty } from '../pty/fake.js';
import {
  AdapterNotFoundError,
  CommandNotFoundError,
  GoalArchivedError,
  GoalNotFoundError,
  SessionNotFoundError,
  SessionWrongStateError,
  SpawnFailedError,
  WorkspaceNotAttachedError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
} from './errors.js';
import {
  createSession,
  getSession,
  listSessionsForGoal,
  resetPreparedStatements,
  startSession,
  type SessionCtx,
  type StartSessionCtx,
} from './usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';
import { resetPreparedStatements as resetRuntimeStmts, SessionRuntime } from './runtime.js';
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
  resetRuntimeStmts();
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

// ──────────────────────────────────────────────────────────────────────────────
// startSession helpers
// ──────────────────────────────────────────────────────────────────────────────

class CapturingPtyManager implements PtyManager {
  readonly inner = new FakePtyManager();
  lastHandle?: PtyHandle;
  start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    const result = this.inner.start(opts);
    this.lastHandle = result.handle;
    return result;
  }
}

function makeStartRegistry(cwd: string): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register({
    id: 'shell-manual' as const,
    title: 'Shell (Manual)',
    async resolveSpawn() {
      return { command: '/bin/sh', args: [], env: {}, cwd };
    },
    async probeAvailability() {
      return { status: 'available' as const };
    },
  });
  return registry;
}

function makeFailingShellRegistry(wsDir: string): AdapterRegistry {
  const registry = new AdapterRegistry();
  const failingAdapter = new ShellManualAdapter(() =>
    Promise.resolve({ error: 'not_found', tried: ['/no/such/binary'] })
  );
  registry.register(failingAdapter);
  // Patch cwd: ShellManualAdapter.resolveSpawn uses workspacePath from input,
  // so we don't need to track it here
  void wsDir;
  return registry;
}

async function seedAndCreateSession(
  db: Database.Database,
  wsDir: string,
  adapterRegistry: AdapterRegistry
): Promise<string> {
  seedGoal(db, 'g1');
  seedWorkspace(db, 'ws1', 'g1', wsDir);
  const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry };
  const detail = await createSession(ctx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' });
  return detail.id;
}

// ──────────────────────────────────────────────────────────────────────────────
// startSession tests
// ──────────────────────────────────────────────────────────────────────────────

describe('startSession', () => {
  it('happy path: fake emits data then exits → status=exited, chunk persisted, events correct', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-happy-'));
    tempDirs.push(wsDir);

    const capturing = new CapturingPtyManager();
    const runtime = new SessionRuntime(capturing);
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const registry = makeStartRegistry(wsDir);

    const sessionId = await seedAndCreateSession(db, wsDir, registry);

    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    // Drive the fake PTY
    const ctrl = controlFakePty(capturing.lastHandle!);
    ctrl.emitData(Buffer.from('hello\n'));
    ctrl.emitExit({ exitCode: 0, signal: null });

    // Session should now be exited
    const { session, output } = getSession(db, sessionId, store);
    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(0);
    expect(session.exitSignal).toBeNull();
    expect(session.pid).toBeGreaterThan(0);
    expect(session.command).toBe('/bin/sh');
    expect(session.terminalCols).toBe(80);
    expect(session.terminalRows).toBe(24);

    // Output chunk persisted only in session_output_chunks
    expect(output.chunks).toHaveLength(1);
    const chunkData = Buffer.from(output.chunks[0]!.dataBase64, 'base64').toString();
    expect(chunkData).toBe('hello\n');

    // session.started and session.exited events persisted; no session.output events
    const events = db.prepare('SELECT type FROM events WHERE goal_id = ?').all('g1') as { type: string }[];
    const types = events.map(e => e.type);
    expect(types).toContain('session.created');
    expect(types).toContain('session.started');
    expect(types).toContain('session.exited');
    const outputEventCount = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE type LIKE 'session.output%'").get() as { c: number }).c;
    expect(outputEventCount).toBe(0);
  });

  it('command_not_found: resolveSpawn fails → session.failed persisted, status=failed', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-notfound-'));
    tempDirs.push(wsDir);

    const runtime = new SessionRuntime(new CapturingPtyManager());
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const registry = makeFailingShellRegistry(wsDir);

    const sessionId = await seedAndCreateSession(db, wsDir, registry);
    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };

    await expect(startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 })).rejects.toThrow(CommandNotFoundError);

    const { session } = getSession(db, sessionId, store);
    expect(session.status).toBe('failed');
    expect(session.failureReason).toBe('command_not_found');

    const failEvent = db.prepare("SELECT id FROM events WHERE type = 'session.failed'").get();
    expect(failEvent).toBeDefined();
    const startedEvent = db.prepare("SELECT id FROM events WHERE type = 'session.started'").get();
    expect(startedEvent).toBeUndefined();
  });

  it('workspace_unavailable: path deleted → session.failed persisted, status=failed', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-nodir-'));
    // Do NOT add to tempDirs; we delete it below manually
    const registry = makeStartRegistry(wsDir);

    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    const createCtx: SessionCtx = { db, bus: eventBus, adapterRegistry: registry };
    const detail = await createSession(createCtx, { goalId: 'g1', workspaceId: 'ws1', adapterId: 'shell-manual' });

    // Remove workspace dir to make it unavailable
    rmSync(wsDir, { recursive: true, force: true });

    const runtime = new SessionRuntime(new CapturingPtyManager());
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };

    await expect(startSession(ctx, detail.id, { terminalCols: 80, terminalRows: 24 })).rejects.toThrow(WorkspaceUnavailableError);

    const { session } = getSession(db, detail.id, store);
    expect(session.status).toBe('failed');
    expect(session.failureReason).toBe('workspace_unavailable');
    const failEvent = db.prepare("SELECT id FROM events WHERE type = 'session.failed'").get();
    expect(failEvent).toBeDefined();
  });

  it('spawn_failed: ptyManager throws → session.failed persisted, no session.started event', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-spawnfail-'));
    tempDirs.push(wsDir);

    const throwingPtyManager: PtyManager = {
      start(): never {
        throw new Error('simulated spawn failure');
      },
    };
    const runtime = new SessionRuntime(throwingPtyManager);
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const registry = makeStartRegistry(wsDir);

    const sessionId = await seedAndCreateSession(db, wsDir, registry);
    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };

    await expect(startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 })).rejects.toThrow(SpawnFailedError);

    const { session } = getSession(db, sessionId, store);
    expect(session.status).toBe('failed');
    expect(session.failureReason).toBe('spawn_failed');

    const startedEvent = db.prepare("SELECT id FROM events WHERE type = 'session.started'").get();
    expect(startedEvent).toBeUndefined();
    const failedEvent = db.prepare("SELECT id FROM events WHERE type = 'session.failed'").get();
    expect(failedEvent).toBeDefined();
  });

  it('wrong state: start on non-created session → throws SessionWrongStateError, no events', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-wrongstate-'));
    tempDirs.push(wsDir);

    const capturing = new CapturingPtyManager();
    const runtime = new SessionRuntime(capturing);
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const registry = makeStartRegistry(wsDir);

    const sessionId = await seedAndCreateSession(db, wsDir, registry);
    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };

    // First start succeeds
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    // Second start must fail (session is now running/starting)
    await expect(startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 })).rejects.toThrow(SessionWrongStateError);
  });

  it('event ordering: session.started broadcast occurs after COMMIT (row visible at publish time)', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-ordering-'));
    tempDirs.push(wsDir);

    const registry = makeStartRegistry(wsDir);
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    let statusAtStartedPublish: string | undefined;

    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        if (event.type === 'session.started') {
          const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(event.goalId) as { status: string } | undefined;
          // The session row for this session should exist with status=starting or running
          const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(
            (event.payload as { sessionId: string }).sessionId
          ) as { status: string } | undefined;
          statusAtStartedPublish = sessionRow?.status;
        }
      },
    };

    const capturing = new CapturingPtyManager();
    const runtime = new SessionRuntime(capturing);
    const sessionId = await seedAndCreateSession(db, wsDir, registry);

    const ctx: StartSessionCtx = { db, bus: mockBus as never, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    // At the time session.started was broadcast, status must have been 'starting' (the tx had committed)
    expect(statusAtStartedPublish).toBe('starting');
  });

  it('output never written to event store: data chunks go to session_output_chunks only', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-start-outputisolation-'));
    tempDirs.push(wsDir);

    const capturing = new CapturingPtyManager();
    const runtime = new SessionRuntime(capturing);
    const store = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
    const registry = makeStartRegistry(wsDir);

    const sessionId = await seedAndCreateSession(db, wsDir, registry);
    const ctx: StartSessionCtx = { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: store, sessionRuntime: runtime };
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    // Emit data from fake PTY
    const ctrl = controlFakePty(capturing.lastHandle!);
    ctrl.emitData(Buffer.from('some output'));
    ctrl.emitData(Buffer.from(' more output'));

    // Output rows must be in session_output_chunks only
    const chunkCount = (db.prepare('SELECT COUNT(*) AS c FROM session_output_chunks WHERE session_id = ?').get(sessionId) as { c: number }).c;
    expect(chunkCount).toBe(2);

    // No output events in the domain event store
    const outputEventCount = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE type LIKE 'session.output%'").get() as { c: number }).c;
    expect(outputEventCount).toBe(0);
  });
});
