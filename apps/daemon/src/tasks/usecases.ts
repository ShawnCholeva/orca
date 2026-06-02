import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  Task,
  TaskGeneration,
  TaskAcceptanceCriterion,
  TaskValidationStep,
  TaskSourceRef,
  TaskStatus,
  TaskRole,
  TaskOrigin,
  TaskGenerationTrigger,
  TaskFieldKey,
  TaskStatusChangedReason,
  ORCHESTRATION_TASK_MAX_TITLE_CHARS,
  ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS,
  ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA,
  ORCHESTRATION_TASK_MAX_VALIDATION_STEPS,
  ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS,
  ORCHESTRATION_TASK_MAX_SOURCES,
  ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS,
  type DomainEvent,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import { redactSecrets } from '../memory/normalize.js';
import { runGeneration, SchemaValidationError } from '../generation/runner.js';
import {
  insertTask,
  updateTaskRow,
  getTaskById,
  listTasksByGoal,
  insertOrGetPendingGeneration,
  markGenerationRunning,
  markGenerationSucceeded,
  markGenerationFailed,
  getTaskGenerationById,
  getActiveTaskGenerationByFp,
  listTaskGenerationsByGoal,
  updateSessionTaskId,
  updateContextPackageTaskId,
  getSessionGoalId,
  getContextPackageGoalId,
  getTasksByIds,
  type InsertTaskGenerationInput,
  type ListTasksOptions,
  resetPreparedStatements as resetProjectionStmts,
} from './projection.js';
import { taskFingerprint, taskGenerationRequestFingerprint } from './fingerprint.js';
import { buildTaskGenerationInput } from './input.js';
import {
  TaskGenerationOutputSchema,
  type TaskGenerator,
  type TaskCandidate,
} from './rules.js';

export {
  listTasksByGoal,
  getTaskById,
  getTaskGenerationById,
  getActiveTaskGenerationByFp,
  listTaskGenerationsByGoal,
  type ListTasksOptions,
};

export interface TaskCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found' as const;
  constructor(public readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class InvalidStatusTransitionError extends Error {
  readonly code = 'invalid_status_transition' as const;
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class DuplicateTaskFingerprintError extends Error {
  readonly code = 'duplicate_task_fingerprint' as const;
  constructor(public readonly fingerprint: string) {
    super(`Generator-origin task with this fingerprint already exists: ${fingerprint}`);
    this.name = 'DuplicateTaskFingerprintError';
  }
}

export class CrossGoalAssociationError extends Error {
  readonly code = 'cross_goal_association' as const;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CrossGoalAssociationError';
  }
}

export class DependencyTaskNotFoundError extends Error {
  readonly code = 'dependency_task_not_found' as const;
  constructor(public readonly taskId: string) {
    super(`Dependency task not found: ${taskId}`);
    this.name = 'DependencyTaskNotFoundError';
  }
}

export class DependencyTaskGoalMismatchError extends Error {
  readonly code = 'dependency_task_not_found' as const;
  constructor(public readonly taskId: string, public readonly goalId: string) {
    super(`Dependency task ${taskId} does not belong to goal ${goalId}`);
    this.name = 'DependencyTaskGoalMismatchError';
  }
}

export class TaskGenerationNotFoundError extends Error {
  readonly code = 'task_generation_not_found' as const;
  constructor(public readonly generationId: string) {
    super(`Task generation not found: ${generationId}`);
    this.name = 'TaskGenerationNotFoundError';
  }
}

// ── Status guard ──────────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  proposed: ['open', 'cancelled'],
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['open', 'blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'done', 'cancelled'],
  done: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

function isTransitionAllowed(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

// ── Prepared statement cache for event inserts ────────────────────────────────

let _db: Database.Database | null = null;
let _stmts: { insertEvent: Database.Statement } | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
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
  resetProjectionStmts();
}

function emitEvent(
  stmts: NonNullable<typeof _stmts>,
  type: DomainEvent['type'],
  goalId: string,
  payload: Record<string, unknown>,
  now: string,
  idFn: () => string
): DomainEvent {
  const eventId = idFn();
  const result = stmts.insertEvent.run(eventId, type, goalId, JSON.stringify(payload), now);
  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type,
    goalId,
    payload,
    createdAt: now,
  };
}

// ── Cap helpers ───────────────────────────────────────────────────────────────

function capTitle(s: string): string {
  return redactSecrets(s.trim().slice(0, ORCHESTRATION_TASK_MAX_TITLE_CHARS));
}

function capDescription(s: string): string {
  return redactSecrets(s.trim().slice(0, ORCHESTRATION_TASK_MAX_DESCRIPTION_CHARS));
}

function capAcceptanceCriteria(items: TaskAcceptanceCriterion[]): TaskAcceptanceCriterion[] {
  return items.slice(0, ORCHESTRATION_TASK_MAX_ACCEPTANCE_CRITERIA).map((c) => ({
    id: c.id,
    text: redactSecrets(c.text.trim().slice(0, ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS)),
  }));
}

function capValidationSteps(items: TaskValidationStep[]): TaskValidationStep[] {
  return items.slice(0, ORCHESTRATION_TASK_MAX_VALIDATION_STEPS).map((v) => ({
    id: v.id,
    text: redactSecrets(v.text.trim().slice(0, ORCHESTRATION_TASK_MAX_ITEM_TEXT_CHARS)),
    kind: v.kind,
  }));
}

function capSources(items: TaskSourceRef[]): TaskSourceRef[] {
  return items.slice(0, ORCHESTRATION_TASK_MAX_SOURCES);
}

function isSqliteUniqueError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export function ensureDependenciesBelongToGoal(
  db: Database.Database,
  goalId: string,
  dependencyIds: string[]
): void {
  if (dependencyIds.length === 0) return;
  const tasks = getTasksByIds(db, dependencyIds);
  if (tasks.length !== dependencyIds.length) {
    const existingIds = new Set(tasks.map((task) => task.id));
    const missingId = dependencyIds.find((id) => !existingIds.has(id));
    if (missingId) throw new DependencyTaskNotFoundError(missingId);
  }
  const crossGoalTask = tasks.find((task) => task.goalId !== goalId);
  if (crossGoalTask) {
    throw new DependencyTaskGoalMismatchError(crossGoalTask.id, goalId);
  }
}

// ── Create task ───────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  goalId: string;
  origin: TaskOrigin;
  role: TaskRole;
  title: string;
  description: string;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  validationSteps?: TaskValidationStep[];
  dependencies?: string[];
  sources?: TaskSourceRef[];
  workspaceId?: string | null;
  parentTaskId?: string | null;
  generationId?: string | null;
  workflowStepRunId?: string | null;
  status?: TaskStatus;
}

export interface CreateTaskInTxOptions {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
}

export function createTaskInTx(
  db: Database.Database,
  now: string,
  input: CreateTaskInput,
  options: CreateTaskInTxOptions = {}
): Task {
  const idFn = options.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const title = capTitle(input.title);
  const description = capDescription(input.description ?? '');
  const acceptanceCriteria = capAcceptanceCriteria(input.acceptanceCriteria ?? []);
  const validationSteps = capValidationSteps(input.validationSteps ?? []);
  const dependencies = (input.dependencies ?? []);
  const sources = capSources(input.sources ?? []);

  const fp = taskFingerprint(input.goalId, title, input.role);
  const id = idFn();
  const status = input.status ?? (input.origin === 'user' ? 'open' : 'proposed');

  try {
    insertTask(db, {
      id,
      goalId: input.goalId,
      parentTaskId: input.parentTaskId ?? null,
      workspaceId: input.workspaceId ?? null,
      role: input.role,
      status,
      origin: input.origin,
      title,
      description,
      acceptanceCriteriaJson: JSON.stringify(acceptanceCriteria),
      validationStepsJson: JSON.stringify(validationSteps),
      dependenciesJson: JSON.stringify(dependencies),
      sourcesJson: JSON.stringify(sources),
      generationId: input.generationId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      fingerprint: fp,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    options.stagedEvents?.push(
      emitEvent(stmts, 'task.created', input.goalId, {
        taskId: id,
        goalId: input.goalId,
        status,
        role: input.role,
        workspaceId: input.workspaceId ?? null,
        origin: input.origin,
        generationId: input.generationId ?? null,
      }, now, idFn)
    );
  } catch (err) {
    if (input.origin === 'generator' && isSqliteUniqueError(err)) {
      throw new DuplicateTaskFingerprintError(fp);
    }
    throw err;
  }

  return getTaskById(db, id)!;
}

export function createTask(ctx: TaskCtx, input: CreateTaskInput): Task {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const stagedEvents: DomainEvent[] = [];
  const task = db.transaction(() =>
    createTaskInTx(db, now, input, {
      idFactory: ctx.idFactory,
      stagedEvents,
    })
  )();

  for (const ev of stagedEvents) bus.publish(ev);
  return task;
}

// ── Update task ───────────────────────────────────────────────────────────────

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  role?: TaskRole;
  workspaceId?: string | null;
  status?: TaskStatus;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  validationSteps?: TaskValidationStep[];
  dependencies?: string[];
  sources?: TaskSourceRef[];
}

export function updateTask(
  ctx: TaskCtx,
  id: string,
  patch: UpdateTaskInput
): { task: Task; warning?: string } {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const current = getTaskById(db, id);
  if (!current) throw new TaskNotFoundError(id);

  const changedFields: TaskFieldKey[] = [];
  let newStatus = current.status;
  let newArchivedAt = current.archivedAt;

  if (patch.status !== undefined && patch.status !== current.status) {
    if (!isTransitionAllowed(current.status, patch.status)) {
      throw new InvalidStatusTransitionError(current.status, patch.status);
    }
    newStatus = patch.status;
    changedFields.push('status');
    if (patch.status === 'archived' && !current.archivedAt) {
      newArchivedAt = now;
      changedFields.push('archivedAt');
    }
  }

  const newTitle = patch.title !== undefined ? capTitle(patch.title) : current.title;
  if (newTitle !== current.title) changedFields.push('title');

  const newDescription = patch.description !== undefined ? capDescription(patch.description) : current.description;
  if (newDescription !== current.description) changedFields.push('description');

  const newRole = patch.role ?? current.role;
  if (newRole !== current.role) changedFields.push('role');

  const newWorkspaceId = patch.workspaceId !== undefined ? patch.workspaceId : current.workspaceId;
  if (newWorkspaceId !== current.workspaceId) changedFields.push('workspaceId');

  const newAC = patch.acceptanceCriteria !== undefined
    ? capAcceptanceCriteria(patch.acceptanceCriteria)
    : current.acceptanceCriteria;
  if (patch.acceptanceCriteria !== undefined) changedFields.push('acceptanceCriteria');

  const newVS = patch.validationSteps !== undefined
    ? capValidationSteps(patch.validationSteps)
    : current.validationSteps;
  if (patch.validationSteps !== undefined) changedFields.push('validationSteps');

  const newDeps = patch.dependencies !== undefined ? patch.dependencies : current.dependencies;
  if (patch.dependencies !== undefined) changedFields.push('dependencies');

  const newSources = patch.sources !== undefined ? capSources(patch.sources) : current.sources;
  if (patch.sources !== undefined) changedFields.push('sources');

  if (changedFields.length === 0) {
    return { task: current };
  }

  let warning: string | undefined;
  if (newStatus === 'done' && newAC.length > 0 && newVS.length === 0) {
    warning = 'acceptance criteria present but no validation steps';
  }

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    updateTaskRow(db, id, {
      title: newTitle,
      description: newDescription,
      acceptanceCriteriaJson: JSON.stringify(newAC),
      validationStepsJson: JSON.stringify(newVS),
      dependenciesJson: JSON.stringify(newDeps),
      sourcesJson: JSON.stringify(newSources),
      workspaceId: newWorkspaceId,
      role: newRole,
      status: newStatus,
      archivedAt: newArchivedAt,
    }, now);

    toPublish.push(
      emitEvent(stmts, 'task.updated', current.goalId, {
        taskId: id, goalId: current.goalId, changedFields,
      }, now, idFn)
    );

    if (newStatus !== current.status) {
      toPublish.push(
        emitEvent(stmts, 'task.status_changed', current.goalId, {
          taskId: id, goalId: current.goalId,
          fromStatus: current.status, toStatus: newStatus,
          reason: 'user' as TaskStatusChangedReason,
        }, now, idFn)
      );
    }
  })();

  for (const ev of toPublish) bus.publish(ev);
  return { task: getTaskById(db, id)!, warning };
}

// ── Split task ────────────────────────────────────────────────────────────────

export interface SplitChildInput {
  role: TaskRole;
  title: string;
  description: string;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  validationSteps?: TaskValidationStep[];
  dependencies?: string[];
  sources?: TaskSourceRef[];
  workspaceId?: string | null;
}

export interface SplitTaskInput {
  parentTaskId: string;
  children: SplitChildInput[];
  setParentStatus?: TaskStatus;
}

export function splitTask(
  ctx: TaskCtx,
  input: SplitTaskInput
): { parent: Task; children: Task[] } {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const parent = getTaskById(db, input.parentTaskId);
  if (!parent) throw new TaskNotFoundError(input.parentTaskId);

  if (input.setParentStatus !== undefined && input.setParentStatus !== parent.status) {
    if (!isTransitionAllowed(parent.status, input.setParentStatus)) {
      throw new InvalidStatusTransitionError(parent.status, input.setParentStatus);
    }
  }

  const childIds: string[] = [];
  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    for (const child of input.children) {
      const childId = idFn();
      const title = capTitle(child.title);
      const description = capDescription(child.description ?? '');
      const ac = capAcceptanceCriteria(child.acceptanceCriteria ?? []);
      const vs = capValidationSteps(child.validationSteps ?? []);
      const deps = child.dependencies ?? [];
      const sources = capSources(child.sources ?? []);
      const fp = taskFingerprint(parent.goalId, title, child.role);
      const status: TaskStatus = 'proposed';

      insertTask(db, {
        id: childId,
        goalId: parent.goalId,
        parentTaskId: input.parentTaskId,
        workspaceId: child.workspaceId ?? null,
        role: child.role,
        status,
        origin: 'user',
        title,
        description,
        acceptanceCriteriaJson: JSON.stringify(ac),
        validationStepsJson: JSON.stringify(vs),
        dependenciesJson: JSON.stringify(deps),
        sourcesJson: JSON.stringify(sources),
        generationId: null,
        workflowStepRunId: null,
        fingerprint: fp,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });

      childIds.push(childId);
      toPublish.push(
        emitEvent(stmts, 'task.created', parent.goalId, {
          taskId: childId,
          goalId: parent.goalId,
          status,
          role: child.role,
          workspaceId: child.workspaceId ?? null,
          origin: 'user',
          generationId: null,
        }, now, idFn)
      );
    }

    toPublish.push(
      emitEvent(stmts, 'task.split', parent.goalId, {
        parentTaskId: input.parentTaskId,
        childTaskIds: childIds,
        goalId: parent.goalId,
      }, now, idFn)
    );

    if (input.setParentStatus !== undefined && input.setParentStatus !== parent.status) {
      const newArchivedAt = input.setParentStatus === 'archived' && !parent.archivedAt ? now : parent.archivedAt;
      updateTaskRow(db, input.parentTaskId, {
        title: parent.title,
        description: parent.description,
        acceptanceCriteriaJson: JSON.stringify(parent.acceptanceCriteria),
        validationStepsJson: JSON.stringify(parent.validationSteps),
        dependenciesJson: JSON.stringify(parent.dependencies),
        sourcesJson: JSON.stringify(parent.sources),
        workspaceId: parent.workspaceId,
        role: parent.role,
        status: input.setParentStatus,
        archivedAt: newArchivedAt,
      }, now);

      toPublish.push(
        emitEvent(stmts, 'task.status_changed', parent.goalId, {
          taskId: input.parentTaskId,
          goalId: parent.goalId,
          fromStatus: parent.status,
          toStatus: input.setParentStatus,
          reason: 'user' as TaskStatusChangedReason,
        }, now, idFn)
      );
    }
  })();

  for (const ev of toPublish) bus.publish(ev);

  const updatedParent = getTaskById(db, input.parentTaskId)!;
  const children = getTasksByIds(db, childIds);
  return { parent: updatedParent, children };
}

// ── Associate with session ────────────────────────────────────────────────────

export function associateTaskWithSession(
  ctx: TaskCtx,
  taskId: string,
  sessionId: string
): Task {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const task = getTaskById(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const sessionGoalId = getSessionGoalId(db, sessionId);
  if (sessionGoalId === null) {
    throw new CrossGoalAssociationError(`Session not found: ${sessionId}`);
  }
  if (sessionGoalId !== task.goalId) {
    throw new CrossGoalAssociationError(
      `Session ${sessionId} belongs to goal ${sessionGoalId}, task belongs to goal ${task.goalId}`
    );
  }

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    updateSessionTaskId(db, sessionId, taskId);
    toPublish.push(
      emitEvent(stmts, 'task.associated_with_session', task.goalId, {
        taskId, goalId: task.goalId, sessionId,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getTaskById(db, taskId)!;
}

// ── Associate with context package ───────────────────────────────────────────

export function associateTaskWithContextPackage(
  ctx: TaskCtx,
  taskId: string,
  contextPackageId: string
): Task {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const task = getTaskById(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const pkgGoalId = getContextPackageGoalId(db, contextPackageId);
  if (pkgGoalId === null) {
    throw new CrossGoalAssociationError(`Context package not found: ${contextPackageId}`);
  }
  if (pkgGoalId !== task.goalId) {
    throw new CrossGoalAssociationError(
      `Context package ${contextPackageId} belongs to goal ${pkgGoalId}, task belongs to goal ${task.goalId}`
    );
  }

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    updateContextPackageTaskId(db, contextPackageId, taskId);
    toPublish.push(
      emitEvent(stmts, 'task.associated_with_context_package', task.goalId, {
        taskId, goalId: task.goalId, contextPackageId,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getTaskById(db, taskId)!;
}

// ── Task generation lifecycle helpers ─────────────────────────────────────────

export interface InsertPendingGenerationInput {
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  generatorId: string;
  generatorVersion: string;
  inputFingerprint: string;
}

export function insertPendingTaskGeneration(
  ctx: TaskCtx,
  input: InsertPendingGenerationInput
): { generation: TaskGeneration; isNew: boolean } {
  const { db, bus } = ctx;
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const requestFingerprint = taskGenerationRequestFingerprint(
    input.goalId,
    input.trigger,
    input.triggerSourceId,
    input.generatorId,
    input.generatorVersion,
    input.inputFingerprint
  );

  const id = idFn();

  const toPublish: DomainEvent[] = [];
  const { generation, isNew } = insertOrGetPendingGeneration(db, {
    id,
    goalId: input.goalId,
    trigger: input.trigger,
    triggerSourceId: input.triggerSourceId,
    generatorId: input.generatorId,
    generatorVersion: input.generatorVersion,
    inputFingerprint: input.inputFingerprint,
    requestFingerprint,
    requestedAt: now,
  }, () => {
    toPublish.push(
      emitEvent(stmts, 'task.generation.requested', input.goalId, {
        generationId: id,
        goalId: input.goalId,
        trigger: input.trigger,
        triggerSourceId: input.triggerSourceId,
      }, now, idFn)
    );
  });
  if (isNew) {
    for (const ev of toPublish) bus.publish(ev);
  }

  return { generation, isNew };
}

export function markTaskGenerationRunning(
  ctx: TaskCtx,
  generationId: string,
  startedAt?: string
): TaskGeneration {
  const { db } = ctx;
  const now = startedAt ?? ctx.now?.() ?? new Date().toISOString();
  const gen = getTaskGenerationById(db, generationId);
  if (!gen) throw new TaskGenerationNotFoundError(generationId);
  markGenerationRunning(db, generationId, now);
  return getTaskGenerationById(db, generationId)!;
}

export function markTaskGenerationSucceeded(
  ctx: TaskCtx,
  generationId: string,
  taskIds: string[],
  sparse: boolean,
  finishedAt?: string
): TaskGeneration {
  const { db, bus } = ctx;
  const now = finishedAt ?? ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const gen = getTaskGenerationById(db, generationId);
  if (!gen) throw new TaskGenerationNotFoundError(generationId);

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    markGenerationSucceeded(db, generationId, taskIds, sparse, now);
    toPublish.push(
      emitEvent(stmts, 'task.generated', gen.goalId, {
        generationId, goalId: gen.goalId, taskIds, count: taskIds.length, sparse,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getTaskGenerationById(db, generationId)!;
}

export function markTaskGenerationFailed(
  ctx: TaskCtx,
  generationId: string,
  failureCode: string,
  failureMessage: string | null,
  finishedAt?: string
): TaskGeneration {
  const { db, bus } = ctx;
  const now = finishedAt ?? ctx.now?.() ?? new Date().toISOString();
  const idFn = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(db);

  const gen = getTaskGenerationById(db, generationId);
  if (!gen) throw new TaskGenerationNotFoundError(generationId);

  const toPublish: DomainEvent[] = [];

  db.transaction(() => {
    markGenerationFailed(
      db, generationId, failureCode,
      failureMessage ? failureMessage.slice(0, ORCHESTRATION_GENERATION_MAX_FAILURE_MESSAGE_CHARS) : null,
      now
    );
    toPublish.push(
      emitEvent(stmts, 'task.generation.failed', gen.goalId, {
        generationId, goalId: gen.goalId, failureCode,
      }, now, idFn)
    );
  })();

  for (const ev of toPublish) bus.publish(ev);
  return getTaskGenerationById(db, generationId)!;
}

// ── Deterministic task generation runner integration (orchestration) ───────────────

export interface TaskGenerationCtx extends TaskCtx {
  taskGenerator: TaskGenerator;
}

export interface RunTaskGenerationInput {
  goalId: string;
  trigger: TaskGenerationTrigger;
  triggerSourceId: string | null;
}

export async function runTaskGeneration(
  ctx: TaskGenerationCtx,
  input: RunTaskGenerationInput
): Promise<TaskGeneration> {
  const generationInput = buildTaskGenerationInput({
    db: ctx.db,
    goalId: input.goalId,
  });

  const runResult = await runGeneration({
    kind: 'task',
    goalId: input.goalId,
    trigger: input.trigger,
    triggerSourceId: input.triggerSourceId,
    providerId: ctx.taskGenerator.id,
    providerVersion: ctx.taskGenerator.version,
    inputFingerprint: generationInput.inputFingerprint,
    ctx: {
      db: ctx.db,
      bus: ctx.bus,
      now: ctx.now,
      idFactory: ctx.idFactory,
    },
    execute: async () => {
      const rawOutput = await ctx.taskGenerator.generate(generationInput);
      const parsedOutput = TaskGenerationOutputSchema.safeParse(rawOutput);
      if (!parsedOutput.success) {
        throw new SchemaValidationError(parsedOutput.error.message);
      }

      return {
        taskIds: [],
        sparse: parsedOutput.data.sparse,
        data: parsedOutput.data.candidates,
      };
    },
    commitSuccess: (generationId, output, commitNow) => {
      const candidates = (output.data ?? []) as TaskCandidate[];
      const stmts = ensureStmts(ctx.db);
      const taskIds: string[] = [];
      const events: DomainEvent[] = [];
      const idFn = ctx.idFactory ?? randomUUID;

      for (const candidate of candidates) {
        try {
          const taskId = idFn();
          const title = capTitle(candidate.title);
          const description = capDescription(candidate.description);
          const sources = capSources(candidate.sources);
          const fp = taskFingerprint(input.goalId, title, candidate.role);
          insertTask(ctx.db, {
            id: taskId,
            goalId: input.goalId,
            parentTaskId: null,
            workspaceId: candidate.workspaceId,
            role: candidate.role,
            status: 'proposed',
            origin: 'generator',
            title,
            description,
            acceptanceCriteriaJson: '[]',
            validationStepsJson: '[]',
            dependenciesJson: '[]',
            sourcesJson: JSON.stringify(sources),
            generationId,
            workflowStepRunId: null,
            fingerprint: fp,
            createdAt: commitNow,
            updatedAt: commitNow,
            archivedAt: null,
          });
          events.push(
            emitEvent(stmts, 'task.created', input.goalId, {
              taskId,
              goalId: input.goalId,
              status: 'proposed',
              role: candidate.role,
              workspaceId: candidate.workspaceId,
              origin: 'generator',
              generationId,
            }, commitNow, idFn)
          );
          taskIds.push(taskId);
        } catch (error) {
          if (error instanceof DuplicateTaskFingerprintError || isSqliteUniqueError(error)) {
            continue;
          }
          throw error;
        }
      }

      return {
        taskIds,
        sparse: output.sparse,
        events,
      };
    },
  });

  if (runResult.generationId === null) {
    throw new Error(`Task generation for goal ${input.goalId} was queued for re-evaluation`);
  }

  const generation = getTaskGenerationById(ctx.db, runResult.generationId);
  if (!generation) {
    throw new TaskGenerationNotFoundError(runResult.generationId);
  }
  return generation;
}
