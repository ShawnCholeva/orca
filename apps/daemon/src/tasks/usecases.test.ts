import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import {
  createTask,
  createTaskInTx,
  ensureDependenciesBelongToGoal,
  updateTask,
  splitTask,
  associateTaskWithSession,
  associateTaskWithContextPackage,
  insertPendingTaskGeneration,
  markTaskGenerationRunning,
  markTaskGenerationSucceeded,
  markTaskGenerationFailed,
  runTaskGeneration,
  getTaskById,
  DuplicateTaskFingerprintError,
  InvalidStatusTransitionError,
  TaskNotFoundError,
  CrossGoalAssociationError,
  DependencyTaskGoalMismatchError,
  DependencyTaskNotFoundError,
  resetPreparedStatements,
  type TaskCtx,
} from './usecases.js';
import { DeterministicTaskGenerator, FakeTaskGenerator } from './rules.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-tasks-uc-'));
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

function seedRefinement(db: Database.Database, goalId: string, successCriteria: string[]): void {
  db.prepare(
    `INSERT INTO goal_refinements (goal_id, skill_id, success_criteria, constraints, assumptions, refined_at)
     VALUES (?, 'guided-goal-refinement', ?, '[]', '[]', '2026-01-01T00:00:00.000Z')`
  ).run(goalId, JSON.stringify(successCriteria));
}

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, '/tmp/ws', 'ws', 'folder', null, null, 'not_a_repo', '2026-01-01T00:00:00.000Z')`
  ).run(id, goalId);
}

function seedSession(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
     VALUES (?, ?, ?, 'claude-code', 'test session', 'created', '2026-01-01T00:00:00.000Z')`
  ).run(id, goalId, workspaceId);
}

function seedContextPackage(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    `INSERT INTO context_packages (id, goal_id, adapter_id, role, objective, status,
      rendered_context, rendered_bytes, estimated_tokens, truncated, sparse,
      source_count, sources_json, warnings_json, source_fingerprint, assembler_version, created_at)
     VALUES (?, ?, 'claude-code', 'engineer', 'obj', 'ready', '', 0, 0, 0, 0, 0, '[]', '[]', 'fp', '0.1.0', '2026-01-01T00:00:00.000Z')`
  ).run(id, goalId);
}

function seedWorkflowStepRun(db: Database.Database, goalId: string, stepRunId = 'step-1'): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO workflow_templates
      (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO workflow_runs
      (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at)
     VALUES ('run-1', ?, 'orca/engineering', 1, 'active', ?, NULL, ?, NULL)`
  ).run(goalId, stepRunId, now);
  db.prepare(
    `INSERT INTO workflow_step_runs
      (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
     VALUES (?, ?, 'run-1', 'execution', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')`
  ).run(stepRunId, goalId, now);
}

let bus: EventBus;
let globalCounter = 0;

beforeEach(() => {
  bus = new EventBus();
  globalCounter = 0;
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCtx(db: Database.Database, overrides?: Partial<TaskCtx>): TaskCtx {
  return {
    db,
    bus,
    now: () => new Date(Date.now() + ++globalCounter).toISOString(),
    idFactory: () => `id-${++globalCounter}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

async function waitForTaskGenerationTerminal(
  db: Database.Database,
  generationId: string,
  timeoutMs = 2000
): Promise<{ status: string; failure_code: string | null }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db
      .prepare('SELECT status, failure_code FROM task_generations WHERE id = ?')
      .get(generationId) as { status: string; failure_code: string | null } | undefined;
    if (row && (row.status === 'succeeded' || row.status === 'failed')) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for terminal generation status: ${generationId}`);
}

describe('createTask', () => {
  it('create → get: task row persisted with correct fields', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const task = createTask(ctx, {
      goalId: 'g1', origin: 'user', role: 'engineer',
      title: 'Do work', description: 'desc',
    });
    expect(task.id).toBeDefined();
    expect(task.goalId).toBe('g1');
    expect(task.status).toBe('open');
    expect(task.role).toBe('engineer');
    expect(task.origin).toBe('user');

    const fetched = getTaskById(db, task.id);
    expect(fetched).toEqual(task);
  });

  it('generator-origin task starts as proposed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const task = createTask(ctx, {
      goalId: 'g1', origin: 'generator', role: 'engineer',
      title: 'Gen task', description: '',
    });
    expect(task.status).toBe('proposed');
  });

  it('emits task.created event after commit (broadcast test)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    let committedBeforePublish = false;
    const origPublish = bus.publish.bind(bus);
    vi.spyOn(bus, 'publish').mockImplementation((ev) => {
      // At publish time, task row must already be committed
      const row = db.prepare('SELECT id FROM tasks WHERE goal_id = ?').get('g1');
      committedBeforePublish = row !== undefined;
      origPublish(ev);
    });

    createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });

    expect(committedBeforePublish).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('task.created');
    expect(published[0].goalId).toBe('g1');
  });

  it('task.created payload is content-free (no title or description)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'My Title', description: 'My desc',
    });

    const payload = published[0].payload as Record<string, unknown>;
    expect('title' in payload).toBe(false);
    expect('description' in payload).toBe(false);
    expect(payload.taskId).toBeDefined();
    expect(payload.goalId).toBe('g1');
    expect(payload.status).toBeDefined();
    expect(payload.role).toBeDefined();
    expect(payload.origin).toBeDefined();
  });

  it('redacts obvious secrets from persisted task free text', () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    const task = createTask(makeCtx(db), {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Rotate token=supersecret',
      description: 'authorization: bearer live-secret',
      acceptanceCriteria: [{ id: 'ac1', text: 'api_key=abc123 is removed' }],
      validationSteps: [{ id: 'vs1', text: 'password=hunter2 is removed', kind: 'manual' }],
    });

    expect(task.title).not.toContain('supersecret');
    expect(task.description).not.toContain('live-secret');
    expect(task.acceptanceCriteria[0].text).not.toContain('abc123');
    expect(task.validationSteps[0].text).not.toContain('hunter2');
  });

  it('duplicate generator-origin fingerprint throws DuplicateTaskFingerprintError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    createTask(ctx, {
      goalId: 'g1', origin: 'generator', role: 'engineer', title: 'Same task', description: '',
    });
    expect(() =>
      createTask(makeCtx(db), {
        goalId: 'g1', origin: 'generator', role: 'engineer', title: 'Same task', description: '',
      })
    ).toThrow(DuplicateTaskFingerprintError);
  });

  it('manual (user-origin) create with same fingerprint is allowed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    // Two user-origin tasks with same title+role: no constraint fires
    const t1 = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Same', description: '',
    });
    const t2 = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Same', description: '',
    });
    expect(t1.id).not.toBe(t2.id);
  });

  it('createTaskInTx supports workflow_step_run_id inside caller transaction', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkflowStepRun(db, 'g1', 'step-1');
    const staged: DomainEvent[] = [];
    const task = db.transaction(() =>
      createTaskInTx(
        db,
        '2026-01-01T00:00:00.000Z',
        {
          goalId: 'g1',
          origin: 'generator',
          role: 'engineer',
          title: 'Workflow task',
          description: '',
          workflowStepRunId: 'step-1',
        },
        {
          idFactory: () => 'task-in-tx',
          stagedEvents: staged,
        }
      )
    )();

    expect(task.id).toBe('task-in-tx');
    expect(task.workflowStepRunId).toBe('step-1');
    expect(staged).toHaveLength(1);
    expect(staged[0].type).toBe('task.created');
  });

  it('ensureDependenciesBelongToGoal validates missing and cross-goal dependencies', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    const dep = createTask(makeCtx(db), {
      goalId: 'g2',
      origin: 'user',
      role: 'engineer',
      title: 'dep',
      description: '',
    });

    expect(() => ensureDependenciesBelongToGoal(db, 'g1', ['missing'])).toThrow(
      DependencyTaskNotFoundError
    );
    expect(() => ensureDependenciesBelongToGoal(db, 'g1', [dep.id])).toThrow(
      DependencyTaskGoalMismatchError
    );
  });

  it('atomicity: event insert failure rolls back task row', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const stmts = { insertEvent: db.prepare('INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)') };
    vi.spyOn(stmts.insertEvent, 'run').mockImplementation(() => { throw new Error('DB error'); });

    // Replace the event insert statement inside the module by making the DB throw on events table
    // Simplest approach: use a bad prepared statement by corrupting the events table access
    // We simulate by patching: override INSERT into events to throw
    const origExec = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origExec(sql);
      if (sql.includes('INSERT INTO events')) {
        vi.spyOn(stmt, 'run').mockImplementation(() => { throw new Error('event insert failed'); });
      }
      return stmt;
    });

    // Reset so that new ensureStmts picks up the mocked prepare
    resetPreparedStatements();

    expect(() =>
      createTask(makeCtx(db), {
        goalId: 'g1', origin: 'user', role: 'engineer', title: 'Atomic', description: '',
      })
    ).toThrow('event insert failed');

    // Task row must not be committed
    const row = db.prepare('SELECT id FROM tasks WHERE goal_id = ?').get('g1');
    expect(row).toBeUndefined();
  });
});

describe('updateTask', () => {
  it('updates title and emits task.updated with changedFields', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Original', description: '',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const { task: updated } = updateTask(makeCtx(db), task.id, { title: 'Updated' });
    expect(updated.title).toBe('Updated');

    const updateEvent = published.find((e) => e.type === 'task.updated');
    expect(updateEvent).toBeDefined();
    const payload = updateEvent!.payload as { changedFields: string[]; taskId: string };
    expect(payload.changedFields).toContain('title');
    expect('title' in updateEvent!.payload).toBe(false);
    expect(payload.taskId).toBe(task.id);
  });

  it('task.updated payload has no text fields', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'X', description: 'desc',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    updateTask(makeCtx(db), task.id, { description: 'new desc' });
    const payload = published.find((e) => e.type === 'task.updated')!.payload as Record<string, unknown>;
    expect('description' in payload).toBe(false);
    expect('title' in payload).toBe(false);
    expect(payload.changedFields).toContain('description');
  });

  it('redacts obvious secrets when patching task free text', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'X', description: '',
    });

    const { task: updated } = updateTask(makeCtx(db), task.id, {
      title: 'Rotate token=supersecret',
      description: 'authorization: bearer live-secret',
      acceptanceCriteria: [{ id: 'ac1', text: 'api_key=abc123 is removed' }],
      validationSteps: [{ id: 'vs1', text: 'password=hunter2 is removed', kind: 'manual' }],
    });

    expect(updated.title).not.toContain('supersecret');
    expect(updated.description).not.toContain('live-secret');
    expect(updated.acceptanceCriteria[0].text).not.toContain('abc123');
    expect(updated.validationSteps[0].text).not.toContain('hunter2');
  });

  it('emits task.status_changed when status changes', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    updateTask(makeCtx(db), task.id, { status: 'in_progress' });
    const statusEvent = published.find((e) => e.type === 'task.status_changed');
    expect(statusEvent).toBeDefined();
    const p = statusEvent!.payload as { fromStatus: string; toStatus: string; reason: string };
    expect(p.fromStatus).toBe('open');
    expect(p.toStatus).toBe('in_progress');
    expect(p.reason).toBe('user');
  });

  it('rejects illegal status transition', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    expect(() => updateTask(makeCtx(db), task.id, { status: 'blocked' })).toThrow(InvalidStatusTransitionError);
  });

  it('allows proposed → open transition', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'generator', role: 'engineer', title: 'Proposed', description: '',
    });
    expect(task.status).toBe('proposed');
    const { task: updated } = updateTask(makeCtx(db), task.id, { status: 'open' });
    expect(updated.status).toBe('open');
  });

  it('sets archivedAt when transitioning to archived', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    updateTask(makeCtx(db), task.id, { status: 'done' });
    const { task: archived } = updateTask(makeCtx(db), task.id, { status: 'archived' });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.status).toBe('archived');
  });

  it('throws TaskNotFoundError for unknown id', () => {
    const db = freshDb();
    expect(() => updateTask(makeCtx(db), 'no-such-id', { title: 'x' })).toThrow(TaskNotFoundError);
  });

  it('returns no warning when status→done and no acceptance criteria', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
      status: 'in_progress',
    });
    const { warning } = updateTask(makeCtx(db), task.id, { status: 'done' });
    expect(warning).toBeUndefined();
  });

  it('returns warning when status→done with acceptance criteria but no validation steps', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
      status: 'in_progress',
      acceptanceCriteria: [{ id: 'ac1', text: 'must pass tests' }],
    });
    const { warning } = updateTask(makeCtx(db), task.id, { status: 'done' });
    expect(warning).toBeDefined();
  });
});

describe('splitTask', () => {
  it('creates children with parent linkage and emits task.split + task.created per child', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const parent = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Parent', description: '',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const { parent: p, children } = splitTask(makeCtx(db), {
      parentTaskId: parent.id,
      children: [
        { role: 'engineer', title: 'Child A', description: 'a' },
        { role: 'qa', title: 'Child B', description: 'b' },
      ],
    });

    expect(children).toHaveLength(2);
    expect(children[0].parentTaskId).toBe(parent.id);
    expect(children[1].parentTaskId).toBe(parent.id);
    expect(children[0].goalId).toBe('g1');

    const splitEvent = published.find((e) => e.type === 'task.split');
    expect(splitEvent).toBeDefined();
    const sp = splitEvent!.payload as { parentTaskId: string; childTaskIds: string[] };
    expect(sp.parentTaskId).toBe(parent.id);
    expect(sp.childTaskIds).toHaveLength(2);

    const createEvents = published.filter((e) => e.type === 'task.created');
    expect(createEvents).toHaveLength(2);
  });

  it('redacts obvious secrets from split child free text', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const parent = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Parent', description: '',
    });

    const { children } = splitTask(makeCtx(db), {
      parentTaskId: parent.id,
      children: [{
        role: 'engineer',
        title: 'Child token=supersecret',
        description: 'authorization: bearer live-secret',
        acceptanceCriteria: [{ id: 'ac1', text: 'api_key=abc123 is removed' }],
        validationSteps: [{ id: 'vs1', text: 'password=hunter2 is removed', kind: 'manual' }],
      }],
    });

    expect(children[0].title).not.toContain('supersecret');
    expect(children[0].description).not.toContain('live-secret');
    expect(children[0].acceptanceCriteria[0].text).not.toContain('abc123');
    expect(children[0].validationSteps[0].text).not.toContain('hunter2');
  });

  it('optionally moves parent to blocked', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const parent = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Parent',
      description: '', status: 'in_progress',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const { parent: p } = splitTask(makeCtx(db), {
      parentTaskId: parent.id,
      children: [{ role: 'engineer', title: 'C', description: '' }],
      setParentStatus: 'blocked',
    });

    expect(p.status).toBe('blocked');
    const statusEvent = published.find((e) => e.type === 'task.status_changed');
    expect(statusEvent).toBeDefined();
  });

  it('rejects invalid parent status transition in split', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const parent = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'Parent',
      description: '', // status = 'open'
    });
    expect(() =>
      splitTask(makeCtx(db), {
        parentTaskId: parent.id,
        children: [{ role: 'engineer', title: 'C', description: '' }],
        setParentStatus: 'blocked', // open → blocked not allowed
      })
    ).toThrow(InvalidStatusTransitionError);
  });
});

describe('associateTaskWithSession', () => {
  it('emits task.associated_with_session and updates sessions.task_id', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1');
    seedSession(db, 's1', 'g1', 'ws1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    associateTaskWithSession(makeCtx(db), task.id, 's1');

    const event = published.find((e) => e.type === 'task.associated_with_session');
    expect(event).toBeDefined();
    const p = event!.payload as { taskId: string; sessionId: string; goalId: string };
    expect(p.taskId).toBe(task.id);
    expect(p.sessionId).toBe('s1');
    expect(p.goalId).toBe('g1');

    const sessionRow = db.prepare('SELECT task_id FROM sessions WHERE id = ?').get('s1') as { task_id: string | null };
    expect(sessionRow.task_id).toBe(task.id);
  });

  it('rejects cross-goal session association', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedWorkspace(db, 'ws2', 'g2');
    seedSession(db, 's-g2', 'g2', 'ws2');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });

    expect(() => associateTaskWithSession(makeCtx(db), task.id, 's-g2')).toThrow(CrossGoalAssociationError);
  });

  it('rejects unknown session', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    expect(() => associateTaskWithSession(makeCtx(db), task.id, 'no-such-session')).toThrow(CrossGoalAssociationError);
  });
});

describe('associateTaskWithContextPackage', () => {
  it('emits task.associated_with_context_package and updates context_packages.task_id', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedContextPackage(db, 'pkg1', 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    associateTaskWithContextPackage(makeCtx(db), task.id, 'pkg1');

    const event = published.find((e) => e.type === 'task.associated_with_context_package');
    expect(event).toBeDefined();
    const pkgRow = db.prepare('SELECT task_id FROM context_packages WHERE id = ?').get('pkg1') as { task_id: string | null };
    expect(pkgRow.task_id).toBe(task.id);
  });

  it('rejects cross-goal context package association', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedContextPackage(db, 'pkg-g2', 'g2');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
    });
    expect(() => associateTaskWithContextPackage(makeCtx(db), task.id, 'pkg-g2')).toThrow(CrossGoalAssociationError);
  });
});

describe('task generation lifecycle', () => {
  const GEN_INPUT = {
    goalId: 'g1',
    trigger: 'manual',
    triggerSourceId: null,
    generatorId: 'orca/test',
    generatorVersion: '0.1.0',
    inputFingerprint: 'ifp-123',
  };

  it('insertPendingTaskGeneration emits task.generation.requested', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const { generation, isNew } = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    expect(isNew).toBe(true);
    expect(generation.status).toBe('pending');

    const ev = published.find((e) => e.type === 'task.generation.requested');
    expect(ev).toBeDefined();
    expect((ev!.payload as { generationId: string }).generationId).toBe(generation.id);
    expect(ev!.goalId).toBe('g1');
  });

  it('duplicate insertPendingTaskGeneration returns existing row without new event', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const first = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    const requestedBefore = published.filter((e) => e.type === 'task.generation.requested').length;

    const second = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    const requestedAfter = published.filter((e) => e.type === 'task.generation.requested').length;

    expect(second.isNew).toBe(false);
    expect(second.generation.id).toBe(first.generation.id);
    expect(requestedAfter).toBe(requestedBefore);
  });

  it('markTaskGenerationSucceeded emits task.generated with taskIds/count/sparse', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    markTaskGenerationRunning(makeCtx(db), generation.id);

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const updated = markTaskGenerationSucceeded(makeCtx(db), generation.id, ['t1', 't2'], false);
    expect(updated.status).toBe('succeeded');

    const ev = published.find((e) => e.type === 'task.generated');
    expect(ev).toBeDefined();
    const p = ev!.payload as { taskIds: string[]; count: number; sparse: boolean; generationId: string };
    expect(p.taskIds).toEqual(['t1', 't2']);
    expect(p.count).toBe(2);
    expect(p.sparse).toBe(false);
    expect(p.generationId).toBe(generation.id);
    expect('title' in ev!.payload).toBe(false);
  });

  it('markTaskGenerationFailed emits task.generation.failed with failureCode only', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);

    const published: DomainEvent[] = [];
    bus.subscribe((ev) => published.push(ev));

    const updated = markTaskGenerationFailed(makeCtx(db), generation.id, 'provider_error', 'service down');
    expect(updated.status).toBe('failed');
    expect(updated.failureCode).toBe('provider_error');

    const ev = published.find((e) => e.type === 'task.generation.failed');
    expect(ev).toBeDefined();
    const p = ev!.payload as Record<string, unknown>;
    expect(p.failureCode).toBe('provider_error');
    expect('failureMessage' in p).toBe(false);
    expect('message' in p).toBe(false);
  });

  it('failed row excluded from idempotency — retry creates new row', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    markTaskGenerationFailed(makeCtx(db), generation.id, 'provider_error', null);

    const retry = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    expect(retry.isNew).toBe(true);
    expect(retry.generation.id).not.toBe(generation.id);
  });

  it('failure message capped at 256 chars', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const { generation } = insertPendingTaskGeneration(makeCtx(db), GEN_INPUT);
    const longMsg = 'x'.repeat(1000);
    const updated = markTaskGenerationFailed(makeCtx(db), generation.id, 'internal_error', longMsg);
    expect(updated.failureMessage!.length).toBeLessThanOrEqual(256);
  });
});

describe('runTaskGeneration', () => {
  it('runs deterministic generator and persists generated tasks linked to generation', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRefinement(db, 'g1', ['Implement task generator', 'Write deterministic tests']);

    const generation = await runTaskGeneration(
      {
        ...makeCtx(db),
        taskGenerator: new DeterministicTaskGenerator(),
      },
      {
        goalId: 'g1',
        trigger: 'manual',
        triggerSourceId: null,
      }
    );

    const terminal = await waitForTaskGenerationTerminal(db, generation.id);
    expect(terminal.status).toBe('succeeded');

    const created = db
      .prepare(
        `SELECT generation_id, origin FROM tasks WHERE goal_id = ? ORDER BY created_at ASC, id ASC`
      )
      .all('g1') as Array<{ generation_id: string | null; origin: string }>;
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((row) => row.origin === 'generator')).toBe(true);
    expect(created.every((row) => row.generation_id === generation.id)).toBe(true);
  });

  it('rolls back generated tasks if the generation success event cannot commit', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRefinement(db, 'g1', ['Implement task generator']);

    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO events')) {
        const origRun = stmt.run.bind(stmt);
        vi.spyOn(stmt, 'run').mockImplementation((...args: unknown[]) => {
          if (args[1] === 'task.generated') {
            throw new Error('simulated task.generated insert failure');
          }
          return origRun(...args);
        });
      }
      return stmt;
    });
    resetPreparedStatements();

    const generation = await runTaskGeneration(
      {
        ...makeCtx(db),
        taskGenerator: new DeterministicTaskGenerator(),
      },
      {
        goalId: 'g1',
        trigger: 'manual',
        triggerSourceId: null,
      }
    );

    const terminal = await waitForTaskGenerationTerminal(db, generation.id);
    expect(terminal.status).toBe('failed');

    const taskCount = (
      db.prepare('SELECT count(*) AS cnt FROM tasks WHERE goal_id = ?').get('g1') as { cnt: number }
    ).cnt;
    expect(taskCount).toBe(0);
  });

  it('creates a new generation after snapshot changes, without duplicating tasks', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRefinement(db, 'g1', ['Implement task generator']);
    const taskGenerator = new DeterministicTaskGenerator();
    const context = {
      ...makeCtx(db),
      taskGenerator,
    };

    const first = await runTaskGeneration(context, {
      goalId: 'g1',
      trigger: 'manual',
      triggerSourceId: null,
    });
    await waitForTaskGenerationTerminal(db, first.id);

    const taskCountBeforeSecond = (
      db.prepare('SELECT count(*) AS cnt FROM tasks WHERE goal_id = ?').get('g1') as {
        cnt: number;
      }
    ).cnt;

    const second = await runTaskGeneration(context, {
      goalId: 'g1',
      trigger: 'manual',
      triggerSourceId: null,
    });
    const secondTerminal = await waitForTaskGenerationTerminal(db, second.id);
    expect(secondTerminal.status).toBe('succeeded');

    expect(second.id).not.toBe(first.id);
    const generationCount = (
      db.prepare('SELECT count(*) AS cnt FROM task_generations WHERE goal_id = ?').get('g1') as {
        cnt: number;
      }
    ).cnt;
    expect(generationCount).toBe(2);

    const taskCountAfterSecond = (
      db.prepare('SELECT count(*) AS cnt FROM tasks WHERE goal_id = ?').get('g1') as {
        cnt: number;
      }
    ).cnt;
    expect(taskCountAfterSecond).toBe(taskCountBeforeSecond);
  });

  it('marks generation failed with invalid_output for malformed generator output', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRefinement(db, 'g1', ['Implement task generator']);

    const badGenerator = new FakeTaskGenerator({
      candidates: [
        {
          title: 'x'.repeat(300),
          description: 'desc',
          role: 'engineer',
          workspaceId: null,
          sources: [],
        },
      ],
      sparse: false,
      warnings: [],
    } as never);

    const generation = await runTaskGeneration(
      {
        ...makeCtx(db),
        taskGenerator: badGenerator,
      },
      {
        goalId: 'g1',
        trigger: 'manual',
        triggerSourceId: null,
      }
    );

    const terminal = await waitForTaskGenerationTerminal(db, generation.id);
    expect(terminal.status).toBe('failed');
    expect(terminal.failure_code).toBe('invalid_output');
  });
});

describe('status guard completeness', () => {
  it.each([
    ['proposed', 'open', true],
    ['proposed', 'in_progress', false],
    ['open', 'in_progress', true],
    ['open', 'done', true],
    ['open', 'cancelled', true],
    ['open', 'blocked', false],
    ['in_progress', 'open', true],
    ['in_progress', 'blocked', true],
    ['in_progress', 'done', true],
    ['in_progress', 'cancelled', true],
    ['blocked', 'in_progress', true],
    ['blocked', 'done', true],
    ['blocked', 'cancelled', true],
    ['done', 'archived', true],
    ['done', 'open', false],
    ['cancelled', 'archived', true],
    ['cancelled', 'open', false],
    ['archived', 'open', false],
  ])('%s → %s: allowed=%s', (from, to, allowed) => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const task = createTask(makeCtx(db), {
      goalId: 'g1', origin: 'user', role: 'engineer', title: 'T', description: '',
      status: from as never,
    });

    if (allowed) {
      expect(() => updateTask(makeCtx(db), task.id, { status: to as never })).not.toThrow();
    } else {
      expect(() => updateTask(makeCtx(db), task.id, { status: to as never })).toThrow(InvalidStatusTransitionError);
    }
  });
});
