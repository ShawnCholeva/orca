import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CreateGoalResponse,
  CreateSessionResponse,
  type DomainEvent,
  ExtractSessionMemoryResponse,
  GoalDetailResponse,
  ListGoalDecisionsResponse,
  ListGoalMemoryResponse,
  type RefineGoalResponse,
  type SessionExtractionOutput,
} from '@orca/contracts';
import { loadConfig } from '../src/config.js';
import { closeDatabase, getDatabase, openDatabase } from '../src/db.js';
import { eventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';
import { reconcileSessionsOnBoot } from '../src/sessions/reconciliation.js';
import { reconcileStaleExtractions } from '../src/extractions/reconciliation.js';
import { createSessionOutputStore, type SessionOutputStore } from '../src/sessions/output-store.js';
import { setSessionStatus } from '../src/sessions/projection.js';
import { ExtractionRunner } from '../src/extractions/runner.js';
import { FakeExtractor } from '../src/extractions/fake-extractor.js';
import { createServer } from '../src/server.js';

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
const TOKEN = 'm5-sm-token';
const AUTH = { authorization: `Bearer ${TOKEN}` } as const;
const tempDirs: string[] = [];

afterAll(() => {
  closeDatabase();
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface BootResult {
  server: FastifyInstance;
  baseUrl: string;
  outputStore: SessionOutputStore;
  runner: ExtractionRunner;
  extractor: FakeExtractor;
}

function resetEnv(dataDir: string): void {
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  process.env.ORCA_DATA_DIR = dataDir;
  process.env.ORCA_LOG_LEVEL = 'silent';
  process.env.ORCA_TOKEN = TOKEN;
  process.env.ORCA_SHELL = '/bin/sh';
}

async function boot(dataDir: string, extractor?: FakeExtractor): Promise<BootResult> {
  resetEnv(dataDir);
  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());

  const bootNow = new Date().toISOString();
  reconcileSessionsOnBoot(db, eventBus, bootNow);
  reconcileStaleExtractions(db, eventBus, bootNow);

  const outputStore = createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes });
  const fakeExtractor = extractor ?? new FakeExtractor();

  const runner = new ExtractionRunner({
    db,
    bus: eventBus,
    outputStore,
    extractor: fakeExtractor,
    config: {
      memoryExtractionMaxInputBytes: config.memoryExtractionMaxInputBytes,
      memoryExtractionTimeoutMs: 5000,
    },
  });
  runner.start();

  const server = createServer(config, { sessionOutputStore: outputStore, extractionRunner: runner });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const addr = server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('No server address');
  const baseUrl = `http://127.0.0.1:${(addr as AddressInfo).port}`;

  return { server, baseUrl, outputStore, runner, extractor: fakeExtractor };
}

async function stop(server: FastifyInstance, runner: ExtractionRunner): Promise<void> {
  runner.stop();
  await server.close();
  closeDatabase();
}

function waitForBusEvent(
  predicate: (e: DomainEvent) => boolean,
  timeoutMs: number,
): Promise<DomainEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`waitForBusEvent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = eventBus.subscribe((e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        unsub();
        resolve(e);
      }
    });
  });
}

async function postJson(baseUrl: string, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
}

async function getJson(baseUrl: string, urlPath: string): Promise<Response> {
  return fetch(`${baseUrl}${urlPath}`, { headers: AUTH });
}

const FIXTURE_OUTPUT: SessionExtractionOutput = {
  summary: {
    headline: 'shell-manual session completed',
    text: 'Session ran integration tests and all steps completed successfully.',
    truncated: false,
  },
  memoryCandidates: [
    {
      type: 'blocker',
      content: 'Output store must be cleared between test restarts to avoid state bleed',
      confidence: 0.75,
      promoteEligible: false,
    },
  ],
  decisionCandidates: [
    {
      title: 'Use file-backed SQLite',
      decisionText: 'DECISION: Use file-backed SQLite for integration tests to enable restart assertions',
      confirmationRequired: true,
      confidence: 0.6,
    },
  ],
};

describe.sequential('M5-012 daemon proof-loop integration', () => {
  it('full M5 loop: seed → extraction → decisions → summary → restart → privacy', async () => {
    const rootDir = mktemp('orca-m5-012-');
    const workspaceDir = path.join(rootDir, 'workspace');
    const dbDir = path.join(rootDir, 'daemon-db');
    mkdirSync(workspaceDir);
    mkdirSync(dbDir);

    // Collect all events for the end-of-test privacy check.
    const allEvents: DomainEvent[] = [];
    const unsubCollect = eventBus.subscribe((e) => allEvents.push(e));

    let b1: BootResult | undefined;
    let b2: BootResult | undefined;

    try {
      // ── Boot 1 ────────────────────────────────────────────────────────────────
      b1 = await boot(dbDir);
      const { baseUrl, outputStore, extractor } = b1;

      // ── Create a refined Goal (triggers seed memory) ──────────────────────────
      const refineResp = await postJson(baseUrl, '/v1/goals/refine', {
        title: 'M5-012 Integration Goal',
        description: [
          'Validate the full M5 shared memory daemon loop.',
          '',
          'Constraints:',
          '- Must use file-backed SQLite for restart testing',
          '- No real PTY needed for M5 extraction',
          '',
          'Success criteria:',
          '- All memory rows survive daemon restart',
          '- All decisions are visible after extraction',
        ].join('\n'),
      });
      expect(refineResp.status).toBe(200);
      const { draft } = (await refineResp.json()) as RefineGoalResponse;
      expect(draft.constraints.length).toBeGreaterThan(0);
      expect(draft.successCriteria.length).toBeGreaterThan(0);

      const createGoalResp = await postJson(baseUrl, '/v1/goals', {
        title: draft.title,
        description: draft.description,
        refined: draft,
        workspaces: [{ inputPath: workspaceDir }],
      });
      expect(createGoalResp.status).toBe(201);
      const { goal } = CreateGoalResponse.parse(await createGoalResp.json());
      const goalId = goal.id;

      // Seed memory is created atomically with the goal refinement.
      const seedResp = await getJson(baseUrl, `/v1/goals/${goalId}/memory`);
      expect(seedResp.status).toBe(200);
      const { items: seedItems } = ListGoalMemoryResponse.parse(await seedResp.json());
      const refinementItems = seedItems.filter((m) => m.sourceType === 'refinement');
      expect(refinementItems.length).toBeGreaterThanOrEqual(2); // ≥1 constraint + ≥1 criterion
      expect(refinementItems.every((m) => m.status === 'promoted')).toBe(true);

      // ── Get workspace id ──────────────────────────────────────────────────────
      const goalDetailResp = await getJson(baseUrl, `/v1/goals/${goalId}`);
      expect(goalDetailResp.status).toBe(200);
      const { workspaces } = GoalDetailResponse.parse(await goalDetailResp.json());
      const workspaceId = workspaces[0]!.id;

      // ── Create session via API then set to exited (no real PTY) ───────────────
      const createSessionResp = await postJson(baseUrl, `/v1/goals/${goalId}/sessions`, {
        workspaceId,
        adapterId: 'shell-manual',
        title: 'M5 Integration Test Session',
      });
      expect(createSessionResp.status).toBe(201);
      const { session } = CreateSessionResponse.parse(await createSessionResp.json());
      const sessionId = session.id;

      // Write a fixture output tail directly into the M4 output store.
      const sessionOutput = Buffer.from(
        'DECISION: Use file-backed SQLite for integration tests to enable restart assertions\n' +
        'All integration tests passed\n'
      );
      outputStore.appendChunk(sessionId, sessionOutput);

      // Set session to terminal state in DB — no PTY spawn needed for extraction.
      const db1 = getDatabase();
      setSessionStatus(db1, sessionId, 'exited', {
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      });

      // Configure the fake extractor to return the fixture output.
      extractor.setOutput(sessionId, FIXTURE_OUTPUT);

      // ── Open Goal → triggers seed backfill (no-op) and enqueue ───────────────
      // Subscribe to bus BEFORE opening the goal so we don't miss the completed event.
      const completedPromise = waitForBusEvent(
        (e) => e.type === 'memory.extraction.completed' && e.goalId === goalId,
        5000
      );

      const openGoalResp = await getJson(baseUrl, `/v1/goals/${goalId}`);
      expect(openGoalResp.status).toBe(200);

      const completedEvent = await completedPromise;
      expect(completedEvent.type).toBe('memory.extraction.completed');

      // ── Assert memory: seed rows + extracted blocker ─────────────────────────
      const memResp = await getJson(baseUrl, `/v1/goals/${goalId}/memory`);
      expect(memResp.status).toBe(200);
      const { items: memItems } = ListGoalMemoryResponse.parse(await memResp.json());

      const extractedItems = memItems.filter((m) => m.sourceType === 'session');
      expect(extractedItems.length).toBe(1);
      expect(extractedItems[0]!.type).toBe('blocker');
      expect(extractedItems[0]!.status).toBe('candidate');

      const allRefinementItems = memItems.filter((m) => m.sourceType === 'refinement');
      expect(allRefinementItems.length).toBeGreaterThanOrEqual(2);

      const memCountAfterFirstExtraction = memItems.length;

      // ── Assert decisions ──────────────────────────────────────────────────────
      const decResp = await getJson(baseUrl, `/v1/goals/${goalId}/decisions`);
      expect(decResp.status).toBe(200);
      const { items: decisions } = ListGoalDecisionsResponse.parse(await decResp.json());
      expect(decisions.length).toBe(1);
      expect(decisions[0]!.status).toBe('proposed');
      expect(decisions[0]!.confirmationRequired).toBe(true);
      expect(decisions[0]!.title).toBe('Use file-backed SQLite');

      // ── Assert session summary ────────────────────────────────────────────────
      const summaryResp = await getJson(baseUrl, `/v1/sessions/${sessionId}/summary`);
      expect(summaryResp.status).toBe(200);
      const summaryBody = (await summaryResp.json()) as { summary: { headline: string; truncated: boolean } };
      expect(summaryBody.summary.headline).toBe('shell-manual session completed');
      expect(summaryBody.summary.truncated).toBe(false);

      // ── Duplicate extraction: same fingerprint → 200, no new rows ─────────────
      const dupResp = await postJson(baseUrl, `/v1/sessions/${sessionId}/extract-memory`, {});
      expect(dupResp.status).toBe(200);
      const dupBody = ExtractSessionMemoryResponse.parse(await dupResp.json());
      expect(dupBody.extraction.status).toBe('succeeded');

      const memAfterDupResp = await getJson(baseUrl, `/v1/goals/${goalId}/memory`);
      const { items: memAfterDup } = ListGoalMemoryResponse.parse(await memAfterDupResp.json());
      expect(memAfterDup.length).toBe(memCountAfterFirstExtraction);

      // ── Failed extraction: append bytes to change fingerprint, extractor throws ──
      extractor.setError(sessionId, 'simulated extractor failure for M5-012 test');
      // Writing extra bytes changes the source byte window → new fingerprint.
      outputStore.appendChunk(sessionId, Buffer.from(' [extra bytes for new fingerprint]\n'));

      const failedPromise = waitForBusEvent(
        (e) =>
          e.type === 'memory.extraction.failed' &&
          (e.payload as { sessionId?: string }).sessionId === sessionId,
        5000
      );

      const failResp = await postJson(baseUrl, `/v1/sessions/${sessionId}/extract-memory`, {});
      expect(failResp.status).toBe(201);

      await failedPromise;

      // Failed extraction must not add or remove memory rows.
      const memAfterFailResp = await getJson(baseUrl, `/v1/goals/${goalId}/memory`);
      const { items: memAfterFail } = ListGoalMemoryResponse.parse(await memAfterFailResp.json());
      expect(memAfterFail.length).toBe(memCountAfterFirstExtraction);

      // ── Retry after failure: same fingerprint now 'failed' → creates new pending ──
      extractor.setOutput(sessionId, FIXTURE_OUTPUT);

      const retryCompletedPromise = waitForBusEvent(
        (e) => e.type === 'memory.extraction.completed' && e.goalId === goalId,
        5000
      );

      const retryResp = await postJson(baseUrl, `/v1/sessions/${sessionId}/extract-memory`, {});
      expect(retryResp.status).toBe(201);

      await retryCompletedPromise;

      // The blocker candidate has the same content_hash → dedupe → no new memory rows.
      const memAfterRetryResp = await getJson(baseUrl, `/v1/goals/${goalId}/memory`);
      const { items: memAfterRetry } = ListGoalMemoryResponse.parse(await memAfterRetryResp.json());
      expect(memAfterRetry.length).toBe(memCountAfterFirstExtraction);
      // Original session-sourced row is still present.
      expect(memAfterRetry.filter((m) => m.sourceType === 'session').length).toBe(1);

      // ── Shutdown ──────────────────────────────────────────────────────────────
      await stop(b1.server, b1.runner);
      b1 = undefined;

      // ── Boot 2 (restart) ─────────────────────────────────────────────────────
      b2 = await boot(dbDir);

      // Reconciliation must have cleared any stale pending/running extractions.
      const db2 = getDatabase();
      const staleRows = db2
        .prepare("SELECT id FROM memory_extractions WHERE status IN ('pending', 'running')")
        .all() as { id: string }[];
      expect(staleRows).toHaveLength(0);

      // All committed rows survive restart.
      const memAfterRestartResp = await getJson(b2.baseUrl, `/v1/goals/${goalId}/memory`);
      expect(memAfterRestartResp.status).toBe(200);
      const { items: memAfterRestart } = ListGoalMemoryResponse.parse(await memAfterRestartResp.json());
      expect(memAfterRestart.length).toBe(memAfterRetry.length);

      const decAfterRestartResp = await getJson(b2.baseUrl, `/v1/goals/${goalId}/decisions`);
      expect(decAfterRestartResp.status).toBe(200);
      const { items: decisionsAfterRestart } = ListGoalDecisionsResponse.parse(await decAfterRestartResp.json());
      expect(decisionsAfterRestart.length).toBeGreaterThanOrEqual(1);

      const summaryAfterRestartResp = await getJson(b2.baseUrl, `/v1/sessions/${sessionId}/summary`);
      expect(summaryAfterRestartResp.status).toBe(200);
      const summaryAfterRestart = (await summaryAfterRestartResp.json()) as {
        summary: { headline: string };
      };
      expect(summaryAfterRestart.summary.headline).toBe('shell-manual session completed');

      await stop(b2.server, b2.runner);
      b2 = undefined;

      // ── Privacy check: no content fields in any emitted event payload ──────────
      // The spec forbids: content, decisionText, summaryText, outputTail, prompt, response
      const FORBIDDEN_PAYLOAD_KEYS = [
        'content',
        'decisionText',
        'summaryText',
        'outputTail',
        'prompt',
        'response',
        'rationale',
      ] as const;

      for (const event of allEvents) {
        for (const key of FORBIDDEN_PAYLOAD_KEYS) {
          expect(
            Object.prototype.hasOwnProperty.call(event.payload, key),
            `Event "${event.type}" (seq=${event.seq}) must not contain payload.${key}`,
          ).toBe(false);
        }
      }

    } finally {
      unsubCollect();
      if (b1) await stop(b1.server, b1.runner).catch(() => {});
      if (b2) await stop(b2.server, b2.runner).catch(() => {});
    }
  });
});
