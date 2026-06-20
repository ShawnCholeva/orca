import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { createGoal } from '../goals.js';
import { runMigrations, defaultMigrationsDir } from '../migrations.js';
import { createTask, type TaskCtx } from './usecases.js';
import { buildTaskGenerationInput, resetPreparedStatements } from './input.js';
import { ModelProviderRegistry } from '../llm/registry.js';

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-tasks-input-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function ctx(db: Database.Database): TaskCtx {
  const bus = new EventBus();
  let n = 0;
  return {
    db,
    bus,
    now: () => new Date(Date.now() + ++n).toISOString(),
    idFactory: () => `id-${++n}`,
  };
}

async function seedGoal(db: Database.Database, description = ''): Promise<string> {
  const bus = new EventBus();
  const goal = await createGoal(
    { title: 'Goal', description },
    {
      db,
      bus,
      skills: {
        byId: () => ({
          id: 'quick-goal',
          extensionPoint: 'goal.refine',
          invoke: () => ({ title: 'Goal', description }),
        }),
      } as never,
      modelProviderRegistry: new ModelProviderRegistry(),
      inspectWorkspace: async () => {
        throw new Error('not used');
      },
    }
  );
  return goal.id;
}

function seedRefinement(db: Database.Database, goalId: string, successCriteria: string[]): void {
  db.prepare(
    `INSERT INTO goal_refinements (goal_id, skill_id, success_criteria, constraints, assumptions, refined_at)
     VALUES (?, 'guided-goal-refinement', ?, '[]', '[]', '2026-01-01T00:00:00.000Z')`
  ).run(goalId, JSON.stringify(successCriteria));
}

function seedWorkspace(db: Database.Database, goalId: string, id: string, isDirty: boolean | null): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, '/tmp/ws', id, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, id, '2026-01-01T00:00:00.000Z');
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildTaskGenerationInput', () => {
  it('returns deterministic inputFingerprint for the same snapshot', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db, 'Ship deterministic generation');
    seedRefinement(db, goalId, ['Implement endpoint', 'Write tests']);
    seedWorkspace(db, goalId, 'ws-1', false);

    const first = buildTaskGenerationInput({ db, goalId });
    const second = buildTaskGenerationInput({ db, goalId });

    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.refinement?.successCriteria).toEqual(['Implement endpoint', 'Write tests']);
    expect(first.workspaces).toEqual([{ id: 'ws-1', isDirty: null }]);
  });

  it('caps existing generator tasks at 20 and excludes non-generator tasks', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db, 'Generate tasks');
    seedRefinement(db, goalId, ['Implement endpoint']);
    const taskCtx = ctx(db);

    for (let i = 0; i < 25; i += 1) {
      createTask(taskCtx, {
        goalId,
        origin: 'generator',
        role: 'engineer',
        title: `Generated ${i}`,
        description: '',
      });
    }
    createTask(taskCtx, {
      goalId,
      origin: 'user',
      role: 'engineer',
      title: 'Manual item',
      description: '',
    });

    const input = buildTaskGenerationInput({ db, goalId });
    expect(input.existingGeneratorTasks).toHaveLength(20);
    expect(input.existingGeneratorTasks.every((task) => task.title !== 'Manual item')).toBe(true);
  });

});
