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
let _insertEventStmt: Database.Statement | null = null;

function getInsertEventStmt(db: Database.Database): Database.Statement {
  if (db !== _db) {
    _db = db;
    _insertEventStmt = db.prepare(
      'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
  }
  return _insertEventStmt!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _insertEventStmt = null;
}

function insertEvent(
  db: Database.Database,
  type: DomainEventType,
  goalId: string,
  payload: Record<string, unknown>,
  createdAt: string
): DomainEvent {
  const id = randomUUID();
  const result = getInsertEventStmt(db).run(id, type, goalId, JSON.stringify(payload), createdAt);
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
  // Spawn-before-event ordering: PTY spawned first so pid is known before the started tx commits.
  // onExit checks stopRequested (added in M4-009) to choose session.exited vs session.stopped.
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
    const now = new Date().toISOString();

    // 1. Load and validate session state
    const session = getSessionDetail(db, sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    if (session.status !== 'created') throw new SessionWrongStateError(sessionId, session.status);

    // 2. Validate workspace path is accessible
    const wsRow = db
      .prepare('SELECT id, path FROM workspaces WHERE id = ?')
      .get(session.workspaceId) as { id: string; path: string } | undefined;
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

    // 3. Resolve adapter spawn command
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

    // 4. Spawn PTY — pid is now known before writing session.started
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

    // 5. Single tx: status=starting + session.started event (pid known, spawn succeeded)
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

    // Broadcast after COMMIT
    bus.publish(startedEvent);

    // 6. Fold status=running into a second small tx (spawn handle confirmed alive)
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('running', sessionId);

    // 7. Track live handle
    this.handles.set(sessionId, handle);

    // 8. Data handler: persist chunks only (broadcast wired in M4-010)
    ptyEvents.onData((chunk: Buffer) => {
      sessionOutputStore.appendChunk(sessionId, chunk);
    });

    // 9. Exit handler: exactly one terminal lifecycle event per process
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
