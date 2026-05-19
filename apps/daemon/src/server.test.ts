import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ArchiveGoalResponse,
  CreateGoalResponse,
  CreateSessionResponse,
  DomainEvent,
  GetSessionResponse,
  GoalDecision,
  GoalMemoryItem,
  HealthResponse,
  ListAdaptersResponse,
  ListEventsResponse,
  ListGoalMemoryResponse,
  ListGoalDecisionsResponse,
  ListGoalsResponse,
  ListPluginsResponse,
  ListSessionsResponse,
  ListSkillsResponse,
  UpdateGoalResponse
} from '@orca/contracts';
import type { Config } from './config.js';
import { createServer } from './server.js';
import { closeDatabase, openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { eventBus } from './events.js';

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
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
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
    expect(body.registries).toEqual({ plugins: 3, skills: 2 });
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

  it('GET /v1/skills returns both built-in skills sorted by id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/skills',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(200);
    const body = ListSkillsResponse.parse(JSON.parse(response.body));
    expect(body.skills).toEqual([
      {
        id: 'guided-goal-refinement',
        pluginId: 'orca.default-skills',
        extensionPoint: 'goal.refine',
        title: 'Guided Goal Refinement',
        description: 'Deterministic structuring of a rough Goal into success criteria, constraints, and assumptions.'
      },
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

  it('POST /v1/sessions/:id/stop with extra body fields returns 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions/any-id/stop',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { extra: 'field' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error?: string; issues?: unknown[] };
    expect(body.error).toBe('validation_failed');
    expect(Array.isArray(body.issues)).toBe(true);
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

describe('M3 routes', () => {
  let server: FastifyInstance;
  let wsDir!: string;
  let wsDir2!: string;
  const m3Dirs: string[] = [];

  const DRAFT = {
    skillId: 'guided-goal-refinement' as const,
    title: 'My Goal',
    description: 'A description',
    successCriteria: ['Success 1'],
    constraints: ['Constraint 1'],
    assumptions: ['Assumption 1']
  };

  beforeEach(() => {
    const dbDir = mkdtempSync(path.join(os.tmpdir(), 'orca-m3-srv-'));
    m3Dirs.push(dbDir);
    wsDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-m3-ws1-')));
    m3Dirs.push(wsDir);
    wsDir2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-m3-ws2-')));
    m3Dirs.push(wsDir2);

    const config = createConfig(dbDir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of m3Dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // POST /v1/goals/refine
  it('POST /v1/goals/refine returns 200 with draft', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'My Goal', description: 'Goals:\n- ship it\nConstraints:\n- no budget' }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { draft: { skillId: string; title: string; successCriteria: string[] } };
    expect(body.draft.skillId).toBe('guided-goal-refinement');
    expect(body.draft.title).toBe('My Goal');
    expect(body.draft.successCriteria).toEqual(['ship it']);
  });

  it('POST /v1/goals/refine rejects unknown fields with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'x', skillId: 'sneaked-in' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/goals/refine without Authorization returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'x' }
    });
    expect(res.statusCode).toBe(401);
  });

  // POST /v1/goals — extended paths
  it('POST /v1/goals with refined + 2 workspaces returns 201 and emits events in order', async () => {
    const captured: string[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e.type));

    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: DRAFT.title,
        description: DRAFT.description,
        refined: DRAFT,
        workspaces: [{ inputPath: wsDir }, { inputPath: wsDir2 }]
      }
    });
    unsub();

    expect(res.statusCode).toBe(201);
    const body = CreateGoalResponse.parse(JSON.parse(res.body));
    expect(body.goal.title).toBe(DRAFT.title);
    expect(captured).toEqual([
      'skill.invoked', 'goal.created', 'goal.refined',
      'workspace.attached', 'workspace.attached',
      'memory.item.created', 'memory.item.promoted',
      'memory.item.created', 'memory.item.promoted',
    ]);
  });

  it('POST /v1/goals with one bad workspace path returns 400 with no events', async () => {
    const captured: string[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e.type));

    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'g',
        refined: DRAFT,
        workspaces: [{ inputPath: '/this/does/not/exist/ever/m3' }]
      }
    });
    unsub();

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    expect(captured).toHaveLength(0);
  });

  it('POST /v1/goals with duplicate workspace paths returns 400 duplicate_workspace_in_request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'g',
        refined: DRAFT,
        workspaces: [{ inputPath: wsDir }, { inputPath: wsDir }]
      }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('duplicate_workspace_in_request');
  });

  // GET /v1/goals/:id
  it('GET /v1/goals/:id returns 404 for nonexistent id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/goals/nonexistent',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/goals/:id returns 404 for archived goal', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { title: 'to-archive' }
      })).body
    ));
    await server.inject({ method: 'POST', url: `/v1/goals/${created.goal.id}/archive`, headers: AUTH_HEADERS });

    const res = await server.inject({ method: 'GET', url: `/v1/goals/${created.goal.id}`, headers: AUTH_HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/goals/:id returns bundle for refined goal with 2 workspaces', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: {
          title: DRAFT.title,
          description: DRAFT.description,
          refined: DRAFT,
          workspaces: [{ inputPath: wsDir }, { inputPath: wsDir2 }]
        }
      })).body
    ));

    const res = await server.inject({ method: 'GET', url: `/v1/goals/${created.goal.id}`, headers: AUTH_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      goal: { id: string };
      refinement: { successCriteria: string[] } | null;
      workspaces: { path: string }[];
    };
    expect(body.goal.id).toBe(created.goal.id);
    expect(body.refinement).not.toBeNull();
    expect(body.refinement!.successCriteria).toEqual(DRAFT.successCriteria);
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces.map((w) => w.path).sort()).toEqual([wsDir, wsDir2].sort());
  });

  it('GET /v1/goals/:id returns bundle with null refinement for quick goal', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { title: 'quick', description: 'no refine' }
      })).body
    ));

    const res = await server.inject({ method: 'GET', url: `/v1/goals/${created.goal.id}`, headers: AUTH_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { refinement: null; workspaces: unknown[] };
    expect(body.refinement).toBeNull();
    expect(body.workspaces).toHaveLength(0);
  });

  it('GET /v1/goals/:id without Authorization returns 401', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/goals/any' });
    expect(res.statusCode).toBe(401);
  });

  // POST /v1/goals/:id/workspaces
  it('POST /v1/goals/:id/workspaces returns 201 with workspace for non-git folder', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { title: 'ws-goal' }
      })).body
    ));

    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${created.goal.id}/workspaces`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir }
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { workspace: { path: string; workspaceType: string; gitProbe: string } };
    expect(body.workspace.path).toBe(wsDir);
    expect(body.workspace.workspaceType).toBe('folder');
    expect(body.workspace.gitProbe).toBe('not_a_repo');
  });

  it('POST /v1/goals/:id/workspaces returns 409 on duplicate canonical path', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { title: 'ws-goal' }
      })).body
    ));

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${created.goal.id}/workspaces`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir }
    });

    const dup = await server.inject({
      method: 'POST',
      url: `/v1/goals/${created.goal.id}/workspaces`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir }
    });
    expect(dup.statusCode).toBe(409);
    const body = JSON.parse(dup.body) as { error: { code: string } };
    expect(body.error.code).toBe('workspace_duplicate');
  });

  it('POST /v1/goals/:id/workspaces without Authorization returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals/any/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: { inputPath: wsDir }
    });
    expect(res.statusCode).toBe(401);
  });

  // DELETE /v1/goals/:id/workspaces/:workspaceId
  it('DELETE /v1/goals/:id/workspaces/:workspaceId happy path returns 204', async () => {
    const created = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({
        method: 'POST', url: '/v1/goals',
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { title: 'ws-goal' }
      })).body
    ));
    const attached = JSON.parse(
      (await server.inject({
        method: 'POST',
        url: `/v1/goals/${created.goal.id}/workspaces`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { inputPath: wsDir }
      })).body
    ) as { workspace: { id: string } };

    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/goals/${created.goal.id}/workspaces/${attached.workspace.id}`,
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE /v1/goals/:id/workspaces/:workspaceId returns 404 for mismatched goal/workspace ids', async () => {
    const goal1 = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({ method: 'POST', url: '/v1/goals', headers: { 'content-type': 'application/json', ...AUTH_HEADERS }, payload: { title: 'g1' } })).body
    ));
    const goal2 = CreateGoalResponse.parse(JSON.parse(
      (await server.inject({ method: 'POST', url: '/v1/goals', headers: { 'content-type': 'application/json', ...AUTH_HEADERS }, payload: { title: 'g2' } })).body
    ));
    const attached = JSON.parse(
      (await server.inject({
        method: 'POST',
        url: `/v1/goals/${goal1.goal.id}/workspaces`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { inputPath: wsDir }
      })).body
    ) as { workspace: { id: string } };

    const res = await server.inject({
      method: 'DELETE',
      url: `/v1/goals/${goal2.goal.id}/workspaces/${attached.workspace.id}`,
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /v1/goals/:id/workspaces/:workspaceId without Authorization returns 401', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/v1/goals/any/workspaces/any' });
    expect(res.statusCode).toBe(401);
  });

  // POST /v1/workspaces/inspect
  it('POST /v1/workspaces/inspect returns 200 with preview for existing non-git folder', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/inspect',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { preview: { workspaceType: string; gitProbe: string; path: string } };
    expect(body.preview.workspaceType).toBe('folder');
    expect(body.preview.gitProbe).toBe('not_a_repo');
    expect(body.preview.path).toBe(wsDir);
  });

  it('POST /v1/workspaces/inspect returns 400 with invalid_input for relative path', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/inspect',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: 'relative/path/here' }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('POST /v1/workspaces/inspect returns 400 with not_found for nonexistent path', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/inspect',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: '/does/not/exist/at/all/m3test' }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('POST /v1/workspaces/inspect returns 400 with not_a_directory for file path', async () => {
    const filePath = path.join(wsDir, 'testfile.txt');
    writeFileSync(filePath, 'hello');
    const res = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/inspect',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: filePath }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_a_directory');
  });

  it('POST /v1/workspaces/inspect without Authorization returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/workspaces/inspect',
      headers: { 'content-type': 'application/json' },
      payload: { inputPath: wsDir }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('M4-006 session and adapter routes', () => {
  let server: FastifyInstance;
  let goalId: string;
  let workspaceId: string;
  let wsDir: string;
  const m4Dirs: string[] = [];

  beforeEach(async () => {
    const dbDir = mkdtempSync(path.join(os.tmpdir(), 'orca-m4-srv-'));
    m4Dirs.push(dbDir);
    wsDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-m4-ws-')));
    m4Dirs.push(wsDir);

    const config = createConfig(dbDir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);

    // Create a goal with an attached workspace to use in session tests
    const goalRes = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'm4-goal' }
    });
    goalId = (CreateGoalResponse.parse(JSON.parse(goalRes.body))).goal.id;

    const wsRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/workspaces`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir }
    });
    const wsBody = JSON.parse(wsRes.body) as { workspace: { id: string } };
    workspaceId = wsBody.workspace.id;
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of m4Dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // GET /v1/adapters
  it('GET /v1/adapters returns all four adapters', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/adapters',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = ListAdaptersResponse.parse(JSON.parse(res.body));
    expect(body.adapters.map((a) => a.id).sort()).toEqual(
      ['claude-code', 'codex', 'opencode', 'shell-manual']
    );
  });

  it('GET /v1/adapters without Authorization returns 401', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/adapters' });
    expect(res.statusCode).toBe(401);
  });

  // POST /v1/goals/:goalId/sessions
  it('POST /v1/goals/:goalId/sessions happy path returns 201 with SessionDetail', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual', role: 'Engineer', title: 'My Session' }
    });
    expect(res.statusCode).toBe(201);
    const body = CreateSessionResponse.parse(JSON.parse(res.body));
    expect(body.session.goalId).toBe(goalId);
    expect(body.session.workspaceId).toBe(workspaceId);
    expect(body.session.adapterId).toBe('shell-manual');
    expect(body.session.role).toBe('Engineer');
    expect(body.session.title).toBe('My Session');
    expect(body.session.status).toBe('created');
  });

  it('POST /v1/goals/:goalId/sessions uses adapterId as title fallback', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });
    expect(res.statusCode).toBe(201);
    const body = CreateSessionResponse.parse(JSON.parse(res.body));
    expect(body.session.title).toBe('shell-manual session');
  });

  it('POST /v1/goals/:goalId/sessions returns 400 for invalid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { adapterId: 'shell-manual' } // missing workspaceId
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('POST /v1/goals/:goalId/sessions rejects unknown fields (strict schema)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual', extraField: 'sneaked' }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('POST /v1/goals/:goalId/sessions returns 404 for missing goal', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals/no-such-goal/sessions',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('goal_not_found');
  });

  it('POST /v1/goals/:goalId/sessions returns 409 for archived goal', async () => {
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/archive`,
      headers: AUTH_HEADERS
    });

    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('goal_archived');
  });

  it('POST /v1/goals/:goalId/sessions returns 422 for workspace not attached to goal', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId: 'not-attached-ws', adapterId: 'shell-manual' }
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('workspace_not_found');
  });

  it('POST /v1/goals/:goalId/sessions without Authorization returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json' },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });
    expect(res.statusCode).toBe(401);
  });

  // GET /v1/goals/:goalId/sessions
  it('GET /v1/goals/:goalId/sessions returns created sessions', async () => {
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });

    const res = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/sessions`,
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = ListSessionsResponse.parse(JSON.parse(res.body));
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.adapterId).toBe('shell-manual');
  });

  it('GET /v1/goals/:goalId/sessions returns empty list for unknown goal', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/goals/no-such-goal/sessions',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = ListSessionsResponse.parse(JSON.parse(res.body));
    expect(body.sessions).toEqual([]);
  });

  it('GET /v1/goals/:goalId/sessions without Authorization returns 401', async () => {
    const res = await server.inject({ method: 'GET', url: `/v1/goals/${goalId}/sessions` });
    expect(res.statusCode).toBe(401);
  });

  // GET /v1/sessions/:id
  it('GET /v1/sessions/:id returns session detail with empty output snapshot', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'shell-manual' }
    });
    const sessionId = (CreateSessionResponse.parse(JSON.parse(createRes.body))).session.id;

    const res = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(200);
    const body = GetSessionResponse.parse(JSON.parse(res.body));
    expect(body.session.id).toBe(sessionId);
    expect(body.session.status).toBe('created');
    expect(body.output.sessionId).toBe(sessionId);
    expect(body.output.chunks).toEqual([]);
    expect(body.output.nextSeq).toBe(0);
  });

  it('GET /v1/sessions/:id returns 404 for missing session', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/sessions/no-such-session',
      headers: AUTH_HEADERS
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_found');
  });

  it('GET /v1/sessions/:id without Authorization returns 401', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/sessions/any' });
    expect(res.statusCode).toBe(401);
  });

  // ---- M5 Memory routes ----

  async function createGoalForTest(): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Test Goal' },
    });
    return (CreateGoalResponse.parse(JSON.parse(res.body))).goal.id;
  }

  it('GET /v1/goals/:goalId/memory returns empty list for new goal', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/memory`,
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = ListGoalMemoryResponse.parse(JSON.parse(res.body));
    expect(body.items).toHaveLength(0);
  });

  it('POST /v1/goals/:goalId/memory creates item → 201 → list reflects it', async () => {
    const goalId = await createGoalForTest();

    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Remember this' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { item: GoalMemoryItem };
    expect(created.item.status).toBe('candidate');
    expect(created.item.type).toBe('note');
    expect(created.item.content).toBe('Remember this');

    const listRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/memory`,
      headers: AUTH_HEADERS,
    });
    const list = ListGoalMemoryResponse.parse(JSON.parse(listRes.body));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.id).toBe(created.item.id);
  });

  it('PATCH /v1/memory/:id promotes candidate → promoted, list reflects change', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Promote me' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalMemoryItem };

    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/v1/memory/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'promoted' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body) as { item: GoalMemoryItem };
    expect(patched.item.status).toBe('promoted');

    const listRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/memory`,
      headers: AUTH_HEADERS,
    });
    const list = ListGoalMemoryResponse.parse(JSON.parse(listRes.body));
    expect(list.items[0]!.status).toBe('promoted');
  });

  it('PATCH /v1/memory/:id archives item, default list excludes it', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Archive me' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalMemoryItem };

    await server.inject({
      method: 'PATCH',
      url: `/v1/memory/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'archived' },
    });

    const defaultList = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/memory`,
      headers: AUTH_HEADERS,
    });
    expect(ListGoalMemoryResponse.parse(JSON.parse(defaultList.body)).items).toHaveLength(0);

    const includedList = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/memory?includeArchived=1`,
      headers: AUTH_HEADERS,
    });
    expect(ListGoalMemoryResponse.parse(JSON.parse(includedList.body)).items).toHaveLength(1);
  });

  it('PATCH /v1/memory/:id returns 409 for invalid transition (archived → promoted)', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Will be archived' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalMemoryItem };

    await server.inject({
      method: 'PATCH',
      url: `/v1/memory/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'archived' },
    });

    const res = await server.inject({
      method: 'PATCH',
      url: `/v1/memory/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'promoted' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_status_transition');
  });

  it('POST /v1/goals/:goalId/memory returns 409 for duplicate (goal_id, type, content_hash)', async () => {
    const goalId = await createGoalForTest();
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Duplicate content' },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Duplicate content' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('memory_duplicate');
  });

  it('POST /v1/goals/:goalId/memory rejects unknown fields with 400', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Test', unknownField: 'value' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/goals/:goalId/memory rejects oversized content with 400', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'x'.repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('memory events appear on the bus after POST /v1/goals/:goalId/memory', async () => {
    const goalId = await createGoalForTest();
    const capturedEvents: DomainEvent[] = [];
    const unsub = eventBus.subscribe((e) => capturedEvents.push(e));

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/memory`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { type: 'note', content: 'Observed event' },
    });

    unsub();
    const memoryEvents = capturedEvents.filter((e) => e.type === 'memory.item.created');
    expect(memoryEvents).toHaveLength(1);
    expect(memoryEvents[0]!.goalId).toBe(goalId);
  });

  // ---- M5 Decision routes ----

  it('GET /v1/goals/:goalId/decisions returns empty list for new goal', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/decisions`,
      headers: AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = ListGoalDecisionsResponse.parse(JSON.parse(res.body));
    expect(body.items).toHaveLength(0);
  });

  it('POST /v1/goals/:goalId/decisions creates decision → 201 → list reflects it', async () => {
    const goalId = await createGoalForTest();

    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'Use SQLite',
        decisionText: 'SQLite is the only storage boundary.',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { item: GoalDecision };
    expect(created.item.status).toBe('proposed');
    expect(created.item.title).toBe('Use SQLite');

    const listRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/decisions`,
      headers: AUTH_HEADERS,
    });
    const list = ListGoalDecisionsResponse.parse(JSON.parse(listRes.body));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.id).toBe(created.item.id);
  });

  it('PATCH /v1/decisions/:id confirms proposed → confirmed', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Use SQLite', decisionText: 'SQLite storage.' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalDecision };

    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/v1/decisions/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'confirmed' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body) as { item: GoalDecision };
    expect(patched.item.status).toBe('confirmed');
    expect(patched.item.confirmedAt).toBeTruthy();
  });

  it('PATCH /v1/decisions/:id archives proposed → archived', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Dropped', decisionText: 'No longer relevant.' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalDecision };

    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/v1/decisions/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'archived' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body) as { item: GoalDecision };
    expect(patched.item.status).toBe('archived');
  });

  it('PATCH /v1/decisions/:id returns 409 for invalid transition (archived → confirmed)', async () => {
    const goalId = await createGoalForTest();
    const createRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Decision', decisionText: 'Some decision.' },
    });
    const { item } = JSON.parse(createRes.body) as { item: GoalDecision };

    await server.inject({
      method: 'PATCH',
      url: `/v1/decisions/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'archived' },
    });

    const res = await server.inject({
      method: 'PATCH',
      url: `/v1/decisions/${item.id}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { status: 'confirmed' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_status_transition');
  });

  it('POST /v1/goals/:goalId/decisions rejects unknown fields with 400', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'Test',
        decisionText: 'Test decision.',
        unknownField: 'value',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/goals/:goalId/decisions rejects oversized title with 400', async () => {
    const goalId = await createGoalForTest();
    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'x'.repeat(201), decisionText: 'Valid text.' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('decision events appear on the bus after POST /v1/goals/:goalId/decisions', async () => {
    const goalId = await createGoalForTest();
    const capturedEvents: DomainEvent[] = [];
    const unsub = eventBus.subscribe((e) => capturedEvents.push(e));

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/decisions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Test decision', decisionText: 'Some decision text.' },
    });

    unsub();
    const decisionEvents = capturedEvents.filter((e) => e.type === 'decision.created');
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]!.goalId).toBe(goalId);
  });
});
