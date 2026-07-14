import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateContextPackageResponse,
  CreateGoalResponse,
  CreateSessionResponse,
  GetContextPackageResponse,
  type DomainEvent,
} from '@orca/contracts';

import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { eventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';
import { createServer } from '../src/server.js';
import { createMemoryItem, patchMemoryItem, resetPreparedStatements as resetMemoryUsecaseStmts } from '../src/memory/usecases.js';
import { resetPreparedStatements as resetMemoryProjectionStmts } from '../src/memory/projection.js';
import { createDecision, patchDecision, resetPreparedStatements as resetDecisionUsecaseStmts } from '../src/decisions/usecases.js';
import { resetPreparedStatements as resetDecisionProjectionStmts } from '../src/decisions/projection.js';
import { resetPreparedStatements as resetContextInputStmts } from '../src/context/input.js';
import { resetPreparedStatements as resetContextProjectionStmts } from '../src/context/projection.js';
import { resetPreparedStatements as resetContextUsecaseStmts } from '../src/context/usecases.js';
import { reconcileStaleAssemblies } from '../src/context/reconcile.js';
import { resetPreparedStatements as resetSessionProjectionStmts } from '../src/sessions/projection.js';
import { resetPreparedStatements as resetSessionUsecaseStmts } from '../src/sessions/usecases.js';
import { resetPreparedStatements as resetSessionRuntimeStmts, SessionRuntime } from '../src/sessions/runtime.js';
import { createSessionOutputStore } from '../src/sessions/output-store.js';
import { FakePtyManager, controlFakePty } from '../src/pty/fake.js';

beforeAll(() => {
  // The claude-code adapter spawns this binary with no args; point it at an
  // interactive shell so the proof loop can drive a real PTY session.
  process.env.ORCA_CLAUDE_CODE_BIN = '/bin/sh';
  bootstrapRegistries();
});

const AUTH = { authorization: 'Bearer test-token' } as const;
const NOW = '2026-05-20T12:00:00.000Z';

const tempDirs: string[] = [];

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

function openTestDb(config: Config): Database.Database {
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function resetPreparedStatements(): void {
  resetMemoryUsecaseStmts();
  resetMemoryProjectionStmts();
  resetDecisionUsecaseStmts();
  resetDecisionProjectionStmts();
  resetContextInputStmts();
  resetContextProjectionStmts();
  resetContextUsecaseStmts();
  resetSessionProjectionStmts();
  resetSessionUsecaseStmts();
  resetSessionRuntimeStmts();
}

function seedSiblingSummary(db: Database.Database, goalId: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, role, instruction, title, status, created_at, started_at, exited_at)
     VALUES (?, ?, ?, 'claude-code', 'engineer', null, 'Sibling session', 'exited', ?, ?, ?)`
  ).run('sibling-session-1', goalId, workspaceId, NOW, NOW, NOW);

  db.prepare(
    `INSERT INTO memory_extractions (
       id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
       source_offset_first, source_offset_last, summary_id, item_count, decision_count,
       promoted_count, requested_at, started_at, finished_at
     ) VALUES (?, ?, ?, 'terminal_state', 'succeeded', 'test-extractor', 'summary-fp',
       0, 128, ?, 0, 0, 0, ?, ?, ?)`
  ).run('summary-extraction-1', goalId, 'sibling-session-1', 'summary-1', NOW, NOW, NOW);

  db.prepare(
    `INSERT INTO session_summaries (
       id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
       source_offset_first, source_offset_last, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 128, ?)`
  ).run(
    'summary-1',
    'sibling-session-1',
    goalId,
    'summary-extraction-1',
    'Previous session found the startup path',
    'The prior session verified the session row can keep a context package id.',
    NOW
  );
}

function countRows(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

describe.sequential('context package proof loop', () => {
  let server: FastifyInstance | null = null;
  let db: Database.Database;
  let unsubscribe: (() => void) | null = null;

  afterEach(async () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    closeDatabase();
    resetPreparedStatements();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares context, links it to a session, delivers it, and survives restart', async () => {
    const dataDir = mktemp('orca-context-proof-db-');
    const workspaceDir = realpathSync(mktemp('orca-context-proof-ws-'));
    const config = createConfig(dataDir);

    db = openTestDb(config);
    const ptyManager = new FakePtyManager();
    const runtime = new SessionRuntime(ptyManager);
    server = createServer(config, {
      sessionRuntime: runtime,
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });

    const publishedEvents: DomainEvent[] = [];
    unsubscribe = eventBus.subscribe((event) => publishedEvents.push(event));

    const refineRes = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: AUTH,
      payload: {
        title: 'Context proof loop',
        intent: [
          'Goals:',
          '- Prove context preparation survives restart',
          '',
          'Constraints:',
          '- Keep context local first',
          '- Preserve existing session behavior',
        ].join('\n'),
      },
    });
    expect(refineRes.statusCode).toBe(200);
    const draft = (JSON.parse(refineRes.body) as { draft: { intent: string } }).draft;

    const createGoalRes = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: AUTH,
      payload: {
        title: 'Context proof loop',
        intent: 'test intent',
        refined: draft,
        workspaces: [{ inputPath: workspaceDir }],
      },
    });
    expect(createGoalRes.statusCode, createGoalRes.body).toBe(201);
    const goal = CreateGoalResponse.parse(JSON.parse(createGoalRes.body)).goal;
    const workspace = db
      .prepare('SELECT w.id AS id FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?')
      .get(goal.id) as { id: string };

    const memoryCtx = { db, bus: eventBus, now: () => NOW };
    const promotedMemory = createMemoryItem(memoryCtx, {
      goalId: goal.id,
      type: 'architecture_note',
      content: 'Context packages must stay immutable once ready.',
      status: 'promoted',
    });
    createMemoryItem(memoryCtx, {
      goalId: goal.id,
      type: 'note',
      content: 'Candidate memory may appear after promoted memory.',
    });
    const archivedMemory = createMemoryItem(memoryCtx, {
      goalId: goal.id,
      type: 'note',
      content: 'Archived memory must not be rendered in the package.',
    });
    patchMemoryItem(memoryCtx, archivedMemory.id, { status: 'archived' });

    const decisionCtx = { db, bus: eventBus, now: () => NOW };
    const needsConfirmation = createDecision(decisionCtx, {
      goalId: goal.id,
      title: 'Delivery mode requires confirmation',
      decisionText: 'Use the visible initial input delivery path for shell/manual tests.',
      confirmationRequired: true,
    });
    const archivedDecision = createDecision(decisionCtx, {
      goalId: goal.id,
      title: 'Archived decision',
      decisionText: 'This archived decision must not be rendered.',
    });
    patchDecision(decisionCtx, archivedDecision.id, { status: 'archived' });

    seedSiblingSummary(db, goal.id, workspace.id);

    const packageRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goal.id}/context-packages`,
      headers: AUTH,
      payload: {
        adapterId: 'claude-code',
        workspaceId: workspace.id,
        role: 'engineer',
        objective: 'Implement the restart-safe context proof loop.',
      },
    });
    expect(packageRes.statusCode, packageRes.body).toBe(201);
    const packageBody = CreateContextPackageResponse.parse(JSON.parse(packageRes.body));
    expect(packageBody.reused).toBe(false);
    expect(packageBody.assembly.status).toBe('succeeded');
    expect(packageBody.package).not.toBeNull();

    const contextPackage = packageBody.package!;
    expect(contextPackage.truncated).toBe(false);
    expect(contextPackage.sparse).toBe(false);
    expect(contextPackage.renderedContext).toContain(`[mem:${promotedMemory.id}]`);
    expect(contextPackage.renderedContext).toContain(`[dec:${needsConfirmation.id}]`);
    expect(contextPackage.renderedContext).toContain('Needs Confirmation');
    expect(contextPackage.renderedContext).not.toContain('Archived memory must not be rendered');
    expect(contextPackage.renderedContext).not.toContain('This archived decision must not be rendered');

    const contextEvents = db
      .prepare(
        `SELECT type, payload FROM events
         WHERE goal_id = ? AND type IN ('context.assembly.requested', 'context.assembly.completed', 'context.package.created')
         ORDER BY seq ASC`
      )
      .all(goal.id) as { type: string; payload: string }[];
    expect(contextEvents.map((event) => event.type)).toEqual([
      'context.assembly.requested',
      'context.assembly.completed',
      'context.package.created',
    ]);
    for (const row of contextEvents) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('renderedContext');
      expect(payload).not.toHaveProperty('objective');
      expect(JSON.stringify(payload)).not.toContain('Context packages must stay immutable');
      expect(JSON.stringify(payload)).not.toContain('Use the visible initial input delivery path');
    }
    expect(publishedEvents.filter((event) => event.type.startsWith('context.')).map((event) => event.type)).toEqual([
      'context.assembly.requested',
      'context.assembly.completed',
      'context.package.created',
    ]);

    const createSessionRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goal.id}/sessions`,
      headers: AUTH,
      payload: {
        workspaceId: workspace.id,
        adapterId: 'claude-code',
        contextPackageId: contextPackage.id,
      },
    });
    expect(createSessionRes.statusCode, createSessionRes.body).toBe(201);
    const session = CreateSessionResponse.parse(JSON.parse(createSessionRes.body)).session;
    expect(session.contextPackageId).toBe(contextPackage.id);

    const sessionRow = db
      .prepare('SELECT context_package_id FROM sessions WHERE id = ?')
      .get(session.id) as { context_package_id: string | null };
    expect(sessionRow.context_package_id).toBe(contextPackage.id);

    const sessionCreatedPayload = db
      .prepare("SELECT payload FROM events WHERE type = 'session.created' AND goal_id = ? ORDER BY seq DESC LIMIT 1")
      .get(goal.id) as { payload: string };
    expect(JSON.parse(sessionCreatedPayload.payload)).toMatchObject({
      sessionId: session.id,
      contextPackageId: contextPackage.id,
    });

    const startSessionRes = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/start`,
      headers: AUTH,
      payload: { terminalCols: 80, terminalRows: 24 },
    });
    expect(startSessionRes.statusCode, startSessionRes.body).toBe(200);
    const handle = runtime.getHandle(session.id);
    expect(handle).toBeDefined();
    const control = controlFakePty(handle!);
    // claude-code uses preview_only delivery: the rendered context is linked to
    // the session but never streamed into the PTY or the spawn argv/command.
    const written = Buffer.concat(control.writtenChunks as Buffer[]).toString('utf8');
    expect(written).not.toContain(contextPackage.renderedContext);

    const startedRow = db
      .prepare('SELECT args_json, command FROM sessions WHERE id = ?')
      .get(session.id) as { args_json: string | null; command: string | null };
    expect(startedRow.args_json ?? '').not.toContain(contextPackage.renderedContext);
    expect(startedRow.command ?? '').not.toContain(contextPackage.renderedContext);

    control.emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await server.close();
    server = null;
    closeDatabase();
    resetPreparedStatements();

    db = openTestDb(config);
    const restartEvents: DomainEvent[] = [];
    const unsubscribeRestart = eventBus.subscribe((event) => restartEvents.push(event));
    reconcileStaleAssemblies(db, eventBus, '2026-05-20T12:05:00.000Z');
    unsubscribeRestart();

    server = createServer(config, {
      sessionRuntime: new SessionRuntime(new FakePtyManager()),
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });

    const detailRes = await server.inject({
      method: 'GET',
      url: `/v1/context-packages/${contextPackage.id}`,
      headers: AUTH,
    });
    expect(detailRes.statusCode, detailRes.body).toBe(200);
    const detail = GetContextPackageResponse.parse(JSON.parse(detailRes.body)).package;
    expect(detail.id).toBe(contextPackage.id);
    expect(detail.renderedContext).toBe(contextPackage.renderedContext);

    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM context_packages WHERE id = ?", contextPackage.id)
    ).toBe(1);
    expect(
      countRows(
        db,
        "SELECT COUNT(*) AS count FROM context_assemblies WHERE id = ? AND status = 'succeeded'",
        packageBody.assembly.id
      )
    ).toBe(1);
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM sessions WHERE id = ? AND context_package_id = ?", session.id, contextPackage.id)
    ).toBe(1);
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM context_assemblies WHERE status IN ('pending', 'running')")
    ).toBe(0);
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM events WHERE goal_id = ? AND type = 'context.assembly.failed' AND payload LIKE '%daemon_restart%'", goal.id)
    ).toBe(0);
    expect(restartEvents.filter((event) => event.type === 'context.assembly.failed')).toHaveLength(0);
  });
});
