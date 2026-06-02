import { mkdtempSync, rmSync } from 'node:fs';
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
import {
  ArchivedTargetError,
  AssociationGoalMismatchError,
  InvalidRecommendationStateError,
  RecommendationNotFoundError,
  TaskNotFoundError,
} from './errors.js';
import {
  createSession,
  resetPreparedStatements,
  type SessionCtx,
} from './usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';
import { resetPreparedStatements as resetRuntimeStmts } from './runtime.js';

const NOW = '2026-01-01T00:00:00.000Z';
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string, archived = false): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, ?)`
  ).run(id, NOW, NOW, archived ? NOW : null);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string, wsPath: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'ws', 'folder', null, null, 'not_a_repo', ?)`
  ).run(id, goalId, wsPath, NOW);
}

function seedTask(
  db: Database.Database,
  id: string,
  goalId: string,
  opts: { archived?: boolean; status?: string } = {}
): void {
  db.prepare(
    `INSERT INTO tasks
      (id, goal_id, parent_task_id, workspace_id, role, status, origin, title, description,
       acceptance_criteria_json, validation_steps_json, dependencies_json, sources_json,
       generation_id, fingerprint, created_at, updated_at, archived_at)
     VALUES (?, ?, null, null, 'engineer', ?, 'user', 'Test task', 'desc', '[]', '[]', '[]', '[]',
             null, ?, ?, ?, ?)`
  ).run(
    id,
    goalId,
    opts.status ?? 'open',
    `fp-${id}`,
    NOW,
    NOW,
    opts.archived ? NOW : null
  );
}

function seedRecommendation(
  db: Database.Database,
  id: string,
  goalId: string,
  status: string
): void {
  const proposedAction = JSON.stringify({
    kind: 'create_session',
    adapterId: 'claude-code',
    role: 'engineer',
    objective: 'Implement feature',
  });
  db.prepare(
    `INSERT INTO recommendations
      (id, goal_id, generation_id, type, status, source, title, rationale, proposed_action_json,
       confidence, sources_json, related_task_id, related_session_id, related_context_pkg_id,
       related_conflict_id, fingerprint, superseded_by_id, superseded_reason, created_at, updated_at, resolved_at)
     VALUES (?, ?, null, 'create_session', ?, 'deterministic_provider', 'Create session', '',
             ?, 0.8, '[]', null, null, null, null, ?, null, null, ?, ?, null)`
  ).run(id, goalId, status, proposedAction, `fp-rec-${id}`, NOW, NOW);
}

function makeAdapterRegistry(): AdapterRegistry {
  return {
    get: (id: string) => (id === 'claude-code' ? ({ id } as never) : undefined),
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

describe('session create: no task or recommendation association', () => {
  it('creates session without taskId/fromRecommendationId — byte-identical behavior', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-ws-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
    });

    expect(detail.taskId).toBeNull();
    expect(detail.fromRecommendationId).toBeNull();

    // Only session.created emitted — no task.associated_with_session
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe('session.created');
    expect((event.payload as Record<string, unknown>).taskId).toBeUndefined();
    expect((event.payload as Record<string, unknown>).fromRecommendationId).toBeUndefined();

    // session.created event persisted
    const eventRow = db.prepare('SELECT id FROM events WHERE type = ?').get('session.created');
    expect(eventRow).toBeDefined();

    // No task.associated_with_session event
    const assocRow = db
      .prepare("SELECT id FROM events WHERE type = 'task.associated_with_session'")
      .get();
    expect(assocRow).toBeUndefined();
  });
});

describe('session create associations: with taskId only', () => {
  it('stores task_id, emits task.associated_with_session in same TX', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-task-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-1', 'g1');

    const publishedEvents: DomainEvent[] = [];
    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        // At publish time the row must already be committed
        const sessionRow = db
          .prepare('SELECT task_id FROM sessions WHERE id = ?')
          .get((event.payload as Record<string, unknown>).sessionId as string) as
          | { task_id: string | null }
          | undefined;
        if (sessionRow) {
          expect(sessionRow.task_id).toBe('task-1');
        }
        publishedEvents.push(event);
      },
    };

    const ctx: SessionCtx = { db, bus: mockBus as never, adapterRegistry: makeAdapterRegistry() };
    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      taskId: 'task-1',
    });

    expect(detail.taskId).toBe('task-1');
    expect(detail.fromRecommendationId).toBeNull();

    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[0]!.type).toBe('session.created');
    expect((publishedEvents[0]!.payload as Record<string, unknown>).taskId).toBe('task-1');
    expect((publishedEvents[0]!.payload as Record<string, unknown>).fromRecommendationId).toBeUndefined();

    expect(publishedEvents[1]!.type).toBe('task.associated_with_session');
    const assocPayload = publishedEvents[1]!.payload as Record<string, unknown>;
    expect(assocPayload.taskId).toBe('task-1');
    expect(assocPayload.goalId).toBe('g1');
    expect(assocPayload.sessionId).toBe(detail.id);

    // Both events persisted
    const sessionCreatedRow = db
      .prepare("SELECT id FROM events WHERE type = 'session.created'")
      .get();
    expect(sessionCreatedRow).toBeDefined();

    const assocRow = db
      .prepare("SELECT id FROM events WHERE type = 'task.associated_with_session'")
      .get();
    expect(assocRow).toBeDefined();
  });
});

describe('session create associations: with fromRecommendationId only', () => {
  it('stores from_recommendation_id, no task.associated_with_session event', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-rec-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedRecommendation(db, 'rec-1', 'g1', 'accepted');

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      fromRecommendationId: 'rec-1',
    });

    expect(detail.fromRecommendationId).toBe('rec-1');
    expect(detail.taskId).toBeNull();

    // Only session.created emitted
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]![0]!.type).toBe('session.created');
    const payload = publishSpy.mock.calls[0]![0]!.payload as Record<string, unknown>;
    expect(payload.fromRecommendationId).toBe('rec-1');
    expect(payload.taskId).toBeUndefined();

    const assocRow = db
      .prepare("SELECT id FROM events WHERE type = 'task.associated_with_session'")
      .get();
    expect(assocRow).toBeUndefined();
  });
});

describe('session create associations: with both taskId and fromRecommendationId', () => {
  it('stores both, emits session.created with both fields and task.associated_with_session', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-both-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-1', 'g1');
    seedRecommendation(db, 'rec-1', 'g1', 'accepted');

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    const detail = await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      taskId: 'task-1',
      fromRecommendationId: 'rec-1',
    });

    expect(detail.taskId).toBe('task-1');
    expect(detail.fromRecommendationId).toBe('rec-1');

    expect(publishSpy).toHaveBeenCalledTimes(2);
    const createdPayload = publishSpy.mock.calls[0]![0]!.payload as Record<string, unknown>;
    expect(createdPayload.taskId).toBe('task-1');
    expect(createdPayload.fromRecommendationId).toBe('rec-1');
    expect(publishSpy.mock.calls[1]![0]!.type).toBe('task.associated_with_session');

    // DB row has both columns set
    const row = db
      .prepare('SELECT task_id, from_recommendation_id FROM sessions WHERE id = ?')
      .get(detail.id) as { task_id: string; from_recommendation_id: string };
    expect(row.task_id).toBe('task-1');
    expect(row.from_recommendation_id).toBe('rec-1');
  });
});

describe('session create associations: validation errors', () => {
  it('task not found → TaskNotFoundError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-notask-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        taskId: 'no-such-task',
      })
    ).rejects.toThrow(TaskNotFoundError);
  });

  it('task belongs to different goal → AssociationGoalMismatchError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-taskmismatch-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-g2', 'g2');

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        taskId: 'task-g2',
      })
    ).rejects.toThrow(AssociationGoalMismatchError);
  });

  it('task is archived → ArchivedTargetError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-archived-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-archived', 'g1', { archived: true });

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        taskId: 'task-archived',
      })
    ).rejects.toThrow(ArchivedTargetError);
  });

  it('recommendation not found → RecommendationNotFoundError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-norec-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        fromRecommendationId: 'no-such-rec',
      })
    ).rejects.toThrow(RecommendationNotFoundError);
  });

  it('recommendation belongs to different goal → AssociationGoalMismatchError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-recmismatch-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedRecommendation(db, 'rec-g2', 'g2', 'accepted');

    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        fromRecommendationId: 'rec-g2',
      })
    ).rejects.toThrow(AssociationGoalMismatchError);
  });

  it('recommendation in non-accepted state → InvalidRecommendationStateError', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-recstate-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);

    for (const status of ['proposed', 'rejected', 'dismissed', 'modified', 'superseded'] as const) {
      seedRecommendation(db, `rec-${status}`, 'g1', status);
      const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };
      await expect(
        createSession(ctx, {
          goalId: 'g1',
          workspaceId: 'ws1',
          adapterId: 'claude-code',
          fromRecommendationId: `rec-${status}`,
        })
      ).rejects.toThrow(InvalidRecommendationStateError);
    }
  });

  it('validation failure emits no events and creates no session row', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-norow-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-archived', 'g1', { archived: true });

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const ctx: SessionCtx = { db, bus: eventBus, adapterRegistry: makeAdapterRegistry() };

    await expect(
      createSession(ctx, {
        goalId: 'g1',
        workspaceId: 'ws1',
        adapterId: 'claude-code',
        taskId: 'task-archived',
      })
    ).rejects.toThrow(ArchivedTargetError);

    expect(publishSpy).not.toHaveBeenCalled();
    const count = (db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('both events persisted in same TX — task.associated_with_session row exists at session.created broadcast time', async () => {
    const db = freshDb();
    const wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-session-association-atomic-'));
    tempDirs.push(wsDir);
    seedGoal(db, 'g1');
    seedWorkspace(db, 'ws1', 'g1', wsDir);
    seedTask(db, 'task-1', 'g1');

    let assocEventExistedAtCreatedPublish = false;
    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        if (event.type === 'session.created') {
          const assocRow = db
            .prepare("SELECT id FROM events WHERE type = 'task.associated_with_session'")
            .get();
          assocEventExistedAtCreatedPublish = assocRow !== undefined;
        }
      },
    };

    const ctx: SessionCtx = { db, bus: mockBus as never, adapterRegistry: makeAdapterRegistry() };
    await createSession(ctx, {
      goalId: 'g1',
      workspaceId: 'ws1',
      adapterId: 'claude-code',
      taskId: 'task-1',
    });

    expect(assocEventExistedAtCreatedPublish).toBe(true);
  });
});
