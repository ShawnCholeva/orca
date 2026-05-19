import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  CreateGoalResponse,
  CreateSessionResponse,
  GetSessionResponse,
  GoalDetailResponse,
  ListAdaptersResponse,
  StartSessionResponse,
  type DomainEvent,
} from '@orca/contracts';
import { loadConfig } from '../src/config.js';
import { closeDatabase, getDatabase, openDatabase } from '../src/db.js';
import { eventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';
import { createServer } from '../src/server.js';
import { reconcileSessionsOnBoot } from '../src/sessions/reconciliation.js';

beforeAll(() => {
  bootstrapRegistries();
});

const ORCA_ENV_KEYS = [
  'ORCA_DATA_DIR',
  'ORCA_PORT',
  'ORCA_LOG_LEVEL',
  'ORCA_TOKEN',
  'ORCA_SHELL',
] as const;
const TOKEN = 'm4-011-token';
const AUTH_HEADERS = { authorization: `Bearer ${TOKEN}` } as const;

const tempDirs: string[] = [];

interface BootResult {
  server: FastifyInstance;
  baseUrl: string;
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetOrcaEnv(dataDir: string): void {
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  process.env.ORCA_DATA_DIR = dataDir;
  process.env.ORCA_LOG_LEVEL = 'silent';
  process.env.ORCA_TOKEN = TOKEN;
  process.env.ORCA_SHELL = '/bin/sh';
}

async function boot(dataDir: string): Promise<BootResult> {
  resetOrcaEnv(dataDir);
  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  reconcileSessionsOnBoot(db, eventBus, new Date().toISOString());

  const server = createServer(config);
  await server.listen({ host: '127.0.0.1', port: 0 });

  const addr = server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to resolve server address');

  return { server, baseUrl: `http://127.0.0.1:${(addr as AddressInfo).port}` };
}

async function stop(server: FastifyInstance): Promise<void> {
  await server.close();
  closeDatabase();
}

async function openEventsSocket(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/v1/events?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString();
    messages.push(JSON.parse(raw));
  });
  return messages;
}

function waitForMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket message`));
    }, timeoutMs);

    function handler(data: WebSocket.RawData): void {
      let parsed: Record<string, unknown>;
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    }

    ws.on('message', handler);
  });
}

async function postJson(baseUrl: string, url: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify(body),
  });
}

async function getJson(baseUrl: string, url: string): Promise<Response> {
  return fetch(`${baseUrl}${url}`, { headers: AUTH_HEADERS });
}

function decodeOutput(body: GetSessionResponse): string {
  return body.output.chunks
    .map((chunk) => Buffer.from(chunk.dataBase64, 'base64').toString())
    .join('');
}

afterAll(() => {
  closeDatabase();
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.sequential('M4-011 real shell vertical slice', () => {
  it('runs shell-manual through HTTP + WS, persists output, and preserves it after restart', async () => {
    const rootDir = createTempDir('orca-m4-011-');
    const workspaceDir = path.join(rootDir, 'workspace');
    const dbDir = path.join(rootDir, 'daemon-db');
    mkdirSync(workspaceDir);
    mkdirSync(dbDir);

    let server1: FastifyInstance | undefined;
    let server2: FastifyInstance | undefined;
    let ws: WebSocket | undefined;

    try {
      const boot1 = await boot(dbDir);
      server1 = boot1.server;

      const goalResponse = await postJson(boot1.baseUrl, '/v1/goals', {
        title: 'M4-011 Goal',
        description: 'real shell vertical slice',
        workspaces: [{ inputPath: workspaceDir }],
      });
      expect(goalResponse.status).toBe(201);
      const goal = CreateGoalResponse.parse(await goalResponse.json()).goal;

      const goalDetailResponse = await getJson(boot1.baseUrl, `/v1/goals/${goal.id}`);
      expect(goalDetailResponse.status).toBe(200);
      const goalDetail = GoalDetailResponse.parse(await goalDetailResponse.json());
      const workspaceId = goalDetail.workspaces[0]?.id;
      expect(workspaceId).toBeDefined();

      const adaptersResponse = await getJson(boot1.baseUrl, '/v1/adapters');
      expect(adaptersResponse.status).toBe(200);
      const adapters = ListAdaptersResponse.parse(await adaptersResponse.json()).adapters;
      expect(adapters.find((adapter) => adapter.id === 'shell-manual')?.availability).toBe('available');

      const createSessionResponse = await postJson(boot1.baseUrl, `/v1/goals/${goal.id}/sessions`, {
        workspaceId,
        adapterId: 'shell-manual',
        title: 'Manual shell',
      });
      expect(createSessionResponse.status).toBe(201);
      const sessionId = CreateSessionResponse.parse(await createSessionResponse.json()).session.id;

      ws = await openEventsSocket(boot1.baseUrl);
      const wsMessages = collectMessages(ws);
      ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));

      const startResponse = await postJson(boot1.baseUrl, `/v1/sessions/${sessionId}/start`, {
        terminalCols: 80,
        terminalRows: 24,
      });
      expect(startResponse.status).toBe(200);
      expect(StartSessionResponse.parse(await startResponse.json()).session.status).toBe('running');

      const outputPromise = waitForMessage(
        ws,
        (message) =>
          message.type === 'session.output' &&
          Buffer.from(String(message.dataBase64), 'base64').toString().includes('orca-vertical-slice')
      );
      const exitPromise = waitForMessage(
        ws,
        (message) =>
          message.type === 'session.exited' &&
          (message.payload as { sessionId?: string } | undefined)?.sessionId === sessionId
      );

      ws.send(JSON.stringify({
        type: 'session.input',
        sessionId,
        dataBase64: Buffer.from('echo orca-vertical-slice && exit 0\n').toString('base64'),
      }));

      await outputPromise;
      await exitPromise;

      const detailResponse = await getJson(boot1.baseUrl, `/v1/sessions/${sessionId}`);
      expect(detailResponse.status).toBe(200);
      const detail = GetSessionResponse.parse(await detailResponse.json());
      expect(detail.session.status).toBe('exited');
      expect(detail.session.exitCode).toBe(0);
      expect(decodeOutput(detail)).toContain('orca-vertical-slice');

      const eventRows = getDatabase()
        .prepare('SELECT type FROM events WHERE goal_id = ? AND type LIKE ? ORDER BY seq ASC')
        .all(goal.id, 'session.%') as { type: string }[];
      expect(eventRows.map((row) => row.type)).toEqual([
        'session.created',
        'session.started',
        'session.exited',
      ]);

      const terminalEvents = eventRows.filter((row) =>
        ['session.exited', 'session.failed', 'session.stopped'].includes(row.type)
      );
      expect(terminalEvents).toHaveLength(1);

      const outputFrames = wsMessages.filter((message): message is { type: string; seq: number } => {
        return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'session.output';
      });
      expect(outputFrames.map((frame) => frame.seq)).toEqual(
        [...outputFrames].map((frame) => frame.seq).sort((a, b) => a - b)
      );

      ws.close();
      await new Promise<void>((resolve) => ws?.once('close', () => resolve()));
      ws = undefined;
      await stop(server1);
      server1 = undefined;

      const boot2 = await boot(dbDir);
      server2 = boot2.server;

      const afterRestartResponse = await getJson(boot2.baseUrl, `/v1/sessions/${sessionId}`);
      expect(afterRestartResponse.status).toBe(200);
      const afterRestart = GetSessionResponse.parse(await afterRestartResponse.json());
      expect(afterRestart.session.status).toBe('exited');
      expect(decodeOutput(afterRestart)).toContain('orca-vertical-slice');
    } finally {
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
      if (server1) await stop(server1);
      if (server2) await stop(server2);
    }
  });

  it('marks stale running sessions failed with daemon_restart before listen', async () => {
    const rootDir = createTempDir('orca-m4-011-reconcile-');
    const workspaceDir = path.join(rootDir, 'workspace');
    const dbDir = path.join(rootDir, 'daemon-db');
    mkdirSync(workspaceDir);
    mkdirSync(dbDir);

    let server1: FastifyInstance | undefined;
    let server2: FastifyInstance | undefined;

    try {
      const boot1 = await boot(dbDir);
      server1 = boot1.server;

      const goalResponse = await postJson(boot1.baseUrl, '/v1/goals', {
        title: 'M4-011 Reconcile Goal',
        workspaces: [{ inputPath: workspaceDir }],
      });
      const goalId = CreateGoalResponse.parse(await goalResponse.json()).goal.id;

      const goalDetailResponse = await getJson(boot1.baseUrl, `/v1/goals/${goalId}`);
      const workspaceId = GoalDetailResponse.parse(await goalDetailResponse.json()).workspaces[0]!.id;

      const createSessionResponse = await postJson(boot1.baseUrl, `/v1/goals/${goalId}/sessions`, {
        workspaceId,
        adapterId: 'shell-manual',
      });
      const sessionId = CreateSessionResponse.parse(await createSessionResponse.json()).session.id;

      getDatabase().prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(sessionId);

      await stop(server1);
      server1 = undefined;

      const boot2 = await boot(dbDir);
      server2 = boot2.server;

      const response = await getJson(boot2.baseUrl, `/v1/sessions/${sessionId}`);
      expect(response.status).toBe(200);
      const body = GetSessionResponse.parse(await response.json());
      expect(body.session.status).toBe('failed');
      expect(body.session.failureReason).toBe('daemon_restart');

      const terminalRows = getDatabase()
        .prepare('SELECT type FROM events WHERE goal_id = ? AND type IN (?, ?, ?) ORDER BY seq ASC')
        .all(goalId, 'session.exited', 'session.failed', 'session.stopped') as { type: string }[];
      expect(terminalRows.map((row) => row.type)).toEqual(['session.failed']);
    } finally {
      if (server1) await stop(server1);
      if (server2) await stop(server2);
    }
  });
});
