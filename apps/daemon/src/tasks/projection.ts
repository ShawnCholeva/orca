import type Database from 'better-sqlite3';
import {
  Task,
  TaskGeneration,
  TaskAcceptanceCriterion,
  TaskValidationStep,
  TaskSourceRef,
} from '@orca/contracts';

interface TaskDbRow {
  id: string;
  goal_id: string;
  parent_task_id: string | null;
  workspace_id: string | null;
  role: string;
  status: string;
  origin: string;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  validation_steps_json: string;
  dependencies_json: string;
  sources_json: string;
  generation_id: string | null;
  workflow_step_run_id: string | null;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface TaskGenerationDbRow {
  id: string;
  goal_id: string;
  trigger: string;
  trigger_source_id: string | null;
  generator_id: string;
  generator_version: string;
  input_fingerprint: string;
  request_fingerprint: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  task_ids_json: string;
  sparse: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToTask(row: TaskDbRow): Task {
  return Task.parse({
    id: row.id,
    goalId: row.goal_id,
    parentTaskId: row.parent_task_id,
    workspaceId: row.workspace_id,
    role: row.role,
    status: row.status,
    origin: row.origin,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as TaskAcceptanceCriterion[],
    validationSteps: JSON.parse(row.validation_steps_json) as TaskValidationStep[],
    dependencies: JSON.parse(row.dependencies_json) as string[],
    sources: JSON.parse(row.sources_json) as TaskSourceRef[],
    generationId: row.generation_id,
    workflowStepRunId: row.workflow_step_run_id,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });
}

function rowToGeneration(row: TaskGenerationDbRow): TaskGeneration {
  return TaskGeneration.parse({
    id: row.id,
    goalId: row.goal_id,
    trigger: row.trigger,
    triggerSourceId: row.trigger_source_id,
    generatorId: row.generator_id,
    generatorVersion: row.generator_version,
    inputFingerprint: row.input_fingerprint,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    sparse: row.sparse !== 0,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

let _db: Database.Database | null = null;
let _stmts: {
  insertTask: Database.Statement;
  updateTask: Database.Statement;
  getTaskById: Database.Statement;
  insertGeneration: Database.Statement;
  updateGenerationRunning: Database.Statement;
  updateGenerationSucceeded: Database.Statement;
  updateGenerationFailed: Database.Statement;
  getGenerationById: Database.Statement;
  getActiveGenerationByFp: Database.Statement;
  updateSessionTaskId: Database.Statement;
  updateContextPackageTaskId: Database.Statement;
  getSessionGoalId: Database.Statement;
  getContextPackageGoalId: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertTask: db.prepare(`
        INSERT INTO tasks (id, goal_id, parent_task_id, workspace_id, role, status, origin,
          title, description, acceptance_criteria_json, validation_steps_json,
          dependencies_json, sources_json, generation_id, workflow_step_run_id, fingerprint, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateTask: db.prepare(`
        UPDATE tasks SET title = ?, description = ?, acceptance_criteria_json = ?,
          validation_steps_json = ?, dependencies_json = ?, sources_json = ?,
          workspace_id = ?, role = ?, status = ?, archived_at = ?, updated_at = ?
        WHERE id = ?
      `),
      getTaskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      insertGeneration: db.prepare(`
        INSERT OR IGNORE INTO task_generations
          (id, goal_id, trigger, trigger_source_id, generator_id, generator_version,
           input_fingerprint, request_fingerprint, status, failure_code, failure_message,
           task_ids_json, sparse, requested_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, '[]', 0, ?, NULL, NULL)
      `),
      updateGenerationRunning: db.prepare(
        "UPDATE task_generations SET status = 'running', started_at = ? WHERE id = ?"
      ),
      updateGenerationSucceeded: db.prepare(
        "UPDATE task_generations SET status = 'succeeded', task_ids_json = ?, sparse = ?, finished_at = ? WHERE id = ?"
      ),
      updateGenerationFailed: db.prepare(
        "UPDATE task_generations SET status = 'failed', failure_code = ?, failure_message = ?, finished_at = ? WHERE id = ?"
      ),
      getGenerationById: db.prepare('SELECT * FROM task_generations WHERE id = ?'),
      getActiveGenerationByFp: db.prepare(`
        SELECT * FROM task_generations
        WHERE goal_id = ? AND request_fingerprint = ? AND status IN ('pending', 'running', 'succeeded')
        LIMIT 1
      `),
      updateSessionTaskId: db.prepare(
        'UPDATE sessions SET task_id = ? WHERE id = ?'
      ),
      updateContextPackageTaskId: db.prepare(
        'UPDATE context_packages SET task_id = ? WHERE id = ?'
      ),
      getSessionGoalId: db.prepare('SELECT goal_id FROM sessions WHERE id = ?'),
      getContextPackageGoalId: db.prepare('SELECT goal_id FROM context_packages WHERE id = ?'),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

export interface InsertTaskInput {
  id: string;
  goalId: string;
  parentTaskId: string | null;
  workspaceId: string | null;
  role: string;
  status: string;
  origin: string;
  title: string;
  description: string;
  acceptanceCriteriaJson: string;
  validationStepsJson: string;
  dependenciesJson: string;
  sourcesJson: string;
  generationId: string | null;
  workflowStepRunId: string | null;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function insertTask(db: Database.Database, row: InsertTaskInput): void {
  ensureStmts(db).insertTask.run(
    row.id, row.goalId, row.parentTaskId, row.workspaceId, row.role, row.status,
    row.origin, row.title, row.description, row.acceptanceCriteriaJson,
    row.validationStepsJson, row.dependenciesJson, row.sourcesJson,
    row.generationId, row.workflowStepRunId, row.fingerprint, row.createdAt, row.updatedAt, row.archivedAt
  );
}

export interface UpdateTaskFields {
  title: string;
  description: string;
  acceptanceCriteriaJson: string;
  validationStepsJson: string;
  dependenciesJson: string;
  sourcesJson: string;
  workspaceId: string | null;
  role: string;
  status: string;
  archivedAt: string | null;
}

export function updateTaskRow(db: Database.Database, id: string, fields: UpdateTaskFields, updatedAt: string): void {
  ensureStmts(db).updateTask.run(
    fields.title, fields.description, fields.acceptanceCriteriaJson,
    fields.validationStepsJson, fields.dependenciesJson, fields.sourcesJson,
    fields.workspaceId, fields.role, fields.status, fields.archivedAt,
    updatedAt, id
  );
}

export function getTaskById(db: Database.Database, id: string): Task | null {
  const row = ensureStmts(db).getTaskById.get(id) as TaskDbRow | undefined;
  return row ? rowToTask(row) : null;
}

export function getTasksByIds(db: Database.Database, ids: string[]): Task[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as TaskDbRow[];
  return rows.map(rowToTask);
}

export interface ListTasksOptions {
  goalId: string;
  statuses?: string[];
  role?: string;
  parentTaskId?: string | null;
  workspaceId?: string | null;
  includeArchived?: boolean;
  cursor?: string;
  limit?: number;
}

export function listTasksByGoal(
  db: Database.Database,
  opts: ListTasksOptions
): { tasks: Task[]; nextCursor: string | null } {
  const {
    goalId,
    statuses,
    role,
    parentTaskId,
    workspaceId,
    includeArchived = false,
    cursor,
    limit = 50,
  } = opts;

  const conds: string[] = ['goal_id = ?'];
  const params: unknown[] = [goalId];

  if (statuses && statuses.length > 0) {
    conds.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  } else if (!includeArchived) {
    conds.push("status != 'archived'");
  }

  if (role !== undefined) {
    conds.push('role = ?');
    params.push(role);
  }

  if (parentTaskId !== undefined) {
    if (parentTaskId === null) {
      conds.push('parent_task_id IS NULL');
    } else {
      conds.push('parent_task_id = ?');
      params.push(parentTaskId);
    }
  }

  if (workspaceId !== undefined) {
    if (workspaceId === null) {
      conds.push('workspace_id IS NULL');
    } else {
      conds.push('workspace_id = ?');
      params.push(workspaceId);
    }
  }

  if (cursor) {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { c: string; i: string };
    conds.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(decoded.c, decoded.c, decoded.i);
  }

  const cap = Math.min(limit, 200);
  params.push(cap + 1);

  const rows = db
    .prepare(`SELECT * FROM tasks WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params) as TaskDbRow[];

  let nextCursor: string | null = null;
  if (rows.length > cap) {
    rows.pop();
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ c: last.created_at, i: last.id })).toString('base64');
  }

  return { tasks: rows.map(rowToTask), nextCursor };
}

export interface InsertTaskGenerationInput {
  id: string;
  goalId: string;
  trigger: string;
  triggerSourceId: string | null;
  generatorId: string;
  generatorVersion: string;
  inputFingerprint: string;
  requestFingerprint: string;
  requestedAt: string;
}

/** Returns { generation, isNew }. isNew=false when active fingerprint already exists. */
export function insertOrGetPendingGeneration(
  db: Database.Database,
  input: InsertTaskGenerationInput,
  onInserted?: () => void
): { generation: TaskGeneration; isNew: boolean } {
  const stmts = ensureStmts(db);

  let generation!: TaskGeneration;
  let isNew = false;

  db.transaction(() => {
    const result = stmts.insertGeneration.run(
      input.id, input.goalId, input.trigger, input.triggerSourceId,
      input.generatorId, input.generatorVersion, input.inputFingerprint,
      input.requestFingerprint, input.requestedAt
    );
    if (result.changes > 0) {
      isNew = true;
      onInserted?.();
      generation = rowToGeneration(stmts.getGenerationById.get(input.id) as TaskGenerationDbRow);
    } else {
      const existing = stmts.getActiveGenerationByFp.get(input.goalId, input.requestFingerprint) as TaskGenerationDbRow;
      generation = rowToGeneration(existing);
    }
  }).immediate();

  return { generation, isNew };
}

export function markGenerationRunning(db: Database.Database, id: string, startedAt: string): void {
  ensureStmts(db).updateGenerationRunning.run(startedAt, id);
}

export function markGenerationSucceeded(
  db: Database.Database,
  id: string,
  taskIds: string[],
  sparse: boolean,
  finishedAt: string
): void {
  ensureStmts(db).updateGenerationSucceeded.run(
    JSON.stringify(taskIds), sparse ? 1 : 0, finishedAt, id
  );
}

export function markGenerationFailed(
  db: Database.Database,
  id: string,
  failureCode: string,
  failureMessage: string | null,
  finishedAt: string
): void {
  ensureStmts(db).updateGenerationFailed.run(failureCode, failureMessage, finishedAt, id);
}

export function getTaskGenerationById(db: Database.Database, id: string): TaskGeneration | null {
  const stmts = ensureStmts(db);
  const row = stmts.getGenerationById.get(id) as TaskGenerationDbRow | undefined;
  return row ? rowToGeneration(row) : null;
}

export function getActiveTaskGenerationByFp(
  db: Database.Database,
  goalId: string,
  requestFingerprint: string
): TaskGeneration | null {
  const stmts = ensureStmts(db);
  const row = stmts.getActiveGenerationByFp.get(goalId, requestFingerprint) as TaskGenerationDbRow | undefined;
  return row ? rowToGeneration(row) : null;
}

export function listTaskGenerationsByGoal(
  db: Database.Database,
  goalId: string,
  limit = 5
): TaskGeneration[] {
  const rows = db
    .prepare('SELECT * FROM task_generations WHERE goal_id = ? ORDER BY requested_at DESC LIMIT ?')
    .all(goalId, limit) as TaskGenerationDbRow[];
  return rows.map(rowToGeneration);
}

export function updateSessionTaskId(db: Database.Database, sessionId: string, taskId: string): void {
  ensureStmts(db).updateSessionTaskId.run(taskId, sessionId);
}

export function updateContextPackageTaskId(db: Database.Database, contextPackageId: string, taskId: string): void {
  ensureStmts(db).updateContextPackageTaskId.run(taskId, contextPackageId);
}

export function getSessionGoalId(db: Database.Database, sessionId: string): string | null {
  const row = ensureStmts(db).getSessionGoalId.get(sessionId) as { goal_id: string } | undefined;
  return row?.goal_id ?? null;
}

export function getContextPackageGoalId(db: Database.Database, contextPackageId: string): string | null {
  const row = ensureStmts(db).getContextPackageGoalId.get(contextPackageId) as { goal_id: string } | undefined;
  return row?.goal_id ?? null;
}
