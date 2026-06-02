import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  AcceptRecommendationResponse,
  DismissRecommendationResponse,
  GetRecommendationResponse,
  ListRecommendationsResponse,
  ModifyRecommendationResponse,
  RecommendationGenerationResponse,
  RejectRecommendationResponse,
  type ProposedAction,
} from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { eventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { bootstrapRegistries } from '../registry/bootstrap.js';
import { createDaemonContext } from '../daemon-context.js';
import { createServer } from '../server.js';
import { resetRunnerState } from '../generation/runner.js';
import { FakeRecommendationProvider } from './provider.js';
import {
  insertRecommendation,
  resetPreparedStatements as resetRecommendationUsecaseStatements,
} from './usecases.js';
import { getFeedbackByRecommendationId } from './feedback.js';
import { recommendationFingerprint } from './fingerprint.js';

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;
const NOW = '2026-01-01T00:00:00.000Z';

const ASK_USER_ACTION: ProposedAction = {
  kind: 'ask_user',
  question: 'Proceed with this recommendation?',
};

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

beforeAll(() => {
  bootstrapRegistries();
});

describe('recommendation routes', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let fakeProvider: FakeRecommendationProvider;
  let idCounter = 0;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-rec-routes-'));
    tempDirs.push(dir);

    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());

    fakeProvider = new FakeRecommendationProvider();
    fakeProvider.setFixtures([
      {
        type: 'ask_user',
        title: 'Ask for direction',
        rationale: 'A bounded user decision is needed.',
        proposedAction: ASK_USER_ACTION,
        confidence: 0.8,
        sources: [{ type: 'goal', id: 'g1', reason: 'manual' }],
      },
    ]);

    const daemonContext = createDaemonContext(db, eventBus);
    daemonContext.recommendationProvider = fakeProvider;
    daemonContext.now = () => NOW;
    daemonContext.idFactory = () => `id-${++idCounter}`;

    server = createServer(config, { daemonContext });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    resetRecommendationUsecaseStatements();
    resetRunnerState();
    vi.restoreAllMocks();
    idCounter = 0;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedGoal(id: string, opts?: { archived?: boolean }): void {
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES (?, 'Goal', 'Route tests', 'active', 1, ?, ?, ?)`
    ).run(id, NOW, NOW, opts?.archived ? NOW : null);
  }

  function seedRecommendation(opts?: {
    id?: string;
    goalId?: string;
    status?: string;
    title?: string;
    action?: ProposedAction;
  }) {
    const id = opts?.id ?? 'rec-1';
    const goalId = opts?.goalId ?? 'g1';
    const action = opts?.action ?? ASK_USER_ACTION;
    const proposedActionJson = JSON.stringify(action);
    insertRecommendation(db, {
      id,
      goalId,
      generationId: null,
      type: action.kind,
      status: opts?.status ?? 'proposed',
      source: 'deterministic_provider',
      title: opts?.title ?? 'Ask for direction',
      rationale: 'A bounded user decision is needed.',
      proposedActionJson,
      confidence: 0.8,
      sourcesJson: JSON.stringify([{ type: 'goal', id: goalId, reason: 'manual' }]),
      relatedTaskId: null,
      relatedSessionId: null,
      relatedContextPkgId: null,
      relatedConflictId: null,
      fingerprint: recommendationFingerprint(goalId, action.kind, proposedActionJson),
      supersededById: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async function waitForGenerationTerminal(generationId: string, timeoutMs = 1000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = db
        .prepare('SELECT status FROM recommendation_generations WHERE id = ?')
        .get(generationId) as { status: string } | undefined;
      if (row && (row.status === 'succeeded' || row.status === 'failed')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for recommendation generation ${generationId}`);
  }

  it('POST /v1/goals/:goalId/recommendations/generate returns 202 and reuses the active generation', async () => {
    seedGoal('g1');
    vi.spyOn(fakeProvider, 'generate').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        candidates: [
          {
            type: 'ask_user',
            title: 'Ask for direction',
            rationale: 'A bounded user decision is needed.',
            proposedAction: ASK_USER_ACTION,
            confidence: 0.8,
            sources: [{ type: 'goal', id: 'g1', reason: 'manual' }],
          },
        ],
        warnings: [],
        sparse: false,
      };
    });

    const first = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/recommendations/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = RecommendationGenerationResponse.parse(JSON.parse(first.body));

    const second = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/recommendations/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    expect(second.statusCode).toBe(202);
    const secondBody = RecommendationGenerationResponse.parse(JSON.parse(second.body));

    expect(secondBody.generation.id).toBe(firstBody.generation.id);
    const count = db
      .prepare('SELECT COUNT(*) AS count FROM recommendation_generations WHERE goal_id = ?')
      .get('g1') as { count: number };
    expect(count.count).toBe(1);

    await waitForGenerationTerminal(firstBody.generation.id);
  });

  it('POST /v1/goals/:goalId/recommendations/generate returns 409 for archived goals', async () => {
    seedGoal('g-archived', { archived: true });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/goals/g-archived/recommendations/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('goal_archived');
  });

  it('GET /v1/goals/:goalId/recommendations lists proposed recommendations by default', async () => {
    seedGoal('g1');
    seedRecommendation({ id: 'rec-proposed', title: 'Proposed' });
    seedRecommendation({
      id: 'rec-dismissed',
      status: 'dismissed',
      title: 'Dismissed',
      action: { kind: 'ask_user', question: 'Dismissed?' },
    });
    vi.spyOn(fakeProvider, 'generate').mockResolvedValue({
      candidates: [
        {
          type: 'ask_user',
          title: 'Generated recommendation',
          rationale: 'Generated by route test.',
          proposedAction: { kind: 'ask_user', question: 'Generated?' },
          confidence: 0.7,
          sources: [{ type: 'goal', id: 'g1', reason: 'manual' }],
        },
      ],
      warnings: [],
      sparse: false,
    });

    const generationResponse = await server.inject({
      method: 'POST',
      url: '/v1/goals/g1/recommendations/generate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { trigger: 'manual' },
    });
    const generationBody = RecommendationGenerationResponse.parse(JSON.parse(generationResponse.body));
    await waitForGenerationTerminal(generationBody.generation.id);

    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/g1/recommendations?includeGenerations=false',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = ListRecommendationsResponse.parse(JSON.parse(response.body));
    expect(body.recommendations.every((rec) => rec.status === 'proposed')).toBe(true);
    expect(body.recommendations.some((rec) => rec.id === 'rec-proposed')).toBe(true);
    expect(body.recommendations.some((rec) => rec.id === 'rec-dismissed')).toBe(false);
    expect(body.generations).toHaveLength(0);
  });

  it('GET /v1/goals/:goalId/recommendations can surface superseded recommendations', async () => {
    seedGoal('g1');
    seedRecommendation({ id: 'rec-superseded', status: 'superseded' });

    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/g1/recommendations?status=superseded',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = ListRecommendationsResponse.parse(JSON.parse(response.body));
    expect(body.recommendations).toHaveLength(1);
    expect(body.recommendations[0].id).toBe('rec-superseded');
    expect(body.recommendations[0].status).toBe('superseded');
  });

  it('GET /v1/recommendations/:id returns detail with parsed sources and feedback', async () => {
    seedGoal('g1');
    seedRecommendation();

    await server.inject({
      method: 'PATCH',
      url: '/v1/recommendations/rec-1',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Updated recommendation' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/v1/recommendations/rec-1',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = GetRecommendationResponse.parse(JSON.parse(response.body));
    expect(body.recommendation.sources).toEqual([{ type: 'goal', id: 'g1', reason: 'manual' }]);
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].action).toBe('modify');
  });

  it('POST /v1/recommendations/:id/accept records feedback and returns proposedAction without downstream HTTP calls', async () => {
    seedGoal('g1');
    seedRecommendation();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/accept',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { note: 'Looks good' },
    });

    expect(response.statusCode).toBe(200);
    const body = AcceptRecommendationResponse.parse(JSON.parse(response.body));
    expect(body.recommendation.status).toBe('accepted');
    expect(body.feedback.action).toBe('accept');
    expect(body.proposedAction).toEqual(ASK_USER_ACTION);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_packages').get()).toEqual({ count: 0 });
  });

  it('POST /v1/recommendations/:id/accept is idempotent for repeat accept', async () => {
    seedGoal('g1');
    seedRecommendation();

    await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/accept',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/accept',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });

    expect(second.statusCode).toBe(200);
    const feedback = getFeedbackByRecommendationId(db, 'rec-1');
    expect(feedback.filter((item) => item.action === 'accept')).toHaveLength(1);
  });

  it('POST /v1/recommendations/:id/reject records feedback and rejects terminal one-shot conflicts', async () => {
    seedGoal('g1');
    seedRecommendation();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/reject',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { note: 'No' },
    });
    expect(response.statusCode).toBe(200);
    const body = RejectRecommendationResponse.parse(JSON.parse(response.body));
    expect(body.recommendation.status).toBe('rejected');
    expect(body.feedback.action).toBe('reject');

    const acceptAfterReject = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/accept',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });
    expect(acceptAfterReject.statusCode).toBe(409);
  });

  it('POST /v1/recommendations/:id/dismiss records feedback', async () => {
    seedGoal('g1');
    seedRecommendation();

    const response = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/dismiss',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = DismissRecommendationResponse.parse(JSON.parse(response.body));
    expect(body.recommendation.status).toBe('dismissed');
    expect(body.feedback.action).toBe('dismiss');
  });

  it('PATCH /v1/recommendations/:id modifies a non-terminal recommendation and can then accept it', async () => {
    seedGoal('g1');
    seedRecommendation();

    const modifyResponse = await server.inject({
      method: 'PATCH',
      url: '/v1/recommendations/rec-1',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        title: 'Modified title',
        rationale: 'Modified rationale',
        proposedAction: { kind: 'ask_user', question: 'Modified question?' },
      },
    });

    expect(modifyResponse.statusCode).toBe(200);
    const modifyBody = ModifyRecommendationResponse.parse(JSON.parse(modifyResponse.body));
    expect(modifyBody.recommendation.status).toBe('modified');
    expect(modifyBody.recommendation.title).toBe('Modified title');
    expect(modifyBody.feedback.action).toBe('modify');
    expect(modifyBody.feedback.modifiedPayloadJson).toBe(JSON.stringify(ASK_USER_ACTION));

    const acceptResponse = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/accept',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });
    expect(acceptResponse.statusCode).toBe(200);
    const acceptBody = AcceptRecommendationResponse.parse(JSON.parse(acceptResponse.body));
    expect(acceptBody.recommendation.status).toBe('accepted');
  });

  it('PATCH /v1/recommendations/:id rejects terminal recommendations', async () => {
    seedGoal('g1');
    seedRecommendation({ status: 'accepted' });

    const response = await server.inject({
      method: 'PATCH',
      url: '/v1/recommendations/rec-1',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { title: 'Nope' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('invalid_recommendation_status');
  });

  it('does not register execute or per-recommendation regenerate endpoints', async () => {
    seedGoal('g1');
    seedRecommendation();

    const execute = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/execute',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });
    const regenerate = await server.inject({
      method: 'POST',
      url: '/v1/recommendations/rec-1/regenerate',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {},
    });

    expect(execute.statusCode).toBe(404);
    expect(regenerate.statusCode).toBe(404);
  });
});
