import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { SessionDetail } from '@orca/contracts';
import type { DomainEvent, SessionOutputSnapshot, SessionSummary } from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import {
  AdapterNotFoundError,
  ArchivedTargetError,
  AssociationGoalMismatchError,
  ContextPackageMismatchError,
  ContextPackageNotFoundError,
  GoalArchivedError,
  GoalNotFoundError,
  InvalidRecommendationStateError,
  RecommendationNotFoundError,
  SessionNotFoundError,
  TaskNotFoundError,
  WorkspaceNotAttachedError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError,
} from './errors.js';
import { getSessionDetail, insertSession, listSessionsByGoal } from './projection.js';
import { getContextPackageMetaById } from '../context/projection.js';
import { getTaskById } from '../tasks/projection.js';
import { getRecommendationById } from '../recommendations/projection.js';
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
  onTerminalState?: (sessionId: string, goalId: string) => void;
  dataDir?: string;
}

interface GoalRow {
  id: string;
  archived_at: string | null;
}

interface WorkspaceRow {
  id: string;
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
  selectWorkspaceLink: Database.Statement;
  insertEvent: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectGoal: db.prepare('SELECT id, archived_at FROM goals WHERE id = ?'),
      selectWorkspace: db.prepare('SELECT id, path FROM workspaces WHERE id = ?'),
      selectWorkspaceLink: db.prepare('SELECT 1 FROM goal_workspaces WHERE workspace_id = ? AND goal_id = ?'),
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
    contextPackageId?: string;
    taskId?: string;
    fromRecommendationId?: string;
    role?: string;
    instruction?: string;
    title?: string;
  }
): Promise<SessionDetail> {
  const { goalId, workspaceId, adapterId, contextPackageId, taskId, fromRecommendationId, role, instruction, title } = input;
  const stmts = ensureStmts(ctx.db);

  // Validate goal
  const goalRow = stmts.selectGoal.get(goalId) as GoalRow | undefined;
  if (!goalRow) throw new GoalNotFoundError(goalId);
  if (goalRow.archived_at !== null) throw new GoalArchivedError(goalId);

  // Validate workspace exists and is attached to this goal
  const wsRow = stmts.selectWorkspace.get(workspaceId) as WorkspaceRow | undefined;
  if (!wsRow) throw new WorkspaceNotFoundError(workspaceId);
  if (!stmts.selectWorkspaceLink.get(workspaceId, goalId)) throw new WorkspaceNotAttachedError(workspaceId, goalId);

  // Validate workspace path is accessible
  try {
    await access(wsRow.path);
  } catch {
    throw new WorkspaceUnavailableError(wsRow.path);
  }

  // Validate adapter exists in registry
  const adapter = ctx.adapterRegistry.get(adapterId);
  if (!adapter) throw new AdapterNotFoundError(adapterId);

  // Validate context package if provided
  if (contextPackageId !== undefined) {
    const pkg = getContextPackageMetaById(ctx.db, contextPackageId);
    if (!pkg) throw new ContextPackageNotFoundError(contextPackageId);
    if (pkg.goalId !== goalId)
      throw new ContextPackageMismatchError(`Package goal ${pkg.goalId} does not match session goal ${goalId}`);
    if (pkg.status !== 'ready')
      throw new ContextPackageMismatchError(`Package status is '${pkg.status}', expected 'ready'`);
    if (pkg.adapterId !== adapterId)
      throw new ContextPackageMismatchError(`Package adapter '${pkg.adapterId}' does not match session adapter '${adapterId}'`);
    if (pkg.workspaceId !== null && pkg.workspaceId !== workspaceId)
      throw new ContextPackageMismatchError(`Package workspace '${pkg.workspaceId}' does not match session workspace '${workspaceId}'`);
  }

  if (taskId !== undefined) {
    const task = getTaskById(ctx.db, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.goalId !== goalId) throw new AssociationGoalMismatchError('Task', taskId, task.goalId, goalId);
    if (task.archivedAt !== null) throw new ArchivedTargetError(taskId);
  }

  if (fromRecommendationId !== undefined) {
    const rec = getRecommendationById(ctx.db, fromRecommendationId);
    if (!rec) throw new RecommendationNotFoundError(fromRecommendationId);
    if (rec.goalId !== goalId) throw new AssociationGoalMismatchError('Recommendation', fromRecommendationId, rec.goalId, goalId);
    if (rec.status !== 'accepted') throw new InvalidRecommendationStateError(fromRecommendationId, rec.status);
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const resolvedTitle = title ?? `${adapterId} session`;

  let event!: DomainEvent;
  let assocEvent: DomainEvent | undefined;

  ctx.db.transaction(() => {
    insertSession(ctx.db, {
      id: sessionId,
      goalId,
      workspaceId,
      adapterId,
      contextPackageId: contextPackageId ?? null,
      taskId: taskId ?? null,
      fromRecommendationId: fromRecommendationId ?? null,
      role: role ?? null,
      instruction: instruction ?? null,
      title: resolvedTitle,
      status: 'created',
      createdAt: now,
    });

    const eventId = randomUUID();
    const payload: Record<string, unknown> = {
      sessionId,
      goalId,
      workspaceId,
      adapterId,
      contextPackageId: contextPackageId ?? null,
    };
    if (taskId !== undefined) payload.taskId = taskId;
    if (fromRecommendationId !== undefined) payload.fromRecommendationId = fromRecommendationId;

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

    if (taskId !== undefined) {
      const assocEventId = randomUUID();
      const assocPayload = { taskId, goalId, sessionId };
      const assocResult = stmts.insertEvent.run(
        assocEventId,
        'task.associated_with_session',
        goalId,
        JSON.stringify(assocPayload),
        now
      );
      assocEvent = {
        seq: Number(assocResult.lastInsertRowid),
        id: assocEventId,
        type: 'task.associated_with_session',
        goalId,
        payload: assocPayload,
        createdAt: now,
      };
    }
  })();

  // Broadcast only after COMMIT
  ctx.bus.publish(event);
  if (assocEvent !== undefined) ctx.bus.publish(assocEvent);

  // Construct the detail from the already-known insert values rather than re-reading.
  return SessionDetail.parse({
    id: sessionId,
    goalId,
    workspaceId,
    adapterId,
    contextPackageId: contextPackageId ?? null,
    taskId: taskId ?? null,
    fromRecommendationId: fromRecommendationId ?? null,
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
    onTerminalState: ctx.onTerminalState,
    dataDir: ctx.dataDir,
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
