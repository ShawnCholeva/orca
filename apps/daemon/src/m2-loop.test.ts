/**
 * M2-014: End-to-end M2 fitness function integration suite.
 * Locks the following invariants against regression:
 *   S1 Boot          — health reports registries: { plugins: 3, skills: 1 }
 *   S2 Registry      — GET /v1/plugins and GET /v1/skills return the expected built-ins
 *   S3 Event order   — skill.invoked (smaller seq) precedes goal.created in the events table
 *   S4 Rollback      — projection failure rolls back both event rows; returns 5xx
 *   S5 WS order      — WebSocket delivers skill.invoked then goal.created, same goalId, seq ordered
 *   S6 Invalid input — blank title → 400; no events written; no WS messages delivered
 *   S7 Restart       — event ordering survives DB close/reopen
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CreateGoalResponse,
  DomainEvent,
  HealthResponse,
  ListGoalsResponse,
  ListPluginsResponse,
  ListSkillsResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { createServer } from './server.js';
import { closeDatabase, getDatabase, openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { bootstrapRegistries } from './registry/bootstrap.js';

// Populate registries once per worker — mirrors daemon index.ts boot order.
beforeAll(() => {
  bootstrapRegistries();
});

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;

function makeConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    getAuthToken: () => 'test-token'
  };
}

function bootServer(dataDir: string): FastifyInstance {
  const config = makeConfig(dataDir);
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  return createServer(config);
}

// Scenarios 1–6: shared server per test, fresh temp dir per test.
describe.sequential('M2-014 — scenarios 1–6', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-m2-loop-'));
    tempDirs.push(dir);
    server = bootServer(dir);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S1 — boot: GET /v1/health returns registries: { plugins: 3, skills: 1 }', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = HealthResponse.parse(JSON.parse(res.body));
    expect(body.status).toBe('ok');
    expect(body.registries).toEqual({ plugins: 3, skills: 1 });
  });

  it('S2a — registry: GET /v1/plugins returns three built-in ids in sorted order', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/plugins',
      headers: AUTH_HEADERS
    });

    expect(res.statusCode).toBe(200);
    const body = ListPluginsResponse.parse(JSON.parse(res.body));
    expect(body.plugins.map((p) => p.id)).toEqual([
      'orca.default-skills',
      'orca.shell-manual',
      'orca.sqlite'
    ]);
  });

  it('S2b — registry: GET /v1/skills returns quick-goal with goal.create extension point', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/skills',
      headers: AUTH_HEADERS
    });

    expect(res.statusCode).toBe(200);
    const body = ListSkillsResponse.parse(JSON.parse(res.body));
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]?.id).toBe('quick-goal');
    expect(body.skills[0]?.extensionPoint).toBe('goal.create');
    expect(body.skills[0]?.pluginId).toBe('orca.default-skills');
  });

  it('S3 — create: skill.invoked (smaller seq) precedes goal.created; both share goal_id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'M2 loop' }
    });

    expect(res.statusCode).toBe(201);
    const { goal } = CreateGoalResponse.parse(JSON.parse(res.body));
    const db = getDatabase();

    const rows = db
      .prepare('SELECT seq, type, goal_id FROM events WHERE goal_id = ? ORDER BY seq ASC')
      .all(goal.id) as { seq: number; type: string; goal_id: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe('skill.invoked');
    expect(rows[1]!.type).toBe('goal.created');
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect(rows[0]!.goal_id).toBe(goal.id);
    expect(rows[1]!.goal_id).toBe(goal.id);
  });

  it('S4 — rollback: projection failure → 5xx; both event rows absent from events table', async () => {
    const db = getDatabase();
    // Inject a trigger that fires AFTER the two event inserts but BEFORE the goals projection
    // insert, so the rollback must cover all three rows inside the same transaction.
    db.exec(`
      CREATE TRIGGER force_goal_insert_failure BEFORE INSERT ON goals
      BEGIN SELECT RAISE(ABORT, 'forced failure for rollback test'); END;
    `);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Should Roll Back' }
    });

    expect(res.statusCode).toBe(500);

    const eventCount = (db.prepare('SELECT count(*) AS c FROM events').get() as { c: number }).c;
    const goalCount = (db.prepare('SELECT count(*) AS c FROM goals').get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
  });

  it('S5 — WS order: skill.invoked arrives before goal.created; same goalId; seq ordered', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');
    const received: DomainEvent[] = [];

    const twoEvents = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        received.push(DomainEvent.parse(JSON.parse(data.toString())));
        if (received.length >= 2) resolve();
      });
    });

    await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'WS order' }
    });

    await Promise.race([
      twoEvents,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WS: 2 events not received within 500ms')), 500)
      )
    ]);

    ws.terminate();

    expect(received).toHaveLength(2);
    const [first, second] = received as [DomainEvent, DomainEvent];
    expect(first.type).toBe('skill.invoked');
    expect(second.type).toBe('goal.created');
    expect(first.goalId).toBe(second.goalId);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it('S6 — invalid input: blank title → 400; no events written; no WS messages delivered', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');
    let wsCount = 0;
    ws.on('message', () => wsCount++);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: '  ' }
    });

    expect(res.statusCode).toBe(400);

    // Allow any in-flight async to settle before asserting zero messages.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    ws.terminate();

    const db = getDatabase();
    const eventCount = (db.prepare('SELECT count(*) AS c FROM events').get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(wsCount).toBe(0);
  });
});

// Scenario 7: separate describe — manages its own server lifecycle for the restart.
describe('M2-014 S7 — restart: event ordering survives DB close/reopen', () => {
  it('skill.invoked row immediately precedes goal.created after server restart', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-m2-restart-'));

    // First boot: create a goal.
    const server1 = bootServer(dataDir);
    await server1.ready();

    const res = await server1.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Persisted' }
    });
    expect(res.statusCode).toBe(201);
    const { goal } = CreateGoalResponse.parse(JSON.parse(res.body));

    await server1.close();
    closeDatabase();

    // Second boot: verify the goal and event ordering persist across the restart.
    const server2 = bootServer(dataDir);
    await server2.ready();

    try {
      const listRes = await server2.inject({
        method: 'GET',
        url: '/v1/goals',
        headers: AUTH_HEADERS
      });
      expect(listRes.statusCode).toBe(200);
      const { goals } = ListGoalsResponse.parse(JSON.parse(listRes.body));
      expect(goals).toHaveLength(1);
      expect(goals[0]?.id).toBe(goal.id);

      const db = getDatabase();
      const rows = db
        .prepare('SELECT seq, type FROM events WHERE goal_id = ? ORDER BY seq ASC')
        .all(goal.id) as { seq: number; type: string }[];

      expect(rows).toHaveLength(2);
      expect(rows[0]!.type).toBe('skill.invoked');
      expect(rows[1]!.type).toBe('goal.created');
      expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    } finally {
      await server2.close();
      closeDatabase();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
