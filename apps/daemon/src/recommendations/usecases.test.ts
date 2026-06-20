import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { EventBus } from '../events.js';
import {
  acceptRecommendation,
  rejectRecommendation,
  dismissRecommendation,
  modifyRecommendation,
  supersedeRecommendation,
  insertPendingRecommendationGeneration,
  markRecommendationGenerationRunningUseCase,
  markRecommendationGenerationSucceededUseCase,
  markRecommendationGenerationFailedUseCase,
  getRecommendationById,
  RecommendationNotFoundError,
  InvalidRecommendationStatusError,
  resetPreparedStatements,
  insertRecommendation,
  runRecommendationGeneration,
  type RecommendationCtx,
} from './usecases.js';
import { getFeedbackByRecommendationId } from './feedback.js';
import { recommendationFingerprint } from './fingerprint.js';
import { FakeRecommendationProvider } from './provider.js';

const tempDirs: string[] = [];
const NOW = '2026-01-01T00:00:00.000Z';
const PROPOSED_ACTION_JSON = JSON.stringify({ kind: 'ask_user', question: 'Proceed?' });
const PROPOSED_ACTION_2_JSON = JSON.stringify({ kind: 'ask_user', question: 'Why?' });

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-rec-uc-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  const now = NOW;
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, now, now);
}

function seedRec(db: Database.Database, opts: {
  id?: string;
  goalId: string;
  type?: string;
  status?: string;
  proposedActionJson?: string;
  fingerprint?: string;
  workflowStepRunId?: string | null;
}) {
  const id = opts.id ?? 'rec-1';
  const goalId = opts.goalId;
  const type = opts.type ?? 'ask_user';
  const paJson = opts.proposedActionJson ?? PROPOSED_ACTION_JSON;
  const fp = opts.fingerprint ?? recommendationFingerprint(goalId, type, paJson);
  insertRecommendation(db, {
    id,
    goalId,
    generationId: null,
    type,
    status: opts.status ?? 'proposed',
    source: 'deterministic_provider',
    title: 'Test',
    rationale: 'Test',
    proposedActionJson: paJson,
    confidence: 0.8,
    sourcesJson: '[]',
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPkgId: null,
    relatedConflictId: null,
    fingerprint: fp,
    supersededById: null,
    workflowStepRunId: opts.workflowStepRunId ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedWorkflow(db: Database.Database, goalId: string, opts?: {
  finalStep?: boolean;
  outstanding?: string[];
  currentStepId?: string;
}): void {
  const currentStepId = opts?.currentStepId ?? 'execution';
  const steps = opts?.finalStep
    ? [
        {
          id: currentStepId,
          ordinal: 0,
          name: 'Done',
          instructions: 'Finalize the work.',
          outputSchema: [{ key: 'result', type: 'string', required: true }],
          agentPreference: [{ adapterId: 'claude-code', modelId: 'claude-haiku-4-5' }],
        },
      ]
    : [
        {
          id: currentStepId,
          ordinal: 0,
          name: 'Execution',
          instructions: 'Implement the plan.',
          outputSchema: [{ key: 'result', type: 'string', required: true }],
          agentPreference: [{ adapterId: 'claude-code', modelId: 'claude-haiku-4-5' }],
        },
        {
          id: 'qa',
          ordinal: 1,
          name: 'QA',
          instructions: 'Validate the implementation.',
          outputSchema: [{ key: 'result', type: 'string', required: true }],
          agentPreference: [{ adapterId: 'claude-code', modelId: 'claude-haiku-4-5' }],
        },
      ];
  db.prepare(
    `INSERT INTO workflow_templates
      (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, ?, '[]', ?, ?)`
  ).run(JSON.stringify(steps), NOW, NOW);
  db.prepare(
    `INSERT INTO workflow_runs
      (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at)
     VALUES ('run-1', ?, 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)`
  ).run(goalId, NOW);
  db.prepare(
    `INSERT INTO workflow_step_runs
      (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
     VALUES ('step-1', ?, 'run-1', ?, 0, 1, 'active', '[]', ?, NULL, ?, NULL, 'fp-1')`
  ).run(goalId, currentStepId, JSON.stringify(opts?.outstanding ?? []), NOW);
}

let bus: EventBus;
let published: DomainEvent[];
let counter = 0;

beforeEach(() => {
  bus = new EventBus();
  published = [];
  counter = 0;
  bus.subscribe((ev) => published.push(ev));
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCtx(db: Database.Database, overrides?: Partial<RecommendationCtx>): RecommendationCtx {
  return {
    db,
    bus,
    now: () => NOW,
    idFactory: () => `id-${++counter}`,
    ...overrides,
  };
}

// ── accept ────────────────────────────────────────────────────────────────────

describe('acceptRecommendation', () => {
  it('accepts a proposed recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });

    const result = acceptRecommendation(makeCtx(db), 'rec-1');
    expect(result.alreadyAccepted).toBe(false);
    expect(result.recommendation.status).toBe('accepted');
    expect(result.feedback.action).toBe('accept');
  });

  it('accepts a modified recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'modified' });
    const result = acceptRecommendation(makeCtx(db), 'rec-1');
    expect(result.recommendation.status).toBe('accepted');
  });

  it('emits recommendation.accepted and user.feedback.recorded in same TX', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });

    acceptRecommendation(makeCtx(db), 'rec-1');

    const types = published.map((e) => e.type);
    expect(types).toContain('recommendation.accepted');
    expect(types).toContain('user.feedback.recorded');
  });

  it('event payload contains only ids/type (no rationale/proposedAction body)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    acceptRecommendation(makeCtx(db), 'rec-1');

    const ev = published.find((e) => e.type === 'recommendation.accepted');
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('recommendationId');
    expect(payload).toHaveProperty('goalId');
    expect(payload).toHaveProperty('type');
    expect(payload).not.toHaveProperty('rationale');
    expect(payload).not.toHaveProperty('proposedAction');
    expect(payload).not.toHaveProperty('title');
  });

  it('event payload ≤ 4 KiB', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    acceptRecommendation(makeCtx(db), 'rec-1');
    for (const ev of published) {
      expect(Buffer.byteLength(JSON.stringify(ev.payload), 'utf8')).toBeLessThanOrEqual(4096);
    }
  });

  it('idempotent: repeated accept returns alreadyAccepted=true, no new events', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });

    acceptRecommendation(makeCtx(db), 'rec-1');
    const countAfterFirst = published.length;

    const result = acceptRecommendation(makeCtx(db), 'rec-1');
    expect(result.alreadyAccepted).toBe(true);
    expect(published.length).toBe(countAfterFirst);
  });

  it('throws RecommendationNotFoundError for unknown id', () => {
    const db = freshDb();
    expect(() => acceptRecommendation(makeCtx(db), 'nope')).toThrow(RecommendationNotFoundError);
  });

  it('throws InvalidRecommendationStatusError for rejected recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'rejected' });
    expect(() => acceptRecommendation(makeCtx(db), 'rec-1')).toThrow(InvalidRecommendationStatusError);
  });

  it('accepting advance_workflow_step advances the workflow step run', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkflow(db, 'g1', { finalStep: false, outstanding: [] });
    seedRec(db, {
      goalId: 'g1',
      type: 'advance_workflow_step',
      workflowStepRunId: 'step-1',
      proposedActionJson: JSON.stringify({
        kind: 'advance_workflow_step',
        workflowRunId: 'run-1',
        workflowStepRunId: 'step-1',
        toStepTemplateId: 'qa',
      }),
    });

    acceptRecommendation(makeCtx(db), 'rec-1');

    const run = db
      .prepare("SELECT current_step_run_id, status FROM workflow_runs WHERE id='run-1'")
      .get() as { current_step_run_id: string | null; status: string };
    expect(run.status).toBe('active');
    expect(run.current_step_run_id).not.toBe('step-1');
    const currentStep = db
      .prepare('SELECT status FROM workflow_step_runs WHERE id = ?')
      .get(run.current_step_run_id) as { status: string };
    expect(currentStep.status).toBe('active');
  });

  it('accepting complete_workflow_run completes the final step and run', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedWorkflow(db, 'g1', { finalStep: true, outstanding: [] });
    seedRec(db, {
      goalId: 'g1',
      type: 'complete_workflow_run',
      workflowStepRunId: 'step-1',
      proposedActionJson: JSON.stringify({
        kind: 'complete_workflow_run',
        workflowRunId: 'run-1',
        workflowStepRunId: 'step-1',
      }),
    });

    acceptRecommendation(makeCtx(db), 'rec-1');

    const run = db
      .prepare("SELECT status, current_step_run_id FROM workflow_runs WHERE id='run-1'")
      .get() as { status: string; current_step_run_id: string | null };
    expect(run.status).toBe('completed');
    expect(run.current_step_run_id).toBeNull();
    const step = db
      .prepare("SELECT status FROM workflow_step_runs WHERE id='step-1'")
      .get() as { status: string };
    expect(step.status).toBe('passed');
  });

  // DELETED: 'accepting mark_artifact_satisfied records matching exit criteria'.
  // Exit criteria were removed in the instruction-driven redesign (Task 9); the step-run
  // satisfied/outstanding exit-criteria recording no longer exists. The instruction-driven
  // step output validation is covered by service.skill-step.test.ts and the output-schema
  // validator tests in @orca/contracts.
});

// ── reject ────────────────────────────────────────────────────────────────────

describe('rejectRecommendation', () => {
  it('rejects a proposed recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    const result = rejectRecommendation(makeCtx(db), 'rec-1');
    expect(result.recommendation.status).toBe('rejected');
    expect(result.feedback.action).toBe('reject');
  });

  it('emits recommendation.rejected and user.feedback.recorded', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    rejectRecommendation(makeCtx(db), 'rec-1');
    expect(published.map((e) => e.type)).toContain('recommendation.rejected');
    expect(published.map((e) => e.type)).toContain('user.feedback.recorded');
  });

  it('idempotent: repeated reject returns alreadyRejected=true, no new events', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    rejectRecommendation(makeCtx(db), 'rec-1');
    const count = published.length;
    const result = rejectRecommendation(makeCtx(db), 'rec-1');
    expect(result.alreadyRejected).toBe(true);
    expect(published.length).toBe(count);
  });

  it('terminal-action one-shot: second reject inserts no new DB feedback row', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    rejectRecommendation(makeCtx(db), 'rec-1');
    rejectRecommendation(makeCtx(db), 'rec-1');
    const fbs = getFeedbackByRecommendationId(db, 'rec-1');
    expect(fbs.filter((f) => f.action === 'reject')).toHaveLength(1);
  });
});

// ── dismiss ───────────────────────────────────────────────────────────────────

describe('dismissRecommendation', () => {
  it('dismisses a proposed recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    const result = dismissRecommendation(makeCtx(db), 'rec-1');
    expect(result.recommendation.status).toBe('dismissed');
    expect(result.feedback.action).toBe('dismiss');
  });

  it('dismisses a modified recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'modified' });
    const result = dismissRecommendation(makeCtx(db), 'rec-1');
    expect(result.recommendation.status).toBe('dismissed');
  });

  it('emits recommendation.dismissed and user.feedback.recorded', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    dismissRecommendation(makeCtx(db), 'rec-1');
    expect(published.map((e) => e.type)).toContain('recommendation.dismissed');
    expect(published.map((e) => e.type)).toContain('user.feedback.recorded');
  });

  it('idempotent: repeated dismiss returns alreadyDismissed=true', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    dismissRecommendation(makeCtx(db), 'rec-1');
    const count = published.length;
    const result = dismissRecommendation(makeCtx(db), 'rec-1');
    expect(result.alreadyDismissed).toBe(true);
    expect(published.length).toBe(count);
  });
});

// ── modify ────────────────────────────────────────────────────────────────────

describe('modifyRecommendation', () => {
  it('modifies title on a proposed recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    const result = modifyRecommendation(makeCtx(db), 'rec-1', { title: 'New title' });
    expect(result.recommendation.status).toBe('modified');
    expect(result.recommendation.source).toBe('user_modified');
    expect(result.recommendation.title).toBe('New title');
    expect(result.feedback.action).toBe('modify');
  });

  it('captures pre-modify snapshot in modified_payload_json', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', proposedActionJson: PROPOSED_ACTION_JSON });
    modifyRecommendation(makeCtx(db), 'rec-1', {
      proposedAction: { kind: 'ask_user', question: 'Why?' },
    });
    const fbs = getFeedbackByRecommendationId(db, 'rec-1');
    expect(fbs).toHaveLength(1);
    expect(fbs[0].modifiedPayloadJson).toBe(PROPOSED_ACTION_JSON);
  });

  it('allows subsequent accept after modify', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'Changed' });
    const result = acceptRecommendation(makeCtx(db), 'rec-1');
    expect(result.recommendation.status).toBe('accepted');
    expect(result.alreadyAccepted).toBe(false);
  });

  it('allows multiple modifies (no unique constraint violation)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'Title 2' });
    expect(() =>
      modifyRecommendation(makeCtx(db), 'rec-1', { title: 'Title 3' })
    ).not.toThrow();
    const fbs = getFeedbackByRecommendationId(db, 'rec-1');
    expect(fbs.filter((f) => f.action === 'modify')).toHaveLength(2);
  });

  it('emits recommendation.modified with changedFields (no content)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'New' });
    const ev = published.find((e) => e.type === 'recommendation.modified');
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('changedFields');
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('rationale');
  });

  it('changedFields includes status/source on first modify', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'New' });
    const ev = published.find((e) => e.type === 'recommendation.modified');
    const fields = (ev!.payload as { changedFields: string[] }).changedFields;
    expect(fields).toContain('status');
    expect(fields).toContain('source');
    expect(fields).toContain('title');
  });

  it('changedFields does not include status/source on second modify', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'New' });
    published.length = 0;
    modifyRecommendation(makeCtx(db), 'rec-1', { title: 'Newer' });
    const ev = published.find((e) => e.type === 'recommendation.modified');
    const fields = (ev!.payload as { changedFields: string[] }).changedFields;
    expect(fields).not.toContain('status');
    expect(fields).not.toContain('source');
    expect(fields).toContain('title');
  });

  it('throws InvalidRecommendationStatusError for accepted recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'accepted' });
    expect(() => modifyRecommendation(makeCtx(db), 'rec-1', { title: 'X' })).toThrow(InvalidRecommendationStatusError);
  });

  it('throws InvalidRecommendationStatusError for superseded recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'superseded' });
    expect(() => modifyRecommendation(makeCtx(db), 'rec-1', { title: 'X' })).toThrow(InvalidRecommendationStatusError);
  });

  it('atomicity: row unchanged if TX fails', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    // Force a mid-TX failure by making the event insert fail
    const origPrepare = db.prepare.bind(db);
    let callCount = 0;
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO events') && ++callCount === 1) {
        return {
          ...stmt,
          run: (..._args: unknown[]) => {
            throw new Error('simulated event insert failure');
          },
        } as unknown as ReturnType<Database.Database['prepare']>;
      }
      return stmt;
    });

    expect(() => modifyRecommendation(makeCtx(db), 'rec-1', { title: 'New' })).toThrow('simulated event insert failure');
    const rec = getRecommendationById(db, 'rec-1');
    expect(rec!.title).toBe('Test');
    expect(rec!.status).toBe('proposed');
  });
});

// ── supersede ─────────────────────────────────────────────────────────────────

describe('supersedeRecommendation', () => {
  it('supersedes a proposed recommendation', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    const result = supersedeRecommendation(makeCtx(db), 'rec-1', null, 'duplicate');
    expect(result.recommendation.status).toBe('superseded');
  });

  it('emits recommendation.superseded with ids/reason (no content)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', id: 'rec-1' });
    seedRec(db, {
      goalId: 'g1',
      id: 'rec-new',
      fingerprint: recommendationFingerprint('g1', 'ask_user', PROPOSED_ACTION_2_JSON),
      proposedActionJson: PROPOSED_ACTION_2_JSON,
    });
    supersedeRecommendation(makeCtx(db), 'rec-1', 'rec-new', 'duplicate');
    const ev = published.find((e) => e.type === 'recommendation.superseded');
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('recommendationId');
    expect(payload).toHaveProperty('bySupersedingId', 'rec-new');
    expect(payload).toHaveProperty('reason', 'duplicate');
    expect(payload).not.toHaveProperty('rationale');
    expect(payload).not.toHaveProperty('title');
  });

  it('preserves prior audit history (accept after supersede not possible but feedback remains)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    // Modify it first (creates a modify feedback)
    // But supersede requires status = 'proposed', so we do supersede on fresh proposed rec
    supersedeRecommendation(makeCtx(db), 'rec-1', null, 'manual');
    expect(getRecommendationById(db, 'rec-1')!.status).toBe('superseded');
    // Reject attempt should fail (not proposed)
    expect(() => rejectRecommendation(makeCtx(db), 'rec-1')).toThrow(InvalidRecommendationStatusError);
  });

  it('throws InvalidRecommendationStatusError if status is not proposed', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1', status: 'modified' });
    expect(() => supersedeRecommendation(makeCtx(db), 'rec-1', null, 'duplicate')).toThrow(InvalidRecommendationStatusError);
  });

  it('accepts bySupersedingId=null', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    seedRec(db, { goalId: 'g1' });
    const result = supersedeRecommendation(makeCtx(db), 'rec-1', null, 'source_archived');
    expect(result.recommendation.status).toBe('superseded');
    const ev = published.find((e) => e.type === 'recommendation.superseded');
    expect((ev!.payload as { bySupersedingId: unknown }).bySupersedingId).toBeNull();
  });
});

// ── Generation lifecycle ──────────────────────────────────────────────────────

describe('recommendation generation lifecycle', () => {
  it('inserts pending generation and emits recommendation.generation.requested', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const { generation, isNew } = insertPendingRecommendationGeneration(ctx, {
      goalId: 'g1',
      trigger: 'manual',
      triggerSourceId: null,
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      inputFingerprint: 'fp1',
    });
    expect(isNew).toBe(true);
    expect(generation.status).toBe('pending');
    expect(published.map((e) => e.type)).toContain('recommendation.generation.requested');
  });

  it('returns existing on duplicate (isNew=false, no extra event)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const input = { goalId: 'g1', trigger: 'manual' as const, triggerSourceId: null, providerId: 'p', providerVersion: '1', inputFingerprint: 'fp' };
    insertPendingRecommendationGeneration(ctx, input);
    const count = published.length;
    const { isNew } = insertPendingRecommendationGeneration(ctx, input);
    expect(isNew).toBe(false);
    expect(published.length).toBe(count);
  });

  it('succeeded generation emits recommendation.generated with ids/count/sparse', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const { generation } = insertPendingRecommendationGeneration(ctx, {
      goalId: 'g1', trigger: 'manual', triggerSourceId: null, providerId: 'p', providerVersion: '1', inputFingerprint: 'fp',
    });
    markRecommendationGenerationRunningUseCase(ctx, generation.id);
    markRecommendationGenerationSucceededUseCase(ctx, generation.id, ['r1', 'r2'], ['r0'], false);
    const ev = published.find((e) => e.type === 'recommendation.generated');
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('recommendationIds');
    expect(payload).toHaveProperty('supersededIds');
    expect(payload).toHaveProperty('count', 2);
    expect(payload).toHaveProperty('sparse', false);
    expect(payload).not.toHaveProperty('rationale');
  });

  it('failed generation emits recommendation.generation.failed with failureCode only', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const { generation } = insertPendingRecommendationGeneration(ctx, {
      goalId: 'g1', trigger: 'manual', triggerSourceId: null, providerId: 'p', providerVersion: '1', inputFingerprint: 'fp',
    });
    markRecommendationGenerationFailedUseCase(ctx, generation.id, 'provider_error', 'something bad');
    const ev = published.find((e) => e.type === 'recommendation.generation.failed');
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('failureCode', 'provider_error');
    expect(payload).not.toHaveProperty('failureMessage');
  });

  it('failed row excluded from idempotency (retry creates new row)', () => {
    const db = freshDb();
    seedGoal(db, 'g1');
    const ctx = makeCtx(db);
    const input = { goalId: 'g1', trigger: 'manual' as const, triggerSourceId: null, providerId: 'p', providerVersion: '1', inputFingerprint: 'fp' };
    const { generation } = insertPendingRecommendationGeneration(ctx, input);
    markRecommendationGenerationFailedUseCase(ctx, generation.id, 'internal_error', null);
    const { isNew, generation: retry } = insertPendingRecommendationGeneration(ctx, input);
    expect(isNew).toBe(true);
    expect(retry.id).not.toBe(generation.id);
  });

  it('rolls back generated recommendations if the generation success event cannot commit', async () => {
    const db = freshDb();
    seedGoal(db, 'g1');

    const provider = new FakeRecommendationProvider();
    provider.setFixtures([
      {
        type: 'ask_user',
        title: 'Ask for input',
        rationale: 'Need human input.',
        proposedAction: { kind: 'ask_user', question: 'Proceed?' },
        confidence: 0.8,
        sources: [{ type: 'goal', id: 'g1', reason: 'sparse_input' }],
      },
    ]);

    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO events')) {
        const origRun = stmt.run.bind(stmt);
        vi.spyOn(stmt, 'run').mockImplementation((...args: unknown[]) => {
          if (args[1] === 'recommendation.generated') {
            throw new Error('simulated recommendation.generated insert failure');
          }
          return origRun(...args);
        });
      }
      return stmt;
    });
    resetPreparedStatements();

    const generation = await runRecommendationGeneration(
      {
        ...makeCtx(db),
        recommendationProvider: provider,
      },
      {
        goalId: 'g1',
        trigger: 'manual',
        triggerSourceId: null,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = db
      .prepare('SELECT status, failure_code FROM recommendation_generations WHERE id = ?')
      .get(generation.id) as { status: string; failure_code: string | null };
    expect(row.status).toBe('failed');

    const recCount = (
      db.prepare('SELECT count(*) AS cnt FROM recommendations WHERE goal_id = ?').get('g1') as { cnt: number }
    ).cnt;
    expect(recCount).toBe(0);
  });
});
