import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { SessionDetail } from '@orca/contracts';
import type { DomainEvent, SessionOutputSnapshot, SessionSummary } from '@orca/contracts';
import type { EventBus } from '../events.js';
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
import { getSessionDetail, insertSession, listSessionsByGoal } from './projection.js';
import type { SessionOutputStore } from './output-store.js';
import { type RuntimeCtx, SessionRuntime } from './runtime.js';

export interface SessionCtx {
  db: Database.Database;
  bus: EventBus;
  adapterRegistry: AdapterRegistry;
  sessionOutputStore?: SessionOutputStore;
}

export interface StartSessionCtx extends SessionCtx {
  sessionOutputStore: SessionOutputStore;
  sessionRuntime: SessionRuntime;
}

interface GoalRow {
  id: string;
  archived_at: string | null;
}

interface WorkspaceRow {
  id: string;
  goal_id: string;
  path: string;
}

const EMPTY_OUTPUT: Omit<SessionOutputSnapshot, 'sessionId'> = {
  firstByteOffset: 0,
  nextSeq: 0,
  totalBytesKept: 0,
  chunks: [],
};

let _db: Database.Database | null = null;
let _stmts: {
  selectGoal: Database.Statement;
  selectWorkspace: Database.Statement;
  insertEvent: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectGoal: db.prepare('SELECT id, archived_at FROM goals WHERE id = ?'),
      selectWorkspace: db.prepare('SELECT id, goal_id, path FROM workspaces WHERE id = ?'),
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export async function createSession(
  ctx: SessionCtx,
  input: {
    goalId: string;
    workspaceId: string;
    adapterId: string;
    role?: string;
    instruction?: string;
    title?: string;
  }
): Promise<SessionDetail> {
  const { goalId, workspaceId, adapterId, role, instruction, title } = input;
  const stmts = ensureStmts(ctx.db);

  // Validate goal
  const goalRow = stmts.selectGoal.get(goalId) as GoalRow | undefined;
  if (!goalRow) throw new GoalNotFoundError(goalId);
  if (goalRow.archived_at !== null) throw new GoalArchivedError(goalId);

  // Validate workspace exists and is attached to this goal
  const wsRow = stmts.selectWorkspace.get(workspaceId) as WorkspaceRow | undefined;
  if (!wsRow) throw new WorkspaceNotFoundError(workspaceId);
  if (wsRow.goal_id !== goalId) throw new WorkspaceNotAttachedError(workspaceId, goalId);

  // Validate workspace path is accessible
  try {
    await access(wsRow.path);
  } catch {
    throw new WorkspaceUnavailableError(wsRow.path);
  }

  // Validate adapter exists in registry
  const adapter = ctx.adapterRegistry.get(adapterId);
  if (!adapter) throw new AdapterNotFoundError(adapterId);

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const resolvedTitle = title ?? `${adapterId} session`;

  let event!: DomainEvent;

  ctx.db.transaction(() => {
    insertSession(ctx.db, {
      id: sessionId,
      goalId,
      workspaceId,
      adapterId,
      role: role ?? null,
      instruction: instruction ?? null,
      title: resolvedTitle,
      status: 'created',
      createdAt: now,
    });

    const eventId = randomUUID();
    const payload = { sessionId, goalId, workspaceId, adapterId };
    const result = stmts.insertEvent.run(
      eventId,
      'session.created',
      goalId,
      JSON.stringify(payload),
      now
    );

    event = {
      seq: Number(result.lastInsertRowid),
      id: eventId,
      type: 'session.created',
      goalId,
      payload,
      createdAt: now,
    };
  })();

  // Broadcast only after COMMIT
  ctx.bus.publish(event);

  // Construct the detail from the already-known insert values rather than re-reading.
  return SessionDetail.parse({
    id: sessionId,
    goalId,
    workspaceId,
    adapterId,
    role: role ?? null,
    instruction: instruction ?? null,
    title: resolvedTitle,
    status: 'created',
    createdAt: now,
    startedAt: null,
    exitedAt: null,
    pid: null,
    command: null,
    args: null,
    cwd: null,
    terminalCols: null,
    terminalRows: null,
    exitCode: null,
    exitSignal: null,
    failureReason: null,
    failureDetail: null,
    archivedAt: null,
  });
}

export function listSessionsForGoal(
  db: Database.Database,
  goalId: string
): SessionSummary[] {
  return listSessionsByGoal(db, goalId);
}

export function getSession(
  db: Database.Database,
  sessionId: string,
  outputStore?: SessionOutputStore
): { session: SessionDetail; output: SessionOutputSnapshot } {
  const session = getSessionDetail(db, sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);

  const output: SessionOutputSnapshot = outputStore
    ? outputStore.readTail(sessionId)
    : { sessionId, ...EMPTY_OUTPUT };
  return { session, output };
}

export async function startSession(
  ctx: StartSessionCtx,
  sessionId: string,
  opts: { terminalCols: number; terminalRows: number }
): Promise<SessionDetail> {
  const runtimeCtx: RuntimeCtx = {
    db: ctx.db,
    bus: ctx.bus,
    adapterRegistry: ctx.adapterRegistry,
    sessionOutputStore: ctx.sessionOutputStore,
  };
  return ctx.sessionRuntime.start(runtimeCtx, sessionId, opts);
}

export interface StopSessionCtx {
  db: Database.Database;
  sessionRuntime: SessionRuntime;
}

export function stopSession(ctx: StopSessionCtx, sessionId: string): SessionDetail {
  ctx.sessionRuntime.stop(ctx.db, sessionId);
  return getSessionDetail(ctx.db, sessionId)!;
}
