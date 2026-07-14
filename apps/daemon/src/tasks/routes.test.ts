import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  AssociateTaskSessionResponse,
  CreateTaskResponse,
  ListTasksResponse,
  SplitTaskResponse,
  TaskGenerationResponse,
  UpdateTaskResponse,
} from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { eventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { bootstrapRegistries } from '../registry/bootstrap.js';
import { createServer } from '../server.js';
import { createDaemonContext } from '../daemon-context.js';
import { createTask, resetPreparedStatements as resetTaskUsecaseStatements } from './usecases.js';
import { FakeTaskGenerator } from './rules.js';

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

beforeAll(() => {
  bootstrapRegistries();
});

describe('task routes', () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-task-routes-'));
    tempDirs.push(dir);

    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());

    const daemonContext = createDaemonContext(db, eventBus);
    daemonContext.taskGenerator = new FakeTaskGenerator(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        candidates: [
          {
            role: 'engineer',
            title: 'Generated task',
            description: 'Generated from manual request',
            sources: [{ type: 'refinement', id: 'g1', reason: 'driver' }],
            workspaceId: null,
          },
        ],
        sparse: false,
        warnings: [],
      };
    });

    server = createServer(config, { daemonContext });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    resetTaskUsecaseStatements();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedGoal(id: string, opts?: { archived?: boolean; description?: string }): void {
    const now = '2026-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES (?, 'Goal', ?, 'active', 1, ?, ?, ?)`
    ).run(id, opts?.description ?? 'Implement API routes', now, now, opts?.archived ? now : null);
  }

  function seedWorkspace(id: string, goalId: string): void {
    db.prepare(
      `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, `/tmp/ws/${id}`, 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
    ).run(goalId, id, '2026-01-01T00:00:00.000Z');
  }

  function seedSession(id: string, goalId: string, workspaceId: string): void {
    db.prepare(
      `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
       VALUES (?, ?, ?, 'claude-code', 'session', 'created', '2026-01-01T00:00:00.000Z')`
    ).run(id, goalId, workspaceId);
  }

  async function waitForGenerationTerminal(generationId: string, timeoutMs = 1000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = db
        .prepare('SELECT status FROM task_generations WHERE id = ?')
        .get(generationId) as { status: string } | undefined;
      if (row && (row.status === 'succeeded' || row.status === 'failed')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for task generation ${generationId}`);
  }

  it('POST /v1/goals/:goalId/tasks/generate returns 202 and reuses the active generation', async () => {
    seedGoal('g1', { description: 'Implement API routes' });

    const first = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/tasks/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = TaskGenerationResponse.parse(JSON.parse(first.body));

    const second = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/tasks/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    expect(second.statusCode).toBe(202);
    const secondBody = TaskGenerationResponse.parse(JSON.parse(second.body));

    expect(secondBody.generation.id).toBe(firstBody.generation.id);
    const count = db
      .prepare('SELECT COUNT(*) AS count FROM task_generations WHERE goal_id = ?')
      .get('g1') as { count: number };
    expect(count.count).toBe(1);

    await waitForGenerationTerminal(firstBody.generation.id);
  });

  it('POST /v1/goals/:goalId/tasks/generate returns 409 for archived goals', async () => {
    seedGoal('g-archived', { archived: true });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/g-archived/tasks/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('goal_archived');
  });

  it('GET /v1/goals/:goalId/tasks lists filtered tasks with latest generations', async () => {
    seedGoal('g1');
    seedWorkspace('ws-1', 'g1');
    createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Open task',
      description: '',
      workspaceId: 'ws-1',
    });
    createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'reviewer',
      title: 'Review task',
      description: '',
    });

    const generationResponse = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/tasks/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    const generationBody = TaskGenerationResponse.parse(JSON.parse(generationResponse.body));
    await waitForGenerationTerminal(generationBody.generation.id);

    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/g1/tasks?role=engineer&workspaceId=ws-1',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = ListTasksResponse.parse(JSON.parse(response.body));
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].role).toBe('engineer');
    expect(body.tasks[0].workspaceId).toBe('ws-1');
    expect(body.generations.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/goals/:goalId/tasks returns 404 for unknown goals', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/missing/tasks',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(404);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('goal_not_found');
  });

  it('POST /v1/goals/:goalId/tasks creates a user task', async () => {
    seedGoal('g1');
    seedWorkspace('ws-1', 'g1');
    const parent = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'architect',
      title: 'Parent',
      description: '',
    });
    const dependency = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Dependency',
      description: '',
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/tasks',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'Implement route',
        description: 'Task description',
        role: 'engineer',
        workspaceId: 'ws-1',
        parentTaskId: parent.id,
        acceptanceCriteria: ['endpoint works'],
        validationSteps: [{ text: 'run tests', kind: 'test' }],
        dependencies: [dependency.id],
        sources: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = CreateTaskResponse.parse(JSON.parse(response.body));
    expect(body.task.goalId).toBe('g1');
    expect(body.task.parentTaskId).toBe(parent.id);
    expect(body.task.dependencies).toEqual([dependency.id]);
    expect(body.task.acceptanceCriteria).toHaveLength(1);
    expect(body.task.validationSteps).toHaveLength(1);
  });

  it('POST /v1/goals/:goalId/tasks rejects workspaces from another goal', async () => {
    seedGoal('g1');
    seedGoal('g2');
    seedWorkspace('ws-g2', 'g2');

    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/tasks',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'Bad task',
        description: '',
        role: 'engineer',
        workspaceId: 'ws-g2',
        parentTaskId: null,
        acceptanceCriteria: [],
        validationSteps: [],
        dependencies: [],
        sources: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('workspace_not_found');
  });

  it('PATCH /v1/tasks/:id updates a task', async () => {
    seedGoal('g1');
    seedWorkspace('ws-1', 'g1');
    const task = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Todo',
      description: '',
    });

    const response = await server.inject({
      method: 'PATCH',
      url: `/v1/tasks/${task.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        status: 'in_progress',
        workspaceId: 'ws-1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = UpdateTaskResponse.parse(JSON.parse(response.body));
    expect(body.task.status).toBe('in_progress');
    expect(body.task.workspaceId).toBe('ws-1');
  });

  it('PATCH /v1/tasks/:id rejects invalid status transitions', async () => {
    seedGoal('g1');
    const task = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Todo',
      description: '',
    });

    const doneResponse = await server.inject({
      method: 'PATCH',
      url: `/v1/tasks/${task.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'done' },
    });
    expect(doneResponse.statusCode).toBe(200);

    const response = await server.inject({
      method: 'PATCH',
      url: `/v1/tasks/${task.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'in_progress' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('invalid_status_transition');
  });

  it('POST /v1/tasks/:id/split creates children and can block the parent', async () => {
    seedGoal('g1');
    seedWorkspace('ws-1', 'g1');
    const parent = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Parent',
      description: '',
      status: 'in_progress',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/v1/tasks/${parent.id}/split`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        setParentStatus: 'blocked',
        children: [
          {
            title: 'Child A',
            description: '',
            role: 'engineer',
            workspaceId: 'ws-1',
            acceptanceCriteria: [],
            validationSteps: [],
            dependencies: [],
            sources: [],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = SplitTaskResponse.parse(JSON.parse(response.body));
    expect(body.parentTask.status).toBe('blocked');
    expect(body.childTasks).toHaveLength(1);
    expect(body.childTasks[0].parentTaskId).toBe(parent.id);
  });

  it('POST /v1/tasks/:id/split returns 404 for missing parents', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tasks/missing/split',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        children: [{ title: 'Child', description: '', role: 'engineer' }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('task_not_found');
  });

  it('POST /v1/tasks/:id/associate-session associates a same-goal session', async () => {
    seedGoal('g1');
    seedWorkspace('ws-1', 'g1');
    seedSession('s1', 'g1', 'ws-1');
    const task = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Task',
      description: '',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/v1/tasks/${task.id}/associate-session`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { sessionId: 's1' },
    });

    expect(response.statusCode).toBe(200);
    const body = AssociateTaskSessionResponse.parse(JSON.parse(response.body));
    expect(body.task.id).toBe(task.id);

    const sessionRow = db.prepare('SELECT task_id FROM sessions WHERE id = ?').get('s1') as { task_id: string | null };
    expect(sessionRow.task_id).toBe(task.id);
  });

  it('POST /v1/tasks/:id/associate-session rejects cross-goal sessions', async () => {
    seedGoal('g1');
    seedGoal('g2');
    seedWorkspace('ws-1', 'g1');
    seedWorkspace('ws-2', 'g2');
    seedSession('s2', 'g2', 'ws-2');
    const task = createTask({ db, bus: eventBus }, {
      goalId: 'g1',
      origin: 'user',
      role: 'engineer',
      title: 'Task',
      description: '',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/v1/tasks/${task.id}/associate-session`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { sessionId: 's2' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('cross_goal_association');
  });
});
