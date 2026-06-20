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
import { FakeContextAssembler } from './assembler.js';
import {
  requestContextPackage,
  resetPreparedStatements,
  type RequestContextPackageInput,
} from './usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from './projection.js';
import {
  ArchivedTargetError,
  AssociationGoalMismatchError,
  InvalidRecommendationStateError,
  RecommendationNotFoundError,
  TaskNotFoundError,
} from '../sessions/errors.js';

const NOW = '2026-01-01T00:00:00.000Z';
const tempDirs: string[] = [];
const fakeAssembler = new FakeContextAssembler();

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-context-association-'));
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

function seedTask(
  db: Database.Database,
  id: string,
  goalId: string,
  opts: { archived?: boolean } = {}
): void {
  db.prepare(
    `INSERT INTO tasks
      (id, goal_id, parent_task_id, workspace_id, role, status, origin, title, description,
       acceptance_criteria_json, validation_steps_json, dependencies_json, sources_json,
       generation_id, fingerprint, created_at, updated_at, archived_at)
     VALUES (?, ?, null, null, 'engineer', 'open', 'user', 'Test task', 'desc', '[]', '[]', '[]', '[]',
             null, ?, ?, ?, ?)`
  ).run(id, goalId, `fp-${id}`, NOW, NOW, opts.archived ? NOW : null);
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

function baseInput(goalId: string, overrides: Partial<RequestContextPackageInput> = {}): RequestContextPackageInput {
  return {
    goalId,
    adapterId: 'claude-code',
    workspaceId: null,
    role: 'engineer',
    objective: 'Implement the feature',
    replacePackageId: null,
    trigger: 'prepare',
    ...overrides,
  };
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  vi.restoreAllMocks();
  fakeAssembler.resetOverride();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Baseline regression: no new fields -> byte-identical behavior
// ---------------------------------------------------------------------------

describe('context package create associations: no association baseline', () => {
  it('creates package without taskId/fromRecommendationId - byte-identical behavior', () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const result = requestContextPackage(
      { db, bus: eventBus, assembler: fakeAssembler },
      baseInput('g1')
    );

    expect(result.reused).toBe(false);
    expect(result.package).not.toBeNull();
    expect(result.package!.taskId).toBeNull();
    expect(result.package!.fromRecommendationId).toBeNull();

    // Only context.assembly.* and context.package.created events — no task.associated_with_context_package
    const eventTypes = publishSpy.mock.calls.map((c) => c[0]!.type);
    expect(eventTypes).not.toContain('task.associated_with_context_package');

    const pkgCreatedCall = publishSpy.mock.calls.find((c) => c[0]!.type === 'context.package.created');
    expect(pkgCreatedCall).toBeDefined();
    const payload = pkgCreatedCall![0]!.payload as Record<string, unknown>;
    expect(payload.taskId).toBeUndefined();
    expect(payload.fromRecommendationId).toBeUndefined();

    // DB row has nulls for both columns
    const row = db
      .prepare('SELECT task_id, from_recommendation_id FROM context_packages WHERE id = ?')
      .get(result.package!.id) as { task_id: string | null; from_recommendation_id: string | null };
    expect(row.task_id).toBeNull();
    expect(row.from_recommendation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// With taskId only
// ---------------------------------------------------------------------------

describe('context package create associations: with taskId only', () => {
  it('stores task_id, emits task.associated_with_context_package in same TX', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedTask(db, 'task-1', 'g1');

    const publishedEvents: DomainEvent[] = [];
    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        // At publish time both context_packages row and events row must already be committed
        if (event.type === 'context.package.created') {
          const pkgId = (event.payload as Record<string, unknown>).packageId as string;
          const pkgRow = db
            .prepare('SELECT task_id FROM context_packages WHERE id = ?')
            .get(pkgId) as { task_id: string | null } | undefined;
          if (pkgRow) {
            expect(pkgRow.task_id).toBe('task-1');
          }
          // task.associated_with_context_package row must exist at this point
          const assocRow = db
            .prepare("SELECT id FROM events WHERE type = 'task.associated_with_context_package'")
            .get();
          expect(assocRow).toBeDefined();
        }
        publishedEvents.push(event);
      },
    };

    const result = requestContextPackage(
      { db, bus: mockBus as never, assembler: fakeAssembler },
      baseInput('g1', { taskId: 'task-1' })
    );

    expect(result.package).not.toBeNull();
    expect(result.package!.taskId).toBe('task-1');
    expect(result.package!.fromRecommendationId).toBeNull();

    const assocEvents = publishedEvents.filter((e) => e.type === 'task.associated_with_context_package');
    expect(assocEvents).toHaveLength(1);
    const assocPayload = assocEvents[0]!.payload as Record<string, unknown>;
    expect(assocPayload.taskId).toBe('task-1');
    expect(assocPayload.goalId).toBe('g1');
    expect(assocPayload.contextPackageId).toBe(result.package!.id);

    // context.package.created payload includes taskId
    const createdEvent = publishedEvents.find((e) => e.type === 'context.package.created');
    expect(createdEvent).toBeDefined();
    expect((createdEvent!.payload as Record<string, unknown>).taskId).toBe('task-1');
    expect((createdEvent!.payload as Record<string, unknown>).fromRecommendationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// With fromRecommendationId only
// ---------------------------------------------------------------------------

describe('context package create associations: with fromRecommendationId only', () => {
  it('stores from_recommendation_id, no task.associated_with_context_package event', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRecommendation(db, 'rec-1', 'g1', 'accepted');

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const result = requestContextPackage(
      { db, bus: eventBus, assembler: fakeAssembler },
      baseInput('g1', { fromRecommendationId: 'rec-1' })
    );

    expect(result.package).not.toBeNull();
    expect(result.package!.fromRecommendationId).toBe('rec-1');
    expect(result.package!.taskId).toBeNull();

    const eventTypes = publishSpy.mock.calls.map((c) => c[0]!.type);
    expect(eventTypes).not.toContain('task.associated_with_context_package');

    const createdEvent = publishSpy.mock.calls.find((c) => c[0]!.type === 'context.package.created');
    expect(createdEvent).toBeDefined();
    const payload = createdEvent![0]!.payload as Record<string, unknown>;
    expect(payload.fromRecommendationId).toBe('rec-1');
    expect(payload.taskId).toBeUndefined();

    const row = db
      .prepare('SELECT from_recommendation_id FROM context_packages WHERE id = ?')
      .get(result.package!.id) as { from_recommendation_id: string | null };
    expect(row.from_recommendation_id).toBe('rec-1');
  });
});

// ---------------------------------------------------------------------------
// With both taskId and fromRecommendationId
// ---------------------------------------------------------------------------

describe('context package create associations: with both taskId and fromRecommendationId', () => {
  it('stores both, emits context.package.created with both and task.associated_with_context_package', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedTask(db, 'task-1', 'g1');
    seedRecommendation(db, 'rec-1', 'g1', 'accepted');

    const publishSpy = vi.spyOn(eventBus, 'publish');
    const result = requestContextPackage(
      { db, bus: eventBus, assembler: fakeAssembler },
      baseInput('g1', { taskId: 'task-1', fromRecommendationId: 'rec-1' })
    );

    expect(result.package).not.toBeNull();
    expect(result.package!.taskId).toBe('task-1');
    expect(result.package!.fromRecommendationId).toBe('rec-1');

    const eventTypes = publishSpy.mock.calls.map((c) => c[0]!.type);
    expect(eventTypes).toContain('task.associated_with_context_package');

    const createdEvent = publishSpy.mock.calls.find((c) => c[0]!.type === 'context.package.created');
    const payload = createdEvent![0]!.payload as Record<string, unknown>;
    expect(payload.taskId).toBe('task-1');
    expect(payload.fromRecommendationId).toBe('rec-1');

    const row = db
      .prepare('SELECT task_id, from_recommendation_id FROM context_packages WHERE id = ?')
      .get(result.package!.id) as { task_id: string; from_recommendation_id: string };
    expect(row.task_id).toBe('task-1');
    expect(row.from_recommendation_id).toBe('rec-1');
  });
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

describe('context package create associations: validation errors', () => {
  it('task not found → TaskNotFoundError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { taskId: 'no-such-task' })
      )
    ).toThrow(TaskNotFoundError);
  });

  it('task belongs to different goal → AssociationGoalMismatchError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedTask(db, 'task-g2', 'g2');

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { taskId: 'task-g2' })
      )
    ).toThrow(AssociationGoalMismatchError);
  });

  it('task is archived → ArchivedTargetError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedTask(db, 'task-archived', 'g1', { archived: true });

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { taskId: 'task-archived' })
      )
    ).toThrow(ArchivedTargetError);
  });

  it('recommendation not found → RecommendationNotFoundError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { fromRecommendationId: 'no-such-rec' })
      )
    ).toThrow(RecommendationNotFoundError);
  });

  it('recommendation belongs to different goal → AssociationGoalMismatchError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedGoal(db, 'g2');
    seedRecommendation(db, 'rec-g2', 'g2', 'accepted');

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { fromRecommendationId: 'rec-g2' })
      )
    ).toThrow(AssociationGoalMismatchError);
  });

  it('recommendation in non-accepted state → InvalidRecommendationStateError', () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    for (const status of ['proposed', 'rejected', 'dismissed', 'modified', 'superseded'] as const) {
      seedRecommendation(db, `rec-${status}`, 'g1', status);
      expect(() =>
        requestContextPackage(
          { db, bus: eventBus, assembler: fakeAssembler },
          baseInput('g1', { fromRecommendationId: `rec-${status}` })
        )
      ).toThrow(InvalidRecommendationStateError);
    }
  });

  it('validation failure emits no events and creates no context_packages row', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedTask(db, 'task-archived', 'g1', { archived: true });

    const publishSpy = vi.spyOn(eventBus, 'publish');

    expect(() =>
      requestContextPackage(
        { db, bus: eventBus, assembler: fakeAssembler },
        baseInput('g1', { taskId: 'task-archived' })
      )
    ).toThrow(ArchivedTargetError);

    expect(publishSpy).not.toHaveBeenCalled();
    const count = (db.prepare('SELECT count(*) AS c FROM context_packages').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('both events persisted in same TX — task.associated_with_context_package row exists at context.package.created broadcast time', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedTask(db, 'task-1', 'g1');

    let assocEventExistedAtCreatedPublish = false;
    const mockBus = {
      subscribe: () => () => {},
      publish: (event: DomainEvent) => {
        if (event.type === 'context.package.created') {
          const assocRow = db
            .prepare("SELECT id FROM events WHERE type = 'task.associated_with_context_package'")
            .get();
          assocEventExistedAtCreatedPublish = assocRow !== undefined;
        }
      },
    };

    requestContextPackage(
      { db, bus: mockBus as never, assembler: fakeAssembler },
      baseInput('g1', { taskId: 'task-1' })
    );

    expect(assocEventExistedAtCreatedPublish).toBe(true);
  });
});
