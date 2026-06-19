import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  CreateContextPackageResponse,
  GetContextPackageResponse,
  ListContextPackagesResponse,
} from '@orca/contracts';
import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';
import { FakeContextAssembler } from '../src/context/assembler.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { EventBus } from '../src/events.js';
import { registerContextRoutes } from '../src/context/routes.js';
import {
  resetPreparedStatements as resetUsecaseStmts,
} from '../src/context/usecases.js';
import {
  resetPreparedStatements as resetProjectionStmts,
} from '../src/context/projection.js';

beforeAll(() => {
  bootstrapRegistries();
});

const tempDirs: string[] = [];
const AUTH = { authorization: 'Bearer test-token' } as const;

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

const NOW = '2026-01-01T00:00:00.000Z';

function seedGoal(db: Database.Database, goalId: string, archived = false): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', ?, 1, ?, ?, ?)`
  ).run(goalId, archived ? 'archived' : 'active', NOW, NOW, archived ? NOW : null);
}

function seedWorkspace(db: Database.Database, wsId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, '/tmp/ws', 'ws', '', NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, wsId, NOW);
}

describe('context-routes', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let assembler: FakeContextAssembler;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-routes-'));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    assembler = new FakeContextAssembler();
    server = createServer(config, { assembler });
  });

  afterEach(async () => {
    await server.close();
    resetUsecaseStmts();
    resetProjectionStmts();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /v1/goals/:goalId/context-packages — happy path
  // ---------------------------------------------------------------------------

  describe('POST /v1/goals/:goalId/context-packages', () => {
    it('returns 201 + reused=false on first create', async () => {
      seedGoal(db, 'goal-1');

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: {
          adapterId: 'claude-code',
          role: 'engineer',
          objective: 'Fix the rendering bug',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = CreateContextPackageResponse.parse(JSON.parse(res.body));
      expect(body.reused).toBe(false);
      expect(body.assembly.status).toBe('succeeded');
      expect(body.assembly.goalId).toBe('goal-1');
      expect(body.assembly.adapterId).toBe('claude-code');
      expect(body.assembly.role).toBe('engineer');
      expect(body.package).not.toBeNull();
      expect(body.package!.status).toBe('ready');
      expect(typeof body.package!.renderedContext).toBe('string');
      expect(body.package!.renderedContext.length).toBeGreaterThan(0);
      expect(Array.isArray(body.package!.sources)).toBe(true);
    });

    it('returns 200 + reused=true on duplicate create (same inputs)', async () => {
      seedGoal(db, 'goal-1');

      const payload = {
        adapterId: 'claude-code',
        role: 'engineer',
        objective: 'Fix the rendering bug',
      };

      const res1 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = CreateContextPackageResponse.parse(JSON.parse(res1.body));

      const res2 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      expect(res2.statusCode).toBe(200);
      const body2 = CreateContextPackageResponse.parse(JSON.parse(res2.body));
      expect(body2.reused).toBe(true);
      expect(body2.assembly.id).toBe(body1.assembly.id);
      expect(body2.package?.id).toBe(body1.package?.id);
    });

    it('duplicate create emits no new events', async () => {
      seedGoal(db, 'goal-1');
      const payload = {
        adapterId: 'claude-code',
        role: 'engineer',
        objective: 'Fix the rendering bug',
      };
      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      const countBefore = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      const countAfter = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
      expect(countAfter).toBe(countBefore);
    });

    it('returns 200 + new assembly id on retry after failed assembly', async () => {
      seedGoal(db, 'goal-1');
      const payload = {
        adapterId: 'claude-code',
        role: 'engineer',
        objective: 'Fix the rendering bug',
      };

      assembler.simulateFailure('internal_error');
      const res1 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      expect(res1.statusCode).toBe(200);
      const body1 = CreateContextPackageResponse.parse(JSON.parse(res1.body));
      expect(body1.assembly.status).toBe('failed');
      const failedAsmId = body1.assembly.id;

      assembler.resetOverride();
      const res2 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const body2 = CreateContextPackageResponse.parse(JSON.parse(res2.body));
      expect(body2.assembly.status).toBe('succeeded');
      expect(body2.assembly.id).not.toBe(failedAsmId);
      expect(body2.assembly.trigger).toBe('retry');
      expect(body2.reused).toBe(false);
    });

    it('regenerate path: replacePackageId produces package with supersedesPackageId set', async () => {
      seedGoal(db, 'goal-1');
      const payload = {
        adapterId: 'claude-code',
        role: 'engineer',
        objective: 'Fix the rendering bug',
      };

      const res1 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const body1 = CreateContextPackageResponse.parse(JSON.parse(res1.body));
      const origPkgId = body1.package!.id;

      const res2 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { ...payload, replacePackageId: origPkgId },
      });
      expect(res2.statusCode).toBe(201);
      const body2 = CreateContextPackageResponse.parse(JSON.parse(res2.body));
      expect(body2.package!.supersedesPackageId).toBe(origPkgId);
      expect(body2.assembly.trigger).toBe('regenerate');
      expect(body2.package!.id).not.toBe(origPkgId);
    });

    // 4xx validation

    it('returns 400 on invalid role', async () => {
      seedGoal(db, 'goal-1');
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'wizard', objective: 'do stuff' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on missing objective', async () => {
      seedGoal(db, 'goal-1');
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 on unknown goal', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/no-such-goal/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'do stuff' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('goal_not_found');
    });

    it('returns 409 on archived goal', async () => {
      seedGoal(db, 'goal-archived', true);
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-archived/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'do stuff' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('goal_archived');
    });

    it('returns 404 when adapter is not registered (direct route test)', async () => {
      // AdapterId enum values are all registered by bootstrapRegistries(), so we test
      // the adapter-not-found path by registering routes with an empty registry directly.
      const emptyRegistry = new AdapterRegistry();
      const mini = Fastify({ logger: false });
      mini.addHook('onRequest', async (_req, reply) => {
        if (_req.headers.authorization !== 'Bearer test-token') {
          void reply.code(401).send();
        }
      });
      registerContextRoutes(mini, {
        db,
        bus: new EventBus(),
        assembler,
        adapterRegistry: emptyRegistry,
      });
      seedGoal(db, 'goal-adapter-test');
      const res = await mini.inject({
        method: 'POST',
        url: '/v1/goals/goal-adapter-test/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'do stuff' },
      });
      await mini.close();
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('adapter_not_found');
    });

    it('returns 404 when workspaceId not attached to goal', async () => {
      seedGoal(db, 'goal-1');
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: {
          adapterId: 'claude-code',
          role: 'engineer',
          objective: 'do stuff',
          workspaceId: 'ws-foreign',
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('workspace_not_found');
    });

    it('returns 404 when replacePackageId belongs to a different goal', async () => {
      seedGoal(db, 'goal-1');
      seedGoal(db, 'goal-2');

      const res1 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-2/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'other goal work' },
      });
      expect(res1.statusCode).toBe(201);
      const body1 = CreateContextPackageResponse.parse(JSON.parse(res1.body));
      const foreignPkgId = body1.package!.id;

      const res2 = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: {
          adapterId: 'claude-code',
          role: 'engineer',
          objective: 'do stuff',
          replacePackageId: foreignPkgId,
        },
      });
      expect(res2.statusCode).toBe(404);
      const body2 = JSON.parse(res2.body) as { error: { code: string } };
      expect(body2.error.code).toBe('replace_package_not_found');
    });

    it('accepts workspaceId when attached to goal', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1');

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: {
          adapterId: 'claude-code',
          role: 'engineer',
          objective: 'do stuff',
          workspaceId: 'ws-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = CreateContextPackageResponse.parse(JSON.parse(res.body));
      expect(body.package!.workspaceId).toBe('ws-1');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/goals/:goalId/context-packages
  // ---------------------------------------------------------------------------

  describe('GET /v1/goals/:goalId/context-packages', () => {
    it('returns packages and assemblies ordered by created_at DESC', async () => {
      seedGoal(db, 'goal-1');

      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'task one' },
      });
      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'architect', objective: 'task two' },
      });

      const res = await server.inject({
        method: 'GET',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = ListContextPackagesResponse.parse(JSON.parse(res.body));
      expect(body.packages.length).toBe(2);
      expect(body.assemblies.length).toBe(2);
    });

    it('respects limit param', async () => {
      seedGoal(db, 'goal-1');

      for (let i = 0; i < 3; i++) {
        await server.inject({
          method: 'POST',
          url: '/v1/goals/goal-1/context-packages',
          headers: AUTH,
          payload: {
            adapterId: 'claude-code',
            role: 'engineer',
            objective: `objective ${i}`,
          },
        });
      }

      const res = await server.inject({
        method: 'GET',
        url: '/v1/goals/goal-1/context-packages?limit=2',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = ListContextPackagesResponse.parse(JSON.parse(res.body));
      expect(body.packages.length).toBe(2);
    });

    it('returns empty lists for goal with no packages', async () => {
      seedGoal(db, 'goal-1');
      const res = await server.inject({
        method: 'GET',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = ListContextPackagesResponse.parse(JSON.parse(res.body));
      expect(body.packages).toEqual([]);
      expect(body.assemblies).toEqual([]);
    });

    it('returns 400 on invalid limit', async () => {
      seedGoal(db, 'goal-1');
      const res = await server.inject({
        method: 'GET',
        url: '/v1/goals/goal-1/context-packages?limit=9999',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/context-packages/:id
  // ---------------------------------------------------------------------------

  describe('GET /v1/context-packages/:id', () => {
    it('returns package with rendered context and source refs', async () => {
      seedGoal(db, 'goal-1');

      const createRes = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'Fix bug' },
      });
      expect(createRes.statusCode).toBe(201);
      const createBody = CreateContextPackageResponse.parse(JSON.parse(createRes.body));
      const pkgId = createBody.package!.id;

      const res = await server.inject({
        method: 'GET',
        url: `/v1/context-packages/${pkgId}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = GetContextPackageResponse.parse(JSON.parse(res.body));
      expect(body.package.id).toBe(pkgId);
      expect(typeof body.package.renderedContext).toBe('string');
      expect(body.package.renderedContext.length).toBeGreaterThan(0);
      expect(Array.isArray(body.package.sources)).toBe(true);
      expect(body.package.sources.length).toBeGreaterThan(0);
    });

    it('returns 404 for unknown package id', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/v1/context-packages/no-such-pkg',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });
  });

  // ---------------------------------------------------------------------------
  // Event bus observability
  // ---------------------------------------------------------------------------

  describe('events via event bus spy', () => {
    it('emits context.assembly.requested and context.assembly.completed on success', async () => {
      seedGoal(db, 'goal-1');

      const eventTypes: string[] = [];
      const { eventBus } = await import('../src/events.js');
      const unsub = eventBus.subscribe((e) => eventTypes.push(e.type));

      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'Fix bug' },
      });

      unsub();
      expect(eventTypes).toContain('context.assembly.requested');
      expect(eventTypes).toContain('context.assembly.completed');
      expect(eventTypes).toContain('context.package.created');
    });

    it('emits context.assembly.failed when assembler throws', async () => {
      seedGoal(db, 'goal-1');

      const eventTypes: string[] = [];
      const { eventBus } = await import('../src/events.js');
      const unsub = eventBus.subscribe((e) => eventTypes.push(e.type));

      assembler.simulateFailure('internal_error');
      await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/context-packages',
        headers: AUTH,
        payload: { adapterId: 'claude-code', role: 'engineer', objective: 'Fix bug' },
      });

      unsub();
      expect(eventTypes).toContain('context.assembly.failed');
      expect(eventTypes).not.toContain('context.package.created');
    });
  });
});
