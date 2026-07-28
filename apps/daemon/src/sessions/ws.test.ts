import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CreateGoalResponse, CreateSessionResponse } from '@orca/contracts';
import type { Config } from '../config.js';
import { createServer } from '../server.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { bootstrapRegistries } from '../registry/bootstrap.js';
import { FakePtyManager, controlFakePty } from '../pty/fake.js';
import { SessionRuntime, type WsClient } from './runtime.js';
import { resetPreparedStatements as resetRuntimeStmts } from './runtime.js';

beforeAll(() => {
  bootstrapRegistries();
});

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

/** Wait one event loop tick so in-process WS messages are processed. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Collect WS messages matching a predicate, resolving after first match. */
function firstMatch(
  ws: { on: (ev: string, fn: (d: Buffer) => void) => void; off: (ev: string, fn: (d: Buffer) => void) => void },
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 500
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`firstMatch: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(data: Buffer): void {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    }
    ws.on('message', handler);
  });
}

describe('session WS frames', () => {
  let server: FastifyInstance;
  let fakePty: FakePtyManager;
  let runtime: SessionRuntime;
  let goalId: string;
  let workspaceId: string;
  let sessionId: string;
  let wsDir: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    const dbDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ws-sess-'));
    dirs.push(dbDir);
    wsDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-ws-ws-')));
    dirs.push(wsDir);

    fakePty = new FakePtyManager();
    // Small stop grace so tests are fast; large buffer limit (slow-consumer test overrides via mock socket)
    runtime = new SessionRuntime(fakePty, 100, 1024 * 1024);
    resetRuntimeStmts();

    const config = createConfig(dbDir);
    const db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config, { sessionRuntime: runtime });
    await server.ready();

    // Create a goal + workspace
    const goalRes = await server.inject({
      method: 'POST', url: '/v1/goals',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'ws-test-goal', intent: 'test intent', successCriteria: ['ship it'] },
    });
    goalId = CreateGoalResponse.parse(JSON.parse(goalRes.body)).goal.id;

    const wsRes = await server.inject({
      method: 'POST', url: `/v1/goals/${goalId}/workspaces`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { inputPath: wsDir },
    });
    workspaceId = (JSON.parse(wsRes.body) as { workspace: { id: string } }).workspace.id;

    // Create a session (status: created)
    const sessRes = await server.inject({
      method: 'POST', url: `/v1/goals/${goalId}/sessions`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workspaceId, adapterId: 'claude-code' },
    });
    sessionId = CreateSessionResponse.parse(JSON.parse(sessRes.body)).session.id;

    // Start the session so PTY is live
    await server.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/start`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { terminalCols: 80, terminalRows: 24 },
    });
  });

  afterEach(async () => {
    // Kill any live PTY handle so the fake doesn't block cleanup
    const handle = runtime.getHandle(sessionId);
    if (handle) {
      const ctrl = controlFakePty(handle);
      if (!ctrl.isDead) ctrl.emitExit({ exitCode: 0, signal: null });
    }
    await server.close();
    closeDatabase();
    resetRuntimeStmts();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subscribe → PTY emits data → subscriber receives session.output with correct seq/byteOffset', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();

    const outputPromise = firstMatch(ws, (m) => m.type === 'session.output');

    const handle = runtime.getHandle(sessionId)!;
    const ctrl = controlFakePty(handle);
    ctrl.emitData(Buffer.from('hello world'));

    const frame = await outputPromise;
    expect(frame.sessionId).toBe(sessionId);
    expect(frame.seq).toBe(0);
    expect(frame.byteOffset).toBe(0);
    expect(Buffer.from(frame.dataBase64 as string, 'base64').toString()).toBe('hello world');

    ws.terminate();
  });

  it('unsubscribe → no further session.output frames after unsubscribe', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();

    // Unsubscribe
    ws.send(JSON.stringify({ type: 'session.unsubscribe', sessionId }));
    await tick();

    const received: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'session.output') received.push(msg);
    });

    const handle = runtime.getHandle(sessionId)!;
    controlFakePty(handle).emitData(Buffer.from('after-unsub'));
    await tick();

    expect(received).toHaveLength(0);
    ws.terminate();
  });

  it('session.input reaches fake PTY (recorded in writtenChunks)', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const handle = runtime.getHandle(sessionId)!;
    const ctrl = controlFakePty(handle);

    const inputData = Buffer.from('ls\n');
    ws.send(JSON.stringify({
      type: 'session.input',
      sessionId,
      dataBase64: inputData.toString('base64'),
    }));
    await tick();

    expect(ctrl.writtenChunks).toHaveLength(1);
    expect(ctrl.writtenChunks[0]).toEqual(inputData);

    ws.terminate();
  });

  it('session.resize updates terminal_cols/terminal_rows in DB without inserting an event', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    ws.send(JSON.stringify({ type: 'session.resize', sessionId, cols: 120, rows: 40 }));
    await tick();

    // Check DB via GET /v1/sessions/:id
    const res = await server.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}`, headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body) as { session: { terminalCols: number; terminalRows: number } };
    expect(body.session.terminalCols).toBe(120);
    expect(body.session.terminalRows).toBe(40);

    // No session.resized domain event
    const eventCountRes = await server.inject({
      method: 'GET', url: '/v1/events?sinceSeq=0', headers: AUTH_HEADERS,
    });
    const eventBody = JSON.parse(eventCountRes.body) as { events: { type: string }[] };
    const resizedEvents = eventBody.events.filter((e) => e.type === 'session.resized');
    expect(resizedEvents).toHaveLength(0);

    ws.terminate();
  });

  it('session.input against exited session → session.error { code: "not_active" }', async () => {
    // Exit the session first
    const handle = runtime.getHandle(sessionId)!;
    controlFakePty(handle).emitExit({ exitCode: 0, signal: null });
    await tick();

    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({
      type: 'session.input',
      sessionId,
      dataBase64: Buffer.from('cmd').toString('base64'),
    }));

    const frame = await errorPromise;
    expect(frame.code).toBe('not_active');
    expect(frame.sessionId).toBe(sessionId);

    ws.terminate();
  });

  it('session.subscribe with unknown sessionId → session.error { code: "unknown_session" }', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId: 'no-such-session' }));

    const frame = await errorPromise;
    expect(frame.code).toBe('unknown_session');
    expect(frame.sessionId).toBe('no-such-session');

    ws.terminate();
  });

  it('malformed frame → session.error { code: "invalid_message" }; connection stays open', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    // Send invalid JSON
    ws.send('not valid json {{');

    const frame = await errorPromise;
    expect(frame.code).toBe('invalid_message');

    // Verify connection stays open by successfully sending another frame
    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();
    // No error — just confirm it didn't crash
    expect(ws.readyState).toBe(1); // OPEN

    ws.terminate();
  });

  it('malformed session.subscribe frame → session.error { code: "invalid_message" }', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    // Missing required sessionId
    ws.send(JSON.stringify({ type: 'session.subscribe', extra: 'field' }));

    const frame = await errorPromise;
    expect(frame.code).toBe('invalid_message');

    ws.terminate();
  });

  it('slow-consumer mock socket is closed after bufferedAmount exceeds limit; real subscriber unaffected', async () => {
    // Create a mock socket that reports high bufferedAmount after first send.
    // The runtime's wsBufferLimitBytes is 1 MiB, so return 2 MiB after first send.
    let sentCount = 0;
    const closeCalls: Array<{ code?: number; reason?: string }> = [];
    const mockSocket: WsClient = {
      readyState: 1,
      get bufferedAmount() {
        return sentCount > 0 ? 2 * 1024 * 1024 : 0;
      },
      send(_data: string) { sentCount++; },
      close(code?: number, reason?: string) { closeCalls.push({ code, reason }); },
    };
    runtime.subscribe(sessionId, mockSocket);

    // Also have a real WS subscriber
    const ws = await server.injectWS('/v1/events?token=test-token');
    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();

    const outputFrames: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'session.output') outputFrames.push(msg);
    });

    // Emit data via fake PTY — runtime.broadcastOutput fires
    const handle = runtime.getHandle(sessionId)!;
    controlFakePty(handle).emitData(Buffer.from('test-chunk'));
    await tick();

    // The mock socket should have been closed (bufferedAmount > wsBufferLimitBytes after send)
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(closeCalls[0]!.code).toBe(1008);

    // The real WS subscriber should still have received the output
    expect(outputFrames).toHaveLength(1);
    expect((outputFrames[0] as { sessionId: string }).sessionId).toBe(sessionId);

    ws.terminate();
  });

  it('session.input against unknown sessionId → session.error { code: "unknown_session" }', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({
      type: 'session.input',
      sessionId: 'no-such-session',
      dataBase64: Buffer.from('cmd').toString('base64'),
    }));

    const frame = await errorPromise;
    expect(frame.code).toBe('unknown_session');
    expect(frame.sessionId).toBe('no-such-session');

    ws.terminate();
  });

  it('session.input with invalid base64 → session.error { code: "invalid_message" }', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({
      type: 'session.input',
      sessionId,
      dataBase64: 'not-valid-base64!!!',
    }));

    const frame = await errorPromise;
    expect(frame.code).toBe('invalid_message');

    ws.terminate();
  });

  it('session.resize against unknown sessionId → session.error { code: "unknown_session" }', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({ type: 'session.resize', sessionId: 'no-such-session', cols: 80, rows: 24 }));

    const frame = await errorPromise;
    expect(frame.code).toBe('unknown_session');
    expect(frame.sessionId).toBe('no-such-session');

    ws.terminate();
  });

  it('session.resize against exited session → session.error { code: "not_active" }', async () => {
    const handle = runtime.getHandle(sessionId)!;
    controlFakePty(handle).emitExit({ exitCode: 0, signal: null });
    await tick();

    const ws = await server.injectWS('/v1/events?token=test-token');

    const errorPromise = firstMatch(ws, (m) => m.type === 'session.error');

    ws.send(JSON.stringify({ type: 'session.resize', sessionId, cols: 120, rows: 40 }));

    const frame = await errorPromise;
    expect(frame.code).toBe('not_active');
    expect(frame.sessionId).toBe(sessionId);

    ws.terminate();
  });

  it('WS close removes socket from all subscriber lists', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');

    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();

    // Close the WS client
    ws.terminate();
    await tick();

    // After close, the socket should no longer be in the subscriber list.
    // Emit data — if socket were still subscribed, its send would throw (socket closed).
    // If not subscribed, broadcastOutput simply skips it.
    const handle = runtime.getHandle(sessionId);
    if (handle) {
      // Should not throw
      expect(() => controlFakePty(handle).emitData(Buffer.from('post-close'))).not.toThrow();
    }
  });

  it('seq and byteOffset on WS frame match values from output store', async () => {
    const ws = await server.injectWS('/v1/events?token=test-token');
    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    await tick();

    const frames: { seq: number; byteOffset: number; dataBase64: string }[] = [];
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { type: string; seq?: number; byteOffset?: number; dataBase64?: string };
      if (msg.type === 'session.output') {
        frames.push({ seq: msg.seq!, byteOffset: msg.byteOffset!, dataBase64: msg.dataBase64! });
      }
    });

    const handle = runtime.getHandle(sessionId)!;
    controlFakePty(handle).emitData(Buffer.from('chunk-one'));
    controlFakePty(handle).emitData(Buffer.from('chunk-two'));
    await tick();

    expect(frames).toHaveLength(2);
    expect(frames[0]!.seq).toBe(0);
    expect(frames[0]!.byteOffset).toBe(0);
    expect(frames[1]!.seq).toBe(1);
    expect(frames[1]!.byteOffset).toBe(9); // 'chunk-one'.length

    // Also verify output tail via HTTP matches WS frames
    const res = await server.inject({ method: 'GET', url: `/v1/sessions/${sessionId}`, headers: AUTH_HEADERS });
    const body = JSON.parse(res.body) as { output: { chunks: { seq: number; byteOffset: number }[] } };
    expect(body.output.chunks[0]!.seq).toBe(frames[0]!.seq);
    expect(body.output.chunks[0]!.byteOffset).toBe(frames[0]!.byteOffset);
    expect(body.output.chunks[1]!.seq).toBe(frames[1]!.seq);
    expect(body.output.chunks[1]!.byteOffset).toBe(frames[1]!.byteOffset);

    ws.terminate();
  });
});
