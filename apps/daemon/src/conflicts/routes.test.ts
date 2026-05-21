import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  ListConflictsResponse,
  ResolveConflictResponse,
  type Conflict,
} from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { eventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { bootstrapRegistries } from '../registry/bootstrap.js';
import { createServer } from '../server.js';
import {
  insertRecommendation,
  resetPreparedStatements as resetRecommendationUsecaseStatements,
} from '../recommendations/usecases.js';
import { recommendationFingerprint } from '../recommendations/fingerprint.js';
import { resetPreparedStatements as resetConflictUsecaseStatements } from './usecases.js';

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;
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

beforeAll(() => {
  bootstrapRegistries();
});

describe('conflict routes', () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-conflict-routes-'));
    tempDirs.push(dir);

    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    resetConflictUsecaseStatements();
    resetRecommendationUsecaseStatements();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedGoal(id: string): void {
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES (?, 'Goal', 'Route tests', 'active', 1, ?, ?, NULL)`
    ).run(id, NOW, NOW);
  }

  function seedConflict(input: {
    id: string;
    goalId: string;
    status?: Conflict['status'];
    severity?: Conflict['severity'];
    conflictType?: Conflict['conflictType'];
    title?: string;
    description?: string;
    resolutionNote?: string | null;
  }): void {
    const status = input.status ?? 'open';
    const detectedAt = NOW;
    const resolvedAt = status === 'open' ? null : NOW;
    db.prepare(
      `INSERT INTO conflicts
        (id, goal_id, conflict_type, severity, status, title, description, sources_json, fingerprint, resolution_note, detected_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.goalId,
      input.conflictType ?? 'workspace_overlap',
      input.severity ?? 'warning',
      status,
      input.title ?? `Conflict ${input.id}`,
      input.description ?? 'Conflict description',
      JSON.stringify([{ type: 'workspace', id: 'ws-1', role: 'context' }]),
      `fp-${input.id}`,
      input.resolutionNote ?? null,
      detectedAt,
      resolvedAt
    );
  }

  function seedLinkedResolveConflictRecommendation(goalId: string, conflictId: string): void {
    const proposedAction = {
      kind: 'resolve_conflict' as const,
      conflictId,
      suggestedResolutionNote: 'Resolve after review',
    };
    const proposedActionJson = JSON.stringify(proposedAction);
    insertRecommendation(db, {
      id: 'rec-resolve-1',
      goalId,
      generationId: null,
      type: 'resolve_conflict',
      status: 'proposed',
      source: 'deterministic_provider',
      title: 'Resolve conflict',
      rationale: 'A conflict must be resolved before continuing work.',
      proposedActionJson,
      confidence: 0.8,
      sourcesJson: JSON.stringify([{ type: 'conflict', id: conflictId, reason: 'route_test' }]),
      relatedTaskId: null,
      relatedSessionId: null,
      relatedContextPkgId: null,
      relatedConflictId: conflictId,
      fingerprint: recommendationFingerprint(goalId, 'resolve_conflict', proposedActionJson),
      supersededById: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('GET /v1/goals/:goalId/conflicts lists open conflicts by default and supports severity filter', async () => {
    seedGoal('g1');
    seedConflict({ id: 'c-open-warning', goalId: 'g1', status: 'open', severity: 'warning' });
    seedConflict({ id: 'c-open-blocker', goalId: 'g1', status: 'open', severity: 'blocker' });
    seedConflict({ id: 'c-resolved', goalId: 'g1', status: 'resolved', severity: 'warning' });

    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/g1/conflicts',
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = ListConflictsResponse.parse(JSON.parse(response.body));
    expect(body.conflicts).toHaveLength(2);
    expect(body.conflicts.every((conflict) => conflict.status === 'open')).toBe(true);

    const filtered = await server.inject({
      method: 'GET',
      url: '/v1/goals/g1/conflicts?severity=blocker',
      headers: AUTH_HEADERS,
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = ListConflictsResponse.parse(JSON.parse(filtered.body));
    expect(filteredBody.conflicts).toHaveLength(1);
    expect(filteredBody.conflicts[0].id).toBe('c-open-blocker');
  });

  it('GET /v1/goals/:goalId/conflicts returns 404 for unknown goals', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/goals/missing/conflicts',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(404);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('goal_not_found');
  });

  it('POST /v1/conflicts/:id/resolve resolves an open conflict and returns it', async () => {
    seedGoal('g1');
    seedConflict({ id: 'c1', goalId: 'g1', status: 'open' });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/conflicts/c1/resolve',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { resolution: 'resolved', note: 'Handled' },
    });

    expect(response.statusCode).toBe(200);
    const body = ResolveConflictResponse.parse(JSON.parse(response.body));
    expect(body.conflict.id).toBe('c1');
    expect(body.conflict.status).toBe('resolved');
    expect(body.conflict.resolutionNote).toBe('Handled');
  });

  it('POST /v1/conflicts/:id/resolve can dismiss an open conflict', async () => {
    seedGoal('g1');
    seedConflict({ id: 'c1', goalId: 'g1', status: 'open' });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/conflicts/c1/resolve',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { resolution: 'dismissed' },
    });

    expect(response.statusCode).toBe(200);
    const body = ResolveConflictResponse.parse(JSON.parse(response.body));
    expect(body.conflict.status).toBe('dismissed');
  });

  it('POST /v1/conflicts/:id/resolve returns 409 when resolving a non-open conflict', async () => {
    seedGoal('g1');
    seedConflict({ id: 'c1', goalId: 'g1', status: 'open' });

    const first = await server.inject({
      method: 'POST',
      url: '/v1/conflicts/c1/resolve',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { resolution: 'resolved' },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: '/v1/conflicts/c1/resolve',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { resolution: 'resolved' },
    });
    expect(second.statusCode).toBe(409);
    expect((JSON.parse(second.body) as { error: { code: string } }).error.code).toBe('invalid_conflict_status');
  });

  it('POST /v1/conflicts/:id/resolve persists cascade events contiguously in event store', async () => {
    seedGoal('g1');
    seedConflict({ id: 'c1', goalId: 'g1', status: 'open' });
    seedLinkedResolveConflictRecommendation('g1', 'c1');

    const maxBefore = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events')
      .get() as { maxSeq: number };

    const response = await server.inject({
      method: 'POST',
      url: '/v1/conflicts/c1/resolve',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { resolution: 'resolved' },
    });
    expect(response.statusCode).toBe(200);

    const rows = db
      .prepare('SELECT seq, type FROM events WHERE seq > ? ORDER BY seq ASC')
      .all(maxBefore.maxSeq) as Array<{ seq: number; type: string }>;
    expect(rows.map((row) => row.type)).toEqual([
      'conflict.resolved',
      'recommendation.dismissed',
      'user.feedback.recorded',
    ]);
    expect(rows.map((row) => row.seq)).toEqual([
      maxBefore.maxSeq + 1,
      maxBefore.maxSeq + 2,
      maxBefore.maxSeq + 3,
    ]);

    const recStatus = db
      .prepare('SELECT status FROM recommendations WHERE id = ?')
      .get('rec-resolve-1') as { status: string };
    expect(recStatus.status).toBe('dismissed');

    const feedbackCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM recommendation_feedback WHERE recommendation_id = ? AND action = 'dismiss'"
      )
      .get('rec-resolve-1') as { count: number };
    expect(feedbackCount.count).toBe(1);
  });
});
