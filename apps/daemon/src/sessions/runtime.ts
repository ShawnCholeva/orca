import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { DomainEvent, DomainEventType } from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { PtyEvents, PtyHandle, PtyManager } from '../pty/types.js';
import { getSessionDetail, setSessionStatus } from './projection.js';
import type { SessionOutputStore } from './output-store.js';
import {
  SessionNotFoundError,
  SessionWrongStateError,
  WorkspaceUnavailableError,
  CommandNotFoundError,
  SpawnFailedError,
} from './errors.js';

export interface RuntimeCtx {
  db: Database.Database;
  bus: EventBus;
  adapterRegistry: AdapterRegistry;
  sessionOutputStore: SessionOutputStore;
}

// Module-level prepared statement cache (invalidated when db instance changes)
let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  selectWorkspace: Database.Statement;
  setRunning: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
      selectWorkspace: db.prepare('SELECT id, path FROM workspaces WHERE id = ?'),
      setRunning: db.prepare('UPDATE sessions SET status = ? WHERE id = ?'),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function insertEvent(
  db: Database.Database,
  type: DomainEventType,
  goalId: string,
  payload: Record<string, unknown>,
  createdAt: string
): DomainEvent {
  const id = randomUUID();
  const result = ensureStmts(db).insertEvent.run(id, type, goalId, JSON.stringify(payload), createdAt);
  return { seq: Number(result.lastInsertRowid), id, type, goalId, payload, createdAt };
}

// Persist a session.failed event and mark status=failed in one transaction, then broadcast.
function persistFailure(
  db: Database.Database,
  bus: EventBus,
  sessionId: string,
  goalId: string,
  failureReason: string,
  now: string
): void {
  const payload = { sessionId, goalId, failureReason };
  let event!: DomainEvent;
  db.transaction(() => {
    setSessionStatus(db, sessionId, 'failed', { failureReason, exitedAt: now });
    event = insertEvent(db, 'session.failed', goalId, payload, now);
  })();
  bus.publish(event);
}

export class SessionRuntime {
  private readonly handles = new Map<string, PtyHandle>();
  private readonly ptyManager: PtyManager;

  constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager;
  }

  async start(
    ctx: RuntimeCtx,
    sessionId: string,
    opts: { terminalCols: number; terminalRows: number }
  ): Promise<import('@orca/contracts').SessionDetail> {
    const { db, bus, adapterRegistry, sessionOutputStore } = ctx;
    const { terminalCols, terminalRows } = opts;
    const stmts = ensureStmts(db);
    const now = new Date().toISOString();

    const session = getSessionDetail(db, sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    if (session.status !== 'created') throw new SessionWrongStateError(sessionId, session.status);

    const wsRow = stmts.selectWorkspace.get(session.workspaceId) as { id: string; path: string } | undefined;
    if (!wsRow) {
      persistFailure(db, bus, sessionId, session.goalId, 'workspace_unavailable', now);
      throw new WorkspaceUnavailableError('unknown');
    }
    try {
      await access(wsRow.path);
    } catch {
      persistFailure(db, bus, sessionId, session.goalId, 'workspace_unavailable', now);
      throw new WorkspaceUnavailableError(wsRow.path);
    }

    const adapter = adapterRegistry.get(session.adapterId);
    if (!adapter) {
      persistFailure(db, bus, sessionId, session.goalId, 'command_not_found', now);
      throw new CommandNotFoundError(session.adapterId);
    }
    let spawnResult: { command: string; args: string[]; env: Record<string, string>; cwd: string };
    try {
      spawnResult = await adapter.resolveSpawn({
        goalId: session.goalId,
        sessionId,
        workspacePath: wsRow.path,
        role: session.role ?? undefined,
        instruction: session.instruction ?? undefined,
      });
    } catch {
      persistFailure(db, bus, sessionId, session.goalId, 'command_not_found', now);
      throw new CommandNotFoundError(session.adapterId);
    }

    // Spawn-before-event ordering: pid is known before session.started tx commits.
    // If spawn throws, only session.failed is emitted (no session.started).
    let handle: PtyHandle;
    let ptyEvents: PtyEvents;
    try {
      const result = this.ptyManager.start({
        command: spawnResult.command,
        args: spawnResult.args,
        cwd: spawnResult.cwd,
        env: spawnResult.env,
        cols: terminalCols,
        rows: terminalRows,
      });
      handle = result.handle;
      ptyEvents = result.events;
    } catch (err) {
      persistFailure(db, bus, sessionId, session.goalId, 'spawn_failed', now);
      throw new SpawnFailedError(sessionId, err instanceof Error ? err.message : String(err));
    }

    const pid = handle.pid;
    const startedAt = new Date().toISOString();
    const startPayload = { sessionId, goalId: session.goalId, pid, cwd: spawnResult.cwd, terminalCols, terminalRows };

    let startedEvent!: DomainEvent;
    db.transaction(() => {
      setSessionStatus(db, sessionId, 'starting', {
        pid,
        command: spawnResult.command,
        argsJson: JSON.stringify(spawnResult.args),
        cwd: spawnResult.cwd,
        terminalCols,
        terminalRows,
        startedAt,
      });
      startedEvent = insertEvent(db, 'session.started', session.goalId, startPayload, startedAt);
    })();

    bus.publish(startedEvent);

    // Separate small tx: status=running (spawn handle confirmed alive post-commit)
    stmts.setRunning.run('running', sessionId);

    this.handles.set(sessionId, handle);

    ptyEvents.onData((chunk: Buffer) => {
      sessionOutputStore.appendChunk(sessionId, chunk);
    });

    // onExit: exactly one terminal lifecycle event per process (stopRequested check added in M4-009)
    ptyEvents.onExit(({ exitCode, signal }) => {
      const exitedAt = new Date().toISOString();
      const exitPayload = { sessionId, goalId: session.goalId, exitCode, exitSignal: signal };
      let exitedEvent!: DomainEvent;
      db.transaction(() => {
        setSessionStatus(db, sessionId, 'exited', { exitCode, exitSignal: signal, exitedAt });
        exitedEvent = insertEvent(db, 'session.exited', session.goalId, exitPayload, exitedAt);
      })();
      bus.publish(exitedEvent);
      this.handles.delete(sessionId);
    });

    return getSessionDetail(db, sessionId)!;
  }

  getHandle(sessionId: string): PtyHandle | undefined {
    return this.handles.get(sessionId);
  }
}
