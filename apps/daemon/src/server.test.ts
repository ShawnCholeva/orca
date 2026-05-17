import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ArchiveGoalResponse,
  CreateGoalResponse,
  DomainEvent,
  HealthResponse,
  ListEventsResponse,
  ListGoalsResponse,
  ListPluginsResponse,
  ListSkillsResponse,
  UpdateGoalResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { createServer } from './server.js';
import { closeDatabase, openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { bootstrapRegistries } from './registry/bootstrap.js';

// Populate the skill registry once for the file — mirrors the daemon boot sequence.
// createGoal resolves quick-goal from the registry (M2-008).
beforeAll(() => {
  bootstrapRegistries();
});

const tempDirs: string[] = [];

const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    getAuthToken: () => 'test-token'
  };
}

describe('server routes', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-server-test-'));
    tempDirs.push(dir);

    const config = createConfig(dir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 200 with conformant HealthResponse', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    const body = HealthResponse.parse(JSON.parse(response.body));
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.startedAt).toBe('string');
  });

  it('GET /v1/plugins returns built-in plugins in sorted order', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/plugins',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(200);
    const body = ListPluginsResponse.parse(JSON.parse(response.body));
    expect(body.plugins.map((plugin) => plugin.id)).toEqual([
      'orca.default-skills',
      'orca.shell-manual',
      'orca.sqlite'
    ]);
  });

  it('GET /v1/skills returns the built-in quick-goal skill', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/skills',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(200);
    const body = ListSkillsResponse.parse(JSON.parse(response.body));
    expect(body.skills).toEqual([
      {
        id: 'quick-goal',
        pluginId: 'orca.default-skills',
        extensionPoint: 'goal.create',
        title: 'Quick Goal',
        description: 'Deterministic normalization of Goal creation input. No AI.'
      }
    ]);
  });

  it('POST /v1/goals returns 201 with a valid Goal payload', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'first', description: 'desc' }
    });

    expect(response.statusCode).toBe(201);
    const body = CreateGoalResponse.parse(JSON.parse(response.body));
    expect(body.goal.title).toBe('first');
    expect(body.goal.description).toBe('desc');
    expect(body.goal.status).toBe('active');
  });

  it('POST /v1/goals returns 400 for invalid payload', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: '' }
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error?: string; issues?: unknown[] };
    expect(body.error).toBe('validation_failed');
    expect(Array.isArray(body.issues)).toBe(true);
    expect((body.issues ?? []).length).toBeGreaterThan(0);
  });

  it('PATCH /v1/goals/:id updates the goal and returns 200', async () => {
    const created = CreateGoalResponse.parse(
      JSON.parse(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/goals',
            headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
            payload: { title: 'orig' }
          })
        ).body
      )
    );

    const response = await server.inject({
      method: 'PATCH',
      url: `/v1/goals/${created.goal.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'renamed' }
    });

    expect(response.statusCode).toBe(200);
    const body = UpdateGoalResponse.parse(JSON.parse(response.body));
    expect(body.goal.id).toBe(created.goal.id);
    expect(body.goal.title).toBe('renamed');
  });

  it('PATCH /v1/goals/:id returns 404 for unknown id', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: '/v1/goals/missing',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'x' }
    });
    expect(response.statusCode).toBe(404);
  });

  it('PATCH /v1/goals/:id returns 400 for empty patch', async () => {
    const created = CreateGoalResponse.parse(
      JSON.parse(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/goals',
            headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
            payload: { title: 'orig' }
          })
        ).body
      )
    );

    const response = await server.inject({
      method: 'PATCH',
      url: `/v1/goals/${created.goal.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {}
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/goals/:id/archive archives and removes from default list', async () => {
    const created = CreateGoalResponse.parse(
      JSON.parse(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/goals',
            headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
            payload: { title: 'to-archive' }
          })
        ).body
      )
    );

    const response = await server.inject({
      method: 'POST',
      url: `/v1/goals/${created.goal.id}/archive`,
      headers: AUTH_HEADERS
    });
    expect(response.statusCode).toBe(200);
    const body = ArchiveGoalResponse.parse(JSON.parse(response.body));
    expect(body.goal.status).toBe('archived');
    expect(body.goal.archivedAt).not.toBeNull();

    const list = ListGoalsResponse.parse(
      JSON.parse(
        (await server.inject({ method: 'GET', url: '/v1/goals', headers: AUTH_HEADERS })).body
      )
    );
    expect(list.goals).toHaveLength(0);
  });

  it('POST /v1/goals/:id/archive returns 404 for unknown id', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/missing/archive',
      headers: AUTH_HEADERS
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /v1/goals returns a created Goal', async () => {
    const postResponse = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'second' }
    });
    expect(postResponse.statusCode).toBe(201);
    const created = CreateGoalResponse.parse(JSON.parse(postResponse.body));

    const getResponse = await server.inject({
      method: 'GET',
      url: '/v1/goals',
      headers: AUTH_HEADERS
    });
    expect(getResponse.statusCode).toBe(200);

    const listed = ListGoalsResponse.parse(JSON.parse(getResponse.body));
    expect(listed.goals).toHaveLength(1);
    expect(listed.goals[0]?.id).toBe(created.goal.id);
    expect(listed.goals[0]?.title).toBe('second');
  });

  it('PATCH /v1/goals/:id returns 404 for an archived goal', async () => {
    const created = CreateGoalResponse.parse(
      JSON.parse(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/goals',
            headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
            payload: { title: 'will-archive' }
          })
        ).body
      )
    );

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${created.goal.id}/archive`,
      headers: AUTH_HEADERS
    });

    const response = await server.inject({
      method: 'PATCH',
      url: `/v1/goals/${created.goal.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'late-edit' }
    });

    expect(response.statusCode).toBe(404);
  });

  it('GET /v1/health is unauthenticated and returns 200', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
  });

  it('POST /v1/goals without Authorization returns 401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'noauth' }
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body) as { error?: string };
    expect(body.error).toBe('unauthorized');
  });

  it('POST /v1/goals with wrong bearer returns 401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      payload: { title: 'badauth' }
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/goals without Authorization returns 401', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/goals' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/plugins without Authorization returns 401', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/plugins' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/skills without Authorization returns 401', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/skills' });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/goals/:id without Authorization returns 401', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: '/v1/goals/any-id',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'x' }
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/goals/:id/archive without Authorization returns 401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/any-id/archive'
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/events (replay) without Authorization returns 401', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/events?sinceSeq=0' });
    expect(response.statusCode).toBe(401);
  });
});

describe('WebSocket /v1/events', () => {
  let wsServer: FastifyInstance;
  const wsDirs: string[] = [];

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ws-test-'));
    wsDirs.push(dir);
    const config = createConfig(dir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    wsServer = createServer(config);
    await wsServer.ready();
  });

  afterEach(async () => {
    await wsServer.close();
    closeDatabase();
    for (const dir of wsDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivers goal.created event to subscriber within 250ms', async () => {
    const ws = await wsServer.injectWS('/v1/events?token=test-token');

    // M2-008: each createGoal emits skill.invoked then goal.created — wait for goal.created.
    const messagePromise = new Promise<DomainEvent>((resolve) => {
      const handler = (data: Buffer | ArrayBuffer | Buffer[]) => {
        const event = DomainEvent.parse(JSON.parse(data.toString()));
        if (event.type === 'goal.created') {
          ws.off('message', handler);
          resolve(event);
        }
      };
      ws.on('message', handler);
    });

    await wsServer.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'ws-goal' }
    });

    const event = await Promise.race([
      messagePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WS message not received within 250ms')), 250)
      )
    ]);

    ws.terminate();
    expect(event.type).toBe('goal.created');
    expect(event.goalId).toBeDefined();
  });

  it('closing WS does not crash the server; events not delivered after close', async () => {
    const ws = await wsServer.injectWS('/v1/events?token=test-token');
    let received = 0;
    ws.on('message', () => received++);

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', resolve));

    await wsServer.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'after-close' }
    });

    // Allow any in-flight async to settle before asserting
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(received).toBe(0);
    const health = await wsServer.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);
  });

  it('rejects connection without valid token with close code 1008', async () => {
    const ws = await wsServer.injectWS('/v1/events'); // no token

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('error', () => {}); // suppress error from unexpected close
      ws.on('close', (code: number) => resolve(code));
    });

    expect(closeCode).toBe(1008);
  });
});

describe('GET /v1/events (replay)', () => {
  let server: FastifyInstance;
  const dirs: string[] = [];

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-events-replay-test-'));
    dirs.push(dir);
    const config = createConfig(dir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createGoalForTest(title: string): Promise<void> {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title }
    });
    expect(res.statusCode).toBe(201);
  }

  it('returns all events when sinceSeq=0 and paginates by seq', async () => {
    await createGoalForTest('a');
    await createGoalForTest('b');
    await createGoalForTest('c');

    const all = await server.inject({
      method: 'GET',
      url: '/v1/events?sinceSeq=0',
      headers: AUTH_HEADERS
    });
    expect(all.statusCode).toBe(200);
    const body = ListEventsResponse.parse(JSON.parse(all.body));
    // M2-008: each goal create emits skill.invoked + goal.created → 3 goals = 6 events
    expect(body.events).toHaveLength(6);
    expect(body.events.map((e) => e.type)).toEqual([
      'skill.invoked', 'goal.created',
      'skill.invoked', 'goal.created',
      'skill.invoked', 'goal.created',
    ]);
    expect(body.events[0]!.seq).toBeLessThan(body.events[1]!.seq);
    expect(body.events[1]!.seq).toBeLessThan(body.events[2]!.seq);
    expect(body.nextSinceSeq).toBe(body.events[5]!.seq);

    const sinceOne = await server.inject({
      method: 'GET',
      url: '/v1/events?sinceSeq=1',
      headers: AUTH_HEADERS
    });
    expect(sinceOne.statusCode).toBe(200);
    const sinceOneBody = ListEventsResponse.parse(JSON.parse(sinceOne.body));
    // sinceSeq=1 → events with seq > 1; 5 of the 6 events remain
    expect(sinceOneBody.events).toHaveLength(5);
    expect(sinceOneBody.events.every((e) => e.seq > 1)).toBe(true);
    expect(sinceOneBody.nextSinceSeq).toBe(sinceOneBody.events[4]!.seq);
  });

  it('defaults sinceSeq to 0 when omitted', async () => {
    await createGoalForTest('only');
    const res = await server.inject({
      method: 'GET',
      url: '/v1/events',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = ListEventsResponse.parse(JSON.parse(res.body));
    // M2-008: one goal = 2 events (skill.invoked + goal.created)
    expect(body.events).toHaveLength(2);
    expect(body.nextSinceSeq).toBe(body.events[1]!.seq);
  });

  it('returns empty events array and echoes sinceSeq when no new events', async () => {
    await createGoalForTest('x');
    const res = await server.inject({
      method: 'GET',
      url: '/v1/events?sinceSeq=999',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = ListEventsResponse.parse(JSON.parse(res.body));
    expect(body.events).toEqual([]);
    expect(body.nextSinceSeq).toBe(999);
  });

  it('rejects invalid sinceSeq with 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/events?sinceSeq=-1',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toBe('validation_failed');
  });
});
