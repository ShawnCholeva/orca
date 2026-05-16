import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  CreateGoalResponse,
  DomainEvent,
  HealthResponse,
  ListGoalsResponse
} from '@orca/contracts';
import { loadConfig } from '../src/config.js';
import { closeDatabase, getDatabase, openDatabase } from '../src/db.js';
import { eventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { createServer } from '../src/server.js';

const ORCA_ENV_KEYS = ['ORCA_DATA_DIR', 'ORCA_PORT', 'ORCA_LOG_LEVEL', 'ORCA_TOKEN'] as const;

interface BootResult {
  server: FastifyInstance;
  baseUrl: string;
  migrationRows: { name: string; applied_at: string }[];
}

const tempDirs: string[] = [];

const AUTH_HEADERS = { authorization: 'Bearer m1-017-token' } as const;

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-m1-017-'));
  tempDirs.push(dir);
  return dir;
}

function resetOrcaEnvForTest(dataDir: string): void {
  for (const key of ORCA_ENV_KEYS) {
    delete process.env[key];
  }

  process.env.ORCA_DATA_DIR = dataDir;
  process.env.ORCA_LOG_LEVEL = 'silent';
  process.env.ORCA_TOKEN = 'm1-017-token';
}

async function boot(dataDir: string): Promise<BootResult> {
  resetOrcaEnvForTest(dataDir);

  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());

  const migrationRows = db
    .prepare('SELECT name, applied_at FROM _migrations ORDER BY id ASC')
    .all() as { name: string; applied_at: string }[];

  const server = createServer(config);
  await server.listen({ host: '127.0.0.1', port: 0 });

  const address = server.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return { server, baseUrl, migrationRows };
}

async function stop(server: FastifyInstance): Promise<void> {
  await server.close();
  closeDatabase();
}

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();

  for (const key of ORCA_ENV_KEYS) {
    delete process.env[key];
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.sequential('M1-017 daemon integration loop', () => {
  it('Boot: health endpoint returns ok', async () => {
    const dir = createTempDir();
    const { server, baseUrl } = await boot(dir);

    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      expect(response.status).toBe(200);

      const body = HealthResponse.parse(await response.json());
      expect(body.status).toBe('ok');
    } finally {
      await stop(server);
    }
  });

  it('Migrations apply once; second boot leaves _migrations unchanged', async () => {
    const dir = createTempDir();

    const firstBoot = await boot(dir);
    const firstRows = firstBoot.migrationRows;
    await stop(firstBoot.server);

    const secondBoot = await boot(dir);

    try {
      expect(firstRows).toHaveLength(1);
      expect(firstRows[0]?.name).toBe('0001_init.sql');
      expect(secondBoot.migrationRows).toEqual(firstRows);
    } finally {
      await stop(secondBoot.server);
    }
  });

  it('Create Goal: events/goals rows are 1/1 with matching IDs', async () => {
    const dir = createTempDir();
    const { server, baseUrl } = await boot(dir);

    try {
      const response = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ title: 'M1-017 Goal', description: 'integration' })
      });

      expect(response.status).toBe(201);
      const created = CreateGoalResponse.parse(await response.json());

      const db = getDatabase();
      const eventCount =
        (db.prepare('SELECT count(*) AS cnt FROM events').get() as { cnt: number }).cnt;
      const goalCount =
        (db.prepare('SELECT count(*) AS cnt FROM goals').get() as { cnt: number }).cnt;

      expect(eventCount).toBe(1);
      expect(goalCount).toBe(1);

      const eventGoalId = (
        db.prepare('SELECT goal_id FROM events WHERE type = ? LIMIT 1').get('goal.created') as
          | { goal_id: string }
          | undefined
      )?.goal_id;

      expect(eventGoalId).toBe(created.goal.id);
    } finally {
      await stop(server);
    }
  });

  it('WS delivery: real client receives goal.created after HTTP resolves', async () => {
    const dir = createTempDir();
    const { server, baseUrl } = await boot(dir);

    const ws = new WebSocket(
      `${baseUrl.replace('http://', 'ws://')}/v1/events?token=m1-017-token`
    );

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const eventPromise = new Promise<unknown>((resolve, reject) => {
          ws.once('message', (data) => {
            try {
              const message = typeof data === 'string' ? data : data.toString();
              resolve(JSON.parse(message));
            } catch (error) {
              reject(error);
            }
          });

          ws.once('error', reject);
        }
      );

      const response = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ title: 'WS Delivery Goal' })
      });

      expect(response.status).toBe(201);

      const eventPayload = await Promise.race([
        eventPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('WS message not received within 250ms')), 250);
        })
      ]);

      const event = DomainEvent.parse(eventPayload);
      expect(event.type).toBe('goal.created');
    } finally {
      ws.close();
      await stop(server);
    }
  });

  it('Restart persistence: reboot preserves previously created goals', async () => {
    const dir = createTempDir();

    const firstBoot = await boot(dir);
    const createResponse = await fetch(`${firstBoot.baseUrl}/v1/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ title: 'Persisted Goal', description: 'survives reboot' })
    });
    expect(createResponse.status).toBe(201);
    const created = CreateGoalResponse.parse(await createResponse.json());
    await stop(firstBoot.server);

    const secondBoot = await boot(dir);

    try {
      const listResponse = await fetch(`${secondBoot.baseUrl}/v1/goals`, {
        headers: AUTH_HEADERS
      });
      expect(listResponse.status).toBe(200);

      const listed = ListGoalsResponse.parse(await listResponse.json());
      expect(listed.goals).toHaveLength(1);
      expect(listed.goals[0]?.id).toBe(created.goal.id);
      expect(listed.goals[0]?.title).toBe('Persisted Goal');
    } finally {
      await stop(secondBoot.server);
    }
  });

  it('Transaction rollback: projection failure leaves DB unchanged and no bus publish', async () => {
    const dir = createTempDir();
    const { server, baseUrl } = await boot(dir);

    try {
      const db = getDatabase();
      db.exec(`
        CREATE TRIGGER force_goal_insert_failure BEFORE INSERT ON goals
        BEGIN SELECT RAISE(ABORT, 'forced failure for rollback test'); END;
      `);

      const publishSpy = vi.spyOn(eventBus, 'publish');

      const response = await fetch(`${baseUrl}/v1/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        body: JSON.stringify({ title: 'Should Roll Back' })
      });

      expect(response.status).toBe(500);

      const eventCount =
        (db.prepare('SELECT count(*) AS cnt FROM events').get() as { cnt: number }).cnt;
      const goalCount =
        (db.prepare('SELECT count(*) AS cnt FROM goals').get() as { cnt: number }).cnt;

      expect(eventCount).toBe(0);
      expect(goalCount).toBe(0);
      expect(publishSpy).not.toHaveBeenCalled();
    } finally {
      await stop(server);
    }
  });
});
