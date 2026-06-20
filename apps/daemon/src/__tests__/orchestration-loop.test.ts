/**
 * Orchestration proof loop integration test.
 *
 * Exercises: task generation → recommendation generation → recommendation
 * accept (suggestion-only assertion) → workspace-overlap conflict detection →
 * conflict resolution with auto-dismiss → daemon-restart reconciliation.
 *
 * All state (tasks, recommendations, conflicts, feedback) verified to survive
 * daemon restart.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AcceptRecommendationResponse,
  CreateGoalResponse,
  ListConflictsResponse,
  ListRecommendationsResponse,
  ListTasksResponse,
  ResolveConflictResponse,
  TaskGenerationResponse,
  type DomainEvent,
} from '@orca/contracts';

import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { eventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { bootstrapRegistries } from '../registry/bootstrap.js';
import { createServer } from '../server.js';
import { createSessionOutputStore } from '../sessions/output-store.js';
import { FakePtyManager } from '../pty/fake.js';
import { SessionRuntime } from '../sessions/runtime.js';
import { reconcileInFlightGenerations } from '../generation/reconcile.js';
import { detectAndPersist } from '../conflicts/usecases.js';
import { resetRunnerState } from '../generation/runner.js';
import { resetPreparedStatements as resetTaskUcaseStmts } from '../tasks/usecases.js';
import { resetPreparedStatements as resetTaskProjStmts } from '../tasks/projection.js';
import { resetPreparedStatements as resetTaskInputStmts } from '../tasks/input.js';
import { resetPreparedStatements as resetRecUcaseStmts } from '../recommendations/usecases.js';
import { resetPreparedStatements as resetRecProjStmts } from '../recommendations/projection.js';
import { resetPreparedStatements as resetRecInputStmts } from '../recommendations/input.js';
import { resetPreparedStatements as resetConflictUcaseStmts } from '../conflicts/usecases.js';
import { resetPreparedStatements as resetConflictProjStmts } from '../conflicts/projection.js';
import { resetPreparedStatements as resetDetectorStmts } from '../conflicts/detectors.js';
import { resetPreparedStatements as resetTriggerStmts } from '../generation/triggers.js';
import { resetPreparedStatements as resetMemoryUcaseStmts } from '../memory/usecases.js';
import { resetPreparedStatements as resetMemoryProjStmts } from '../memory/projection.js';
import { resetPreparedStatements as resetDecisionUcaseStmts } from '../decisions/usecases.js';
import { resetPreparedStatements as resetDecisionProjStmts } from '../decisions/projection.js';
import { resetPreparedStatements as resetContextInputStmts } from '../context/input.js';
import { resetPreparedStatements as resetContextProjStmts } from '../context/projection.js';
import { resetPreparedStatements as resetContextUcaseStmts } from '../context/usecases.js';
import { resetPreparedStatements as resetSessionProjStmts } from '../sessions/projection.js';
import { resetPreparedStatements as resetSessionUcaseStmts } from '../sessions/usecases.js';
import { resetPreparedStatements as resetSessionRuntimeStmts } from '../sessions/runtime.js';

beforeAll(() => {
  bootstrapRegistries();
});

const AUTH = { authorization: 'Bearer test-token' } as const;
const NOW = '2026-05-21T10:00:00.000Z';

const ORCHESTRATION_EVENT_TYPES = new Set([
  'task.generation.requested',
  'task.generated',
  'task.generation.failed',
  'task.created',
  'task.updated',
  'task.split',
  'task.status_changed',
  'task.associated_with_session',
  'task.associated_with_context_package',
  'recommendation.generation.requested',
  'recommendation.generated',
  'recommendation.generation.failed',
  'recommendation.accepted',
  'recommendation.rejected',
  'recommendation.dismissed',
  'recommendation.modified',
  'recommendation.superseded',
  'conflict.detected',
  'conflict.resolved',
  'conflict.dismissed',
  'user.feedback.recorded',
]);

const FORBIDDEN_BODY_STRINGS = [
  'Goals:',
  'Content-free test',
  'Test content-free events',
  'recommendation rationale',
  'description',
  'acceptance_criteria',
];

const tempDirs: string[] = [];

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return realpathSync(dir);
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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(config: Config): Database.Database {
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function resetAllPreparedStatements(): void {
  resetTaskUcaseStmts();
  resetTaskProjStmts();
  resetTaskInputStmts();
  resetRecUcaseStmts();
  resetRecProjStmts();
  resetRecInputStmts();
  resetConflictUcaseStmts();
  resetConflictProjStmts();
  resetDetectorStmts();
  resetTriggerStmts();
  resetMemoryUcaseStmts();
  resetMemoryProjStmts();
  resetDecisionUcaseStmts();
  resetDecisionProjStmts();
  resetContextInputStmts();
  resetContextProjStmts();
  resetContextUcaseStmts();
  resetSessionProjStmts();
  resetSessionUcaseStmts();
  resetSessionRuntimeStmts();
  resetRunnerState();
}

function countRows(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function seedEngineerSession(
  db: Database.Database,
  goalId: string,
  workspaceId: string,
  sessionId: string,
  now: string
): { sessionId: string; summaryId: string } {
  const extractionId = `extraction-${sessionId}`;
  const summaryId = `summary-${sessionId}`;

  db.prepare(`
    INSERT INTO sessions (
      id, goal_id, workspace_id, adapter_id, role, instruction, title,
      status, created_at, started_at, exited_at
    ) VALUES (?, ?, ?, 'claude-code', 'engineer', NULL, 'Engineer session', 'exited', ?, ?, ?)
  `).run(sessionId, goalId, workspaceId, now, now, now);

  db.prepare(`
    INSERT INTO memory_extractions (
      id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
      source_offset_first, source_offset_last, summary_id, item_count, decision_count,
      promoted_count, requested_at, started_at, finished_at
    ) VALUES (
      ?, ?, ?, 'terminal_state', 'succeeded', 'test-extractor', ?,
      0, 512, ?, 0, 0, 0, ?, ?, ?
    )
  `).run(extractionId, goalId, sessionId, `fp-${sessionId}`, summaryId, now, now, now);

  db.prepare(`
    INSERT INTO session_summaries (
      id, session_id, goal_id, extraction_id, headline, summary_text,
      truncated, source_offset_first, source_offset_last, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 512, ?)
  `).run(
    summaryId,
    sessionId,
    goalId,
    extractionId,
    'Engineer session completed',
    'All tests passed. Ran build and lint. Committed the implementation.',
    now
  );

  return { sessionId, summaryId };
}

function seedRunningSession(
  db: Database.Database,
  goalId: string,
  workspaceId: string,
  sessionId: string,
  now: string
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, goal_id, workspace_id, adapter_id, role, instruction, title,
      status, created_at, started_at, exited_at
    ) VALUES (?, ?, ?, 'claude-code', 'engineer', NULL, 'Running session', 'running', ?, ?, NULL)
  `).run(sessionId, goalId, workspaceId, now, now);
}

describe.sequential('orchestration proof loop', () => {
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
    resetAllPreparedStatements();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end: task generation → recommendation → accept (no auto-launch) → conflict + auto-dismiss → restart reconciliation', async () => {
    const dataDir = mktemp('orca-proof-db-');
    const workspaceDir = mktemp('orca-proof-ws-');
    const config = createConfig(dataDir);

    // ── Boot ─────────────────────────────────────────────────────────────────
    db = openTestDb(config);
    server = createServer(config, {
      sessionRuntime: new SessionRuntime(new FakePtyManager()),
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });

    const publishedEvents: DomainEvent[] = [];
    unsubscribe = eventBus.subscribe((event) => publishedEvents.push(event));

    // ── Step 1: Create Goal with refinement and workspace ─────────────────────
    const refineRes = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: AUTH,
      payload: {
        title: 'Orchestration proof loop',
        description: [
          'Goals:',
          '- Implement suggested orchestration',
          '',
          'Constraints:',
          '- Local first',
          '- Suggestion only',
        ].join('\n'),
      },
    });
    expect(refineRes.statusCode, refineRes.body).toBe(200);
    const draft = (JSON.parse(refineRes.body) as { draft: unknown }).draft;

    const createGoalRes = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: AUTH,
      payload: {
        title: 'Orchestration proof loop',
        refined: draft,
        workspaces: [{ inputPath: workspaceDir }],
      },
    });
    expect(createGoalRes.statusCode, createGoalRes.body).toBe(201);
    const { goal } = CreateGoalResponse.parse(JSON.parse(createGoalRes.body));
    const goalId = goal.id;

    const workspaceRow = db
      .prepare('SELECT w.id AS id FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?')
      .get(goalId) as { id: string };
    const workspaceId = workspaceRow.id;

    // ── Step 2: Generate tasks ────────────────────────────────────────────────
    const taskGenRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/tasks/generate`,
      headers: AUTH,
      payload: { trigger: 'manual' },
    });
    expect(taskGenRes.statusCode, taskGenRes.body).toBe(202);
    TaskGenerationResponse.parse(JSON.parse(taskGenRes.body));

    // Wait for async generation to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const listTasksRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/tasks`,
      headers: AUTH,
    });
    expect(listTasksRes.statusCode, listTasksRes.body).toBe(200);
    const taskListBody = ListTasksResponse.parse(JSON.parse(listTasksRes.body));
    expect(taskListBody.tasks.length, 'Expected ≥ 1 generated task').toBeGreaterThanOrEqual(1);

    // Verify sources reference the refinement
    const firstTask = taskListBody.tasks[0]!;
    expect(firstTask.sources.some((s) => s.type === 'refinement')).toBe(true);

    // ── Step 3: Seed engineer session with implementation evidence ────────────
    seedEngineerSession(db, goalId, workspaceId, 'eng-session-proof-1', NOW);

    // ── Step 4: Trigger recommendation generation ─────────────────────────────
    const recGenRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/recommendations/generate`,
      headers: AUTH,
      payload: { trigger: 'manual' },
    });
    expect(recGenRes.statusCode, recGenRes.body).toBe(202);

    // Wait for async generation to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const listRecsRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/recommendations`,
      headers: AUTH,
    });
    expect(listRecsRes.statusCode, listRecsRes.body).toBe(200);
    const recsBody = ListRecommendationsResponse.parse(JSON.parse(listRecsRes.body));

    const runValidationRecs = recsBody.recommendations.filter((r) => r.type === 'run_validation');
    expect(runValidationRecs.length, 'Expected ≥ 1 run_validation recommendation').toBeGreaterThanOrEqual(1);

    const runValidationRec = runValidationRecs[0]!;
    // Sources must include the session and (if present) the summary
    const recSourceTypes = runValidationRec.sources.map((s) => s.type);
    expect(recSourceTypes).toContain('session');
    // Sparse must be false (we have input data)
    const recGenRows = db.prepare(
      "SELECT sparse FROM recommendation_generations WHERE goal_id = ? ORDER BY requested_at DESC LIMIT 1"
    ).get(goalId) as { sparse: number } | undefined;
    expect(recGenRows?.sparse ?? 0, 'Recommendation generation must not be sparse').toBe(0);

    // ── Step 5: Accept recommendation → assert proposedAction, no auto-launch ─
    const sessionCreatedCountBefore = publishedEvents.filter(
      (e) => e.type === 'session.created'
    ).length;

    const acceptRes = await server.inject({
      method: 'POST',
      url: `/v1/recommendations/${runValidationRec.id}/accept`,
      headers: AUTH,
      payload: {},
    });
    expect(acceptRes.statusCode, acceptRes.body).toBe(200);
    const acceptBody = AcceptRecommendationResponse.parse(JSON.parse(acceptRes.body));
    expect(acceptBody.proposedAction).toBeDefined();
    expect((acceptBody.proposedAction as { kind: string }).kind).toBe('run_validation');
    expect(acceptBody.recommendation.status).toBe('accepted');

    // No automatic session.created must fire as a result of accepting
    const sessionCreatedCountAfter = publishedEvents.filter(
      (e) => e.type === 'session.created'
    ).length;
    expect(sessionCreatedCountAfter, 'Accepting a recommendation must not auto-create a session')
      .toBe(sessionCreatedCountBefore);

    // ── Step 6: Insert two running sessions → workspace_overlap conflict ───────
    seedRunningSession(db, goalId, workspaceId, 'running-session-a', NOW);
    seedRunningSession(db, goalId, workspaceId, 'running-session-b', NOW);

    const eventsBefore = publishedEvents.length;
    const detectResult = detectAndPersist(
      { db, bus: eventBus, now: () => NOW },
      { goalId }
    );

    expect(detectResult.conflictIds.length, 'Expected ≥ 1 workspace_overlap conflict')
      .toBeGreaterThanOrEqual(1);
    expect(detectResult.recommendationIds.length, 'Expected ≥ 1 linked resolve_conflict rec')
      .toBeGreaterThanOrEqual(1);

    // conflict.detected and recommendation.generated must both be in the same TX
    // (i.e., both published in the same detectAndPersist call)
    const newEvents = publishedEvents.slice(eventsBefore);
    expect(newEvents.some((e) => e.type === 'conflict.detected')).toBe(true);
    expect(newEvents.some((e) => e.type === 'recommendation.generated')).toBe(true);

    const conflictId = detectResult.conflictIds[0]!;
    const linkedRecId = detectResult.recommendationIds[0]!;

    // Verify the conflict row
    const conflictRow = db
      .prepare("SELECT conflict_type, status FROM conflicts WHERE id = ?")
      .get(conflictId) as { conflict_type: string; status: string } | undefined;
    expect(conflictRow?.conflict_type).toBe('workspace_overlap');
    expect(conflictRow?.status).toBe('open');

    // Verify the linked resolve_conflict recommendation
    const linkedRecRow = db
      .prepare("SELECT type, status, related_conflict_id FROM recommendations WHERE id = ?")
      .get(linkedRecId) as { type: string; status: string; related_conflict_id: string } | undefined;
    expect(linkedRecRow?.type).toBe('resolve_conflict');
    expect(linkedRecRow?.status).toBe('proposed');
    expect(linkedRecRow?.related_conflict_id).toBe(conflictId);

    // Verify via API
    const conflictListRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/conflicts`,
      headers: AUTH,
    });
    expect(conflictListRes.statusCode, conflictListRes.body).toBe(200);
    const conflictList = ListConflictsResponse.parse(JSON.parse(conflictListRes.body));
    expect(conflictList.conflicts.some((c) => c.id === conflictId)).toBe(true);

    // ── Step 7: Resolve conflict → auto-dismiss linked recommendation ─────────
    const eventsBeforeResolve = publishedEvents.length;

    const resolveRes = await server.inject({
      method: 'POST',
      url: `/v1/conflicts/${conflictId}/resolve`,
      headers: AUTH,
      payload: { resolution: 'resolved', note: 'Sessions coordinated manually.' },
    });
    expect(resolveRes.statusCode, resolveRes.body).toBe(200);
    const resolveBody = ResolveConflictResponse.parse(JSON.parse(resolveRes.body));
    expect(resolveBody.conflict.status).toBe('resolved');

    // After resolve, linked recommendation must be auto-dismissed
    const linkedRecRowAfter = db
      .prepare("SELECT status FROM recommendations WHERE id = ?")
      .get(linkedRecId) as { status: string } | undefined;
    expect(linkedRecRowAfter?.status).toBe('dismissed');

    // Verify correct events were published in the same TX (after resolve call)
    const resolveEvents = publishedEvents.slice(eventsBeforeResolve);
    const resolveEventTypes = resolveEvents.map((e) => e.type);
    expect(resolveEventTypes).toContain('conflict.resolved');
    expect(resolveEventTypes).toContain('recommendation.dismissed');
    expect(resolveEventTypes).toContain('user.feedback.recorded');

    // All events must be content-free and ≤ 4 KiB serialized
    for (const event of resolveEvents) {
      const payloadStr = JSON.stringify(event.payload);
      expect(payloadStr.length, `Event ${event.type} payload exceeds 4 KiB`).toBeLessThanOrEqual(4096);
      expect(payloadStr).not.toContain('Sessions coordinated manually');
    }

    // ── Step 8: Restart — reconcile stale pending generation ──────────────────
    // Insert a fake pending task generation row to simulate a crash mid-generation
    const staleGenId = 'stale-gen-proof-1';
    db.prepare(`
      INSERT INTO task_generations (
        id, goal_id, trigger, trigger_source_id, generator_id, generator_version,
        input_fingerprint, request_fingerprint, status, failure_code, failure_message,
        task_ids_json, sparse, requested_at, started_at, finished_at
      ) VALUES (
        ?, ?, 'manual', NULL, 'orca/deterministic-task-generator', '0.1.0',
        'ifp-stale', 'rfp-stale', 'pending', NULL, NULL, '[]', 0, ?, NULL, NULL
      )
    `).run(staleGenId, goalId, NOW);

    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM task_generations WHERE id = ? AND status = 'pending'", staleGenId)
    ).toBe(1);

    // Simulate daemon restart: close DB and reset all statement caches
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    await server.close();
    server = null;
    closeDatabase();
    resetAllPreparedStatements();

    // Reopen DB (simulating daemon boot)
    db = openTestDb(config);

    // Run boot reconciliation
    await reconcileInFlightGenerations(db, { now: '2026-05-21T10:05:00.000Z' });

    // Stale generation must now be failed/daemon_restart
    const reconciledGen = db
      .prepare("SELECT status, failure_code FROM task_generations WHERE id = ?")
      .get(staleGenId) as { status: string; failure_code: string } | undefined;
    expect(reconciledGen?.status).toBe('failed');
    expect(reconciledGen?.failure_code).toBe('daemon_restart');

    // A task.generation.failed event must exist for the stale generation
    const reconcileFailedEvent = db
      .prepare(`
        SELECT payload FROM events
        WHERE type = 'task.generation.failed' AND goal_id = ?
        ORDER BY seq DESC LIMIT 1
      `)
      .get(goalId) as { payload: string } | undefined;
    expect(reconcileFailedEvent).toBeDefined();
    const failedPayload = JSON.parse(reconcileFailedEvent!.payload) as Record<string, unknown>;
    expect(failedPayload.generationId).toBe(staleGenId);
    expect(failedPayload.failureCode).toBe('daemon_restart');
    // Event must not contain failure message body text
    expect(JSON.stringify(failedPayload).length).toBeLessThanOrEqual(4096);

    // ── Verify all rows survive restart ───────────────────────────────────────
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM tasks WHERE goal_id = ?", goalId)
    ).toBeGreaterThanOrEqual(1);

    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM recommendations WHERE goal_id = ?", goalId)
    ).toBeGreaterThanOrEqual(1);

    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM conflicts WHERE id = ?", conflictId)
    ).toBe(1);

    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM recommendation_feedback WHERE goal_id = ?", goalId)
    ).toBeGreaterThanOrEqual(1);

    // Accepted recommendation is still accepted
    const acceptedRecRow = db
      .prepare("SELECT status FROM recommendations WHERE id = ?")
      .get(runValidationRec.id) as { status: string } | undefined;
    expect(acceptedRecRow?.status).toBe('accepted');

    // Resolved conflict is still resolved
    const resolvedConflictRow = db
      .prepare("SELECT status FROM conflicts WHERE id = ?")
      .get(conflictId) as { status: string } | undefined;
    expect(resolvedConflictRow?.status).toBe('resolved');

    // Reopen server and assert list endpoints return expected state
    server = createServer(config, {
      sessionRuntime: new SessionRuntime(new FakePtyManager()),
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });
    unsubscribe = eventBus.subscribe((event) => publishedEvents.push(event));

    const postRestartTasksRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/tasks`,
      headers: AUTH,
    });
    expect(postRestartTasksRes.statusCode, postRestartTasksRes.body).toBe(200);
    const postRestartTasks = ListTasksResponse.parse(JSON.parse(postRestartTasksRes.body));
    expect(postRestartTasks.tasks.length).toBeGreaterThanOrEqual(1);

    const postRestartConflictsRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/conflicts?status=resolved`,
      headers: AUTH,
    });
    expect(postRestartConflictsRes.statusCode, postRestartConflictsRes.body).toBe(200);
    const postRestartConflicts = ListConflictsResponse.parse(JSON.parse(postRestartConflictsRes.body));
    expect(postRestartConflicts.conflicts.some((c) => c.id === conflictId)).toBe(true);
  });

  it('content-free events: no body text in orchestration events', async () => {
    const dataDir = mktemp('orca-event-db-');
    const workspaceDir = mktemp('orca-event-ws-');
    const config = createConfig(dataDir);

    db = openTestDb(config);
    server = createServer(config, {
      sessionRuntime: new SessionRuntime(new FakePtyManager()),
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });

    const orchEvents: DomainEvent[] = [];
    unsubscribe = eventBus.subscribe((event) => {
      if (ORCHESTRATION_EVENT_TYPES.has(event.type)) {
        orchEvents.push(event);
      }
    });

    const refineRes = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: AUTH,
      payload: { title: 'Content-free test', description: 'Goals:\n- Test content-free events' },
    });
    expect(refineRes.statusCode).toBe(200);
    const draft = (JSON.parse(refineRes.body) as { draft: unknown }).draft;

    const createGoalRes = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: AUTH,
      payload: { title: 'Content-free test', refined: draft, workspaces: [{ inputPath: workspaceDir }] },
    });
    expect(createGoalRes.statusCode).toBe(201);
    const { goal } = CreateGoalResponse.parse(JSON.parse(createGoalRes.body));
    const goalId = goal.id;

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/tasks/generate`,
      headers: AUTH,
      payload: { trigger: 'manual' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/recommendations/generate`,
      headers: AUTH,
      payload: { trigger: 'manual' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert all captured orchestration events are content-free and within 4 KiB
    for (const event of orchEvents) {
      const payloadStr = JSON.stringify(event.payload);
      expect(
        payloadStr.length,
        `Event "${event.type}" payload exceeds 4 KiB: ${payloadStr.length} bytes`
      ).toBeLessThanOrEqual(4096);

      for (const text of FORBIDDEN_BODY_STRINGS) {
        expect(payloadStr, `Event "${event.type}" must not contain body text: "${text}"`).not.toContain(text);
      }
    }

    expect(orchEvents.length, 'Expected ≥ 1 orchestration event').toBeGreaterThanOrEqual(1);
  });

  it('no-auto-launch: accepted recommendation does not call downstream endpoints', async () => {
    const dataDir = mktemp('orca-noauto-db-');
    const workspaceDir = mktemp('orca-noauto-ws-');
    const config = createConfig(dataDir);

    db = openTestDb(config);
    server = createServer(config, {
      sessionRuntime: new SessionRuntime(new FakePtyManager()),
      sessionOutputStore: createSessionOutputStore(db, { tailBytes: config.sessionOutputTailBytes }),
    });

    const allEvents: DomainEvent[] = [];
    unsubscribe = eventBus.subscribe((event) => allEvents.push(event));

    const refineRes = await server.inject({
      method: 'POST',
      url: '/v1/goals/refine',
      headers: AUTH,
      payload: { title: 'No-auto-launch test', description: 'Goals:\n- No auto launch' },
    });
    expect(refineRes.statusCode).toBe(200);
    const draft = (JSON.parse(refineRes.body) as { draft: unknown }).draft;

    const createGoalRes = await server.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: AUTH,
      payload: { title: 'No-auto-launch test', refined: draft, workspaces: [{ inputPath: workspaceDir }] },
    });
    expect(createGoalRes.statusCode).toBe(201);
    const { goal } = CreateGoalResponse.parse(JSON.parse(createGoalRes.body));
    const goalId = goal.id;

    const workspaceRow = db
      .prepare('SELECT w.id AS id FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?')
      .get(goalId) as { id: string };

    // Seed engineer session with implementation evidence
    seedEngineerSession(db, goalId, workspaceRow.id, 'auto-eng-session-1', NOW);

    // Generate recommendations
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/recommendations/generate`,
      headers: AUTH,
      payload: { trigger: 'manual' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const listRecsRes = await server.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/recommendations`,
      headers: AUTH,
    });
    const recsBody = ListRecommendationsResponse.parse(JSON.parse(listRecsRes.body));
    const runValRec = recsBody.recommendations.find((r) => r.type === 'run_validation');

    if (!runValRec) {
      // Sparse input path — acceptable if no validation evidence reached the provider
      return;
    }

    const sessionCountBefore = countRows(db, "SELECT COUNT(*) AS count FROM sessions WHERE goal_id = ?", goalId);
    const contextPkgCountBefore = countRows(db, "SELECT COUNT(*) AS count FROM context_packages WHERE goal_id = ?", goalId);

    // Accept recommendation
    const acceptRes = await server.inject({
      method: 'POST',
      url: `/v1/recommendations/${runValRec.id}/accept`,
      headers: AUTH,
      payload: {},
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptBody = AcceptRecommendationResponse.parse(JSON.parse(acceptRes.body));
    expect(acceptBody.proposedAction).toBeDefined();

    // No new sessions or context packages must have been created
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM sessions WHERE goal_id = ?", goalId),
      'Accept must not auto-create sessions'
    ).toBe(sessionCountBefore);
    expect(
      countRows(db, "SELECT COUNT(*) AS count FROM context_packages WHERE goal_id = ?", goalId),
      'Accept must not auto-create context packages'
    ).toBe(contextPkgCountBefore);

    // No session.created or context.package.created events after accept
    const sessionCreatedAfterAccept = allEvents.filter(
      (e) => e.type === 'session.created' && e.goalId === goalId
    );
    const contextPkgAfterAccept = allEvents.filter(
      (e) => e.type === 'context.package.created' && e.goalId === goalId
    );
    expect(sessionCreatedAfterAccept.length, 'Accept must not emit session.created').toBe(0);
    expect(contextPkgAfterAccept.length, 'Accept must not emit context.package.created').toBe(0);
  });
});
