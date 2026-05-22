import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { CreateContextPackageResponse, CreateSessionResponse } from '@orca/contracts';
import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { FakeContextAssembler } from '../src/context/assembler.js';
import { resetPreparedStatements as resetContextUsecaseStmts } from '../src/context/usecases.js';
import { resetPreparedStatements as resetContextProjectionStmts } from '../src/context/projection.js';
import { resetPreparedStatements as resetSessionUsecaseStmts } from '../src/sessions/usecases.js';
import { resetPreparedStatements as resetSessionProjectionStmts } from '../src/sessions/projection.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';

beforeAll(() => {
  bootstrapRegistries();
});

const tempDirs: string[] = [];
const AUTH = { authorization: 'Bearer test-token' } as const;
const NOW = '2026-01-01T00:00:00.000Z';

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

function openTestDb(dataDir: string): Database.Database {
  const db = openDatabase(createConfig(dataDir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string, archived = false): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', ?, 1, ?, ?, ?)`
  ).run(goalId, archived ? 'archived' : 'active', NOW, NOW, archived ? NOW : null);
}

function seedWorkspace(db: Database.Database, wsId: string, goalId: string, wsPath: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'ws', 'folder', null, null, 'not_a_repo', ?)`
  ).run(wsId, goalId, wsPath, NOW);
}

describe('context-session-link', () => {
  let db: Database.Database;
  let server: ReturnType<typeof createServer>;
  let wsDir: string;

  beforeEach(() => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-sess-link-'));
    tempDirs.push(dataDir);
    wsDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ws-link-'));
    tempDirs.push(wsDir);
    const config = createConfig(dataDir);
    db = openTestDb(dataDir);
    server = createServer(config, { assembler: new FakeContextAssembler() });
  });

  afterEach(async () => {
    await server.close();
    resetContextUsecaseStmts();
    resetContextProjectionStmts();
    resetSessionUsecaseStmts();
    resetSessionProjectionStmts();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Helper: create a ready context package via the API
  // ---------------------------------------------------------------------------

  async function createPackage(
    goalId: string,
    adapterId = 'shell-manual',
    role = 'engineer',
    workspaceId?: string
  ): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/context-packages`,
      headers: AUTH,
      payload: { adapterId, role, objective: 'Test objective', workspaceId },
    });
    expect(res.statusCode, `create package: ${res.body}`).toBe(201);
    const body = CreateContextPackageResponse.parse(JSON.parse(res.body));
    expect(body.package).not.toBeNull();
    return body.package!.id;
  }

  // ---------------------------------------------------------------------------
  // No-context path: must preserve base session behavior.
  // ---------------------------------------------------------------------------

  describe('no-context session create', () => {
    it('creates session without contextPackageId, event carries contextPackageId: null', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual' },
      });

      expect(res.statusCode).toBe(201);
      const body = CreateSessionResponse.parse(JSON.parse(res.body));
      expect(body.session.contextPackageId === null || body.session.contextPackageId === undefined).toBe(true);
    });

    it('GET /v1/sessions/:id returns null contextPackageId', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const createRes = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual' },
      });
      expect(createRes.statusCode).toBe(201);
      const { session } = CreateSessionResponse.parse(JSON.parse(createRes.body));

      const getRes = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${session.id}`,
        headers: AUTH,
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body.session.contextPackageId === null || body.session.contextPackageId === undefined).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Valid context package link
  // ---------------------------------------------------------------------------

  describe('session create with valid contextPackageId', () => {
    it('stores context_package_id, event payload carries it, GET returns it', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const pkgId = await createPackage('goal-1');

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: pkgId },
      });

      expect(res.statusCode).toBe(201);
      const body = CreateSessionResponse.parse(JSON.parse(res.body));
      expect(body.session.contextPackageId).toBe(pkgId);

      // Verify GET returns contextPackageId
      const getRes = await server.inject({
        method: 'GET',
        url: `/v1/sessions/${body.session.id}`,
        headers: AUTH,
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody.session.contextPackageId).toBe(pkgId);
    });

    it('list sessions includes contextPackageId', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const pkgId = await createPackage('goal-1');

      const createRes = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: pkgId },
      });
      expect(createRes.statusCode).toBe(201);
      const { session } = CreateSessionResponse.parse(JSON.parse(createRes.body));

      const listRes = await server.inject({
        method: 'GET',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      const found = listBody.sessions.find((s: { id: string }) => s.id === session.id);
      expect(found).toBeDefined();
      expect(found.contextPackageId).toBe(pkgId);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation failures
  // ---------------------------------------------------------------------------

  describe('contextPackageId validation failures', () => {
    it('returns 404 when package id does not exist', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: 'nonexistent-pkg' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('context_package_not_found');
    });

    it('returns 400 with context_package_mismatch when package belongs to different goal', async () => {
      seedGoal(db, 'goal-1');
      seedGoal(db, 'goal-2');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      const pkgId = await createPackage('goal-2');

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: pkgId },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('context_package_mismatch');
    });

    it('returns 400 with context_package_mismatch when package adapterId differs', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      // Create package for shell-manual, attempt session with different adapter
      // Since all adapters need to be registered, we seed the package directly via DB
      db.prepare(
        `INSERT INTO context_packages (id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective,
           status, rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
           sources_json, warnings_json, source_fingerprint, assembler_version, created_at)
         VALUES (?, ?, null, 'shell-manual', null, 'engineer', 'obj', 'ready', 'ctx', 3, 1, 0, 1, 0, '[]', '[]', 'fp1', 'v1', ?)`
      ).run('pkg-adapter-mismatch', 'goal-1', NOW);

      // Inject with adapterId that differs from package's adapterId
      // We need an adapter that's registered. All adapters are registered via bootstrapRegistries.
      // The test just needs the adapters table to differ - we can pass a fake adapterId if it won't
      // fail at adapter lookup first. Let's check via the seeded package's adapterId vs request adapterId.
      // shell-manual package, but we can't use a different adapter since it'll fail adapter_not_found.
      // Instead, seed a claude-code package and try with shell-manual.
      db.prepare(
        `INSERT INTO context_packages (id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective,
           status, rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
           sources_json, warnings_json, source_fingerprint, assembler_version, created_at)
         VALUES (?, ?, null, 'claude-code', null, 'engineer', 'obj', 'ready', 'ctx', 3, 1, 0, 1, 0, '[]', '[]', 'fp2', 'v1', ?)`
      ).run('pkg-claude-code', 'goal-1', NOW);

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: 'pkg-claude-code' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('context_package_mismatch');
    });

    it('returns 400 with context_package_mismatch when package workspaceId differs', async () => {
      seedGoal(db, 'goal-1');
      const ws2Dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ws2-link-'));
      tempDirs.push(ws2Dir);
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);
      seedWorkspace(db, 'ws-2', 'goal-1', ws2Dir);

      // Create package scoped to ws-2
      db.prepare(
        `INSERT INTO context_packages (id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective,
           status, rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
           sources_json, warnings_json, source_fingerprint, assembler_version, created_at)
         VALUES (?, ?, null, 'shell-manual', 'ws-2', 'engineer', 'obj', 'ready', 'ctx', 3, 1, 0, 1, 0, '[]', '[]', 'fp3', 'v1', ?)`
      ).run('pkg-ws-mismatch', 'goal-1', NOW);

      // Session created for ws-1, package tied to ws-2
      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: 'pkg-ws-mismatch' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('context_package_mismatch');
    });

    it('allows session create when package workspaceId is null (workspace-agnostic package)', async () => {
      seedGoal(db, 'goal-1');
      seedWorkspace(db, 'ws-1', 'goal-1', wsDir);

      // Package with null workspaceId — should be compatible with any workspace
      const pkgId = await createPackage('goal-1');

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-1/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-1', adapterId: 'shell-manual', contextPackageId: pkgId },
      });

      expect(res.statusCode).toBe(201);
      const body = CreateSessionResponse.parse(JSON.parse(res.body));
      expect(body.session.contextPackageId).toBe(pkgId);
    });
  });

  // ---------------------------------------------------------------------------
  // Archived goal: base session behavior preserved.
  // ---------------------------------------------------------------------------

  describe('archived goal', () => {
    it('returns 409 for archived goal regardless of contextPackageId', async () => {
      seedGoal(db, 'goal-archived', true);
      seedWorkspace(db, 'ws-arc', 'goal-archived', wsDir);

      const res = await server.inject({
        method: 'POST',
        url: '/v1/goals/goal-archived/sessions',
        headers: AUTH,
        payload: { workspaceId: 'ws-arc', adapterId: 'shell-manual' },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('goal_archived');
    });
  });
});
