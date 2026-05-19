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
  CommandNotFoundError,
  SessionNotFoundError,
  SessionNotStoppableError,
  SessionWrongStateError,
  SpawnFailedError,
  WorkspaceUnavailableError,
} from './errors.js';

export interface RuntimeCtx {
  db: Database.Database;
  bus: EventBus;
  adapterRegistry: AdapterRegistry;
  sessionOutputStore: SessionOutputStore;
}

// Minimal WS client interface; ws.WebSocket satisfies this shape.
export interface WsClient {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_CLIENT_OPEN = 1;

interface HandleSlot {
  handle: PtyHandle;
  stopRequested: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

// Module-level prepared statement cache (invalidated when db instance changes)
let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  selectWorkspace: Database.Statement;
  setRunning: Database.Statement;
  updateTerminalSize: Database.Statement;
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
      updateTerminalSize: db.prepare(
        'UPDATE sessions SET terminal_cols = ?, terminal_rows = ? WHERE id = ?'
      ),
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
  private readonly handleSlots = new Map<string, HandleSlot>();
  private readonly subscriberMap = new Map<string, Set<WsClient>>();
  private readonly lastResizeMap = new Map<string, { cols: number; rows: number }>();
  private readonly ptyManager: PtyManager;
  private readonly stopGraceMs: number;
  private readonly wsBufferLimitBytes: number;

  constructor(ptyManager: PtyManager, stopGraceMs = 5000, wsBufferLimitBytes = 1024 * 1024) {
    this.ptyManager = ptyManager;
    this.stopGraceMs = stopGraceMs;
    this.wsBufferLimitBytes = wsBufferLimitBytes;
  }

  // Broadcast a session.output frame to all live subscribers for sessionId.
  // Slow consumers (bufferedAmount exceeds limit) are closed and removed.
  private broadcastOutput(sessionId: string, seq: number, byteOffset: number, chunk: Buffer): void {
    const subscribers = this.subscriberMap.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;

    const frame = JSON.stringify({
      type: 'session.output',
      sessionId,
      seq,
      byteOffset,
      dataBase64: chunk.toString('base64'),
    });

    for (const socket of [...subscribers]) {
      if (socket.readyState !== WS_CLIENT_OPEN) {
        subscribers.delete(socket);
        continue;
      }
      try {
        socket.send(frame);
        if (socket.bufferedAmount > this.wsBufferLimitBytes) {
          socket.close(1008, 'slow consumer');
          subscribers.delete(socket);
        }
      } catch {
        subscribers.delete(socket);
      }
    }
  }

  // Add a WS client as a subscriber for a session.
  subscribe(sessionId: string, socket: WsClient): void {
    let subscribers = this.subscriberMap.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriberMap.set(sessionId, subscribers);
    }
    subscribers.add(socket);
  }

  // Remove a WS client from a specific session's subscriber list.
  unsubscribeSocket(sessionId: string, socket: WsClient): void {
    this.subscriberMap.get(sessionId)?.delete(socket);
  }

  // Remove a WS client from all session subscriber lists (called on WS close).
  removeSocket(socket: WsClient): void {
    for (const subscribers of this.subscriberMap.values()) {
      subscribers.delete(socket);
    }
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

    const slot: HandleSlot = { handle, stopRequested: false, killTimer: null };
    this.handleSlots.set(sessionId, slot);

    ptyEvents.onData((chunk: Buffer) => {
      const { seq, byteOffset } = sessionOutputStore.appendChunk(sessionId, chunk);
      this.broadcastOutput(sessionId, seq, byteOffset, chunk);
    });

    // Exactly one terminal lifecycle event per process: stopped (user-requested) or exited (natural).
    ptyEvents.onExit(({ exitCode, signal }) => {
      const currentSlot = this.handleSlots.get(sessionId);
      const wasStopRequested = currentSlot?.stopRequested ?? false;
      if (currentSlot?.killTimer != null) clearTimeout(currentSlot.killTimer);
      this.handleSlots.delete(sessionId);

      const exitedAt = new Date().toISOString();

      if (wasStopRequested) {
        const payload = { sessionId, goalId: session.goalId, exitCode, exitSignal: signal, reason: 'user_request' };
        let stoppedEvent!: DomainEvent;
        db.transaction(() => {
          setSessionStatus(db, sessionId, 'stopped', { exitCode, exitSignal: signal, exitedAt });
          stoppedEvent = insertEvent(db, 'session.stopped', session.goalId, payload, exitedAt);
        })();
        bus.publish(stoppedEvent);
      } else {
        const payload = { sessionId, goalId: session.goalId, exitCode, exitSignal: signal };
        let exitedEvent!: DomainEvent;
        db.transaction(() => {
          setSessionStatus(db, sessionId, 'exited', { exitCode, exitSignal: signal, exitedAt });
          exitedEvent = insertEvent(db, 'session.exited', session.goalId, payload, exitedAt);
        })();
        bus.publish(exitedEvent);
      }
    });

    return getSessionDetail(db, sessionId)!;
  }

  // Initiate a user-requested stop. Sends SIGTERM; escalates to SIGKILL after stopGraceMs.
  // Exactly one terminal event (session.stopped) will be committed when the process exits.
  stop(db: Database.Database, sessionId: string): void {
    const slot = this.handleSlots.get(sessionId);
    if (!slot) {
      const session = getSessionDetail(db, sessionId);
      if (!session) throw new SessionNotFoundError(sessionId);
      throw new SessionNotStoppableError(sessionId, session.status);
    }

    if (slot.stopRequested) return;

    slot.stopRequested = true;
    slot.handle.kill('SIGTERM');

    slot.killTimer = setTimeout(() => {
      slot.killTimer = null;
      if (this.handleSlots.has(sessionId)) {
        slot.handle.kill('SIGKILL');
      }
    }, this.stopGraceMs);
  }

  getHandle(sessionId: string): PtyHandle | undefined {
    return this.handleSlots.get(sessionId)?.handle;
  }

  // Update terminal size without emitting a domain event.
  // Deduplicates: only forwards to PTY handle if dimensions changed.
  resize(db: Database.Database, sessionId: string, cols: number, rows: number): void {
    const slot = this.handleSlots.get(sessionId);
    if (!slot) return;

    const last = this.lastResizeMap.get(sessionId);
    if (last && last.cols === cols && last.rows === rows) return;

    this.lastResizeMap.set(sessionId, { cols, rows });
    slot.handle.resize(cols, rows);

    // Update DB without emitting a domain event
    ensureStmts(db).updateTerminalSize.run(cols, rows, sessionId);
  }
}
