import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomainEvent, SessionExtractionOutput } from '@orca/contracts';
import { MemoryExtractionCompletedEventPayload } from '@orca/contracts';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  insertSession,
  setSessionStatus,
  resetPreparedStatements as resetSessionStmts,
} from '../sessions/projection.js';
import {
  getExtractionById,
  resetPreparedStatements as resetExtractionStmts,
} from './projection.js';
import {
  enqueueExtraction,
  markExtractionStarted,
  resetPreparedStatements as resetUsecasesStmts,
} from './usecases.js';
import {
  commitExtractionResult,
  commitExtractionFailure,
  resetPreparedStatements,
  ExtractionNotRunningError,
  type CommitCtx,
} from './commit.js';
import { computeContentHash } from '../memory/normalize.js';
import { resetPreparedStatements as resetMemoryStmts } from '../memory/projection.js';
import { resetPreparedStatements as resetDecisionStmts } from '../decisions/projection.js';

const tempDirs: string[] = [];

class SpyBus extends EventBus {
  readonly captured: DomainEvent[] = [];

  override publish(event: DomainEvent): void {
    this.captured.push(event);
    super.publish(event);
  }
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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-commit-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);
}

function seedWorkspace(db: Database.Database, wsId: string, goalId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wsId, '/tmp/ws', 'ws', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, wsId, '2026-01-01T00:00:00.000Z');
}

function seedTerminalSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  wsId: string,
  exitCode: number | null = 0
): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId: wsId,
    adapterId: 'claude-code',
    title: 'test session',
    status: 'exited',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  setSessionStatus(db, sessionId, 'exited', { exitCode, exitedAt: '2026-01-01T01:00:00.000Z' });
}

function makeRunningExtraction(
  db: Database.Database,
  bus: EventBus,
  sessionId: string,
  goalId: string
): string {
  const enqCtx = { db, bus, now: () => NOW };
  const extraction = enqueueExtraction(enqCtx, {
    goalId,
    sessionId,
    trigger: 'goal_open',
    sourceOffsetFirst: 0,
    sourceOffsetLast: 100,
    extractorVersion: 'fake-1.0.0',
  });
  markExtractionStarted(enqCtx, extraction.id);
  return extraction.id;
}

const NOW = '2026-05-01T12:00:00.000Z';
const GOAL_ID = 'goal-commit-1';
const WS_ID = 'ws-commit-1';
const SESSION_ID = 'session-commit-1';
const SOURCE_META = { sourceOffsetFirst: 0, sourceOffsetLast: 100 };

let db: Database.Database;
let bus: SpyBus;
let ctx: CommitCtx;

beforeEach(() => {
  db = openTestDb();
  bus = new SpyBus();
  ctx = { db, bus, now: () => NOW };
  seedGoal(db, GOAL_ID);
  seedWorkspace(db, WS_ID, GOAL_ID);
  seedTerminalSession(db, SESSION_ID, GOAL_ID, WS_ID, 0);
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetExtractionStmts();
  resetUsecasesStmts();
  resetSessionStmts();
  resetMemoryStmts();
  resetDecisionStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('commitExtractionResult — successful commit', () => {
  it('inserts summary, memory, decisions, and updates extraction atomically', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      summary: {
        headline: 'Tests passed',
        text: 'All 42 tests passed successfully.',
        truncated: false,
      },
      memoryCandidates: [
        { type: 'validation_result', content: 'All tests passed', confidence: 0.9, promoteEligible: false },
        { type: 'note', content: 'Some observation', confidence: 0.5, promoteEligible: false },
      ],
      decisionCandidates: [
        { title: 'Use TypeScript', decisionText: 'DECISION: Use TypeScript strict mode', confirmationRequired: true },
      ],
    };

    const stats = commitExtractionResult(ctx, extractionId, output, SOURCE_META);

    expect(stats.insertedMemoryCount).toBe(2);
    expect(stats.duplicateMemoryCount).toBe(0);
    expect(stats.insertedDecisionCount).toBe(1);
    // validation_result with 0.9 confidence on clean exit (exitCode=0) auto-promotes
    expect(stats.promotedCount).toBe(1);

    const extraction = getExtractionById(db, extractionId)!;
    expect(extraction.status).toBe('succeeded');
    expect(extraction.itemCount).toBe(2); // total candidates presented
    expect(extraction.decisionCount).toBe(1);
    expect(extraction.promotedCount).toBe(1);
    expect(extraction.summaryId).not.toBeNull();
    expect(extraction.finishedAt).toBe(NOW);
    expect(extraction.sourceOffsetFirst).toBe(SOURCE_META.sourceOffsetFirst);
    expect(extraction.sourceOffsetLast).toBe(SOURCE_META.sourceOffsetLast);

    // Verify memory rows
    const memRows = db
      .prepare(
        `SELECT type, status, source_session_id, source_extraction_id
         FROM goal_memory_items WHERE goal_id = ? ORDER BY type`
      )
      .all(GOAL_ID) as { type: string; status: string; source_session_id: string; source_extraction_id: string }[];
    expect(memRows).toHaveLength(2);
    const promoted = memRows.find((r) => r.type === 'validation_result')!;
    expect(promoted.status).toBe('promoted');
    expect(promoted.source_session_id).toBe(SESSION_ID);
    expect(promoted.source_extraction_id).toBe(extractionId);

    // Verify decision row
    const decRows = db
      .prepare(`SELECT status, source_session_id FROM goal_decisions WHERE goal_id = ?`)
      .all(GOAL_ID) as { status: string; source_session_id: string }[];
    expect(decRows).toHaveLength(1);
    expect(decRows[0].status).toBe('proposed');
    expect(decRows[0].source_session_id).toBe(SESSION_ID);

    // Verify summary
    const summaryRow = db
      .prepare(`SELECT headline FROM session_summaries WHERE session_id = ?`)
      .get(SESSION_ID) as { headline: string } | undefined;
    expect(summaryRow?.headline).toBe('Tests passed');
  });

  it('emits events in order: item.created, item.promoted, decision.created, extraction.completed', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      summary: { headline: 'Done', text: 'Done', truncated: false },
      memoryCandidates: [
        { type: 'validation_result', content: 'tests ok', confidence: 0.95, promoteEligible: false },
      ],
      decisionCandidates: [
        { title: 'Choose DB', decisionText: 'DECISION: Use SQLite', confirmationRequired: true },
      ],
    };

    commitExtractionResult(ctx, extractionId, output, SOURCE_META);

    const types = bus.captured.map((e) => e.type);
    expect(types).toContain('memory.item.created');
    expect(types).toContain('memory.item.promoted');
    expect(types).toContain('decision.created');
    expect(types).toContain('memory.extraction.completed');
    expect(types[types.length - 1]).toBe('memory.extraction.completed');
  });

  it('memory.extraction.completed payload matches contract schema and is content-free', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      summary: { headline: 'Done', text: 'Done', truncated: false },
      memoryCandidates: [],
      decisionCandidates: [],
    };

    commitExtractionResult(ctx, extractionId, output, SOURCE_META);

    const completedEvent = bus.captured.find((e) => e.type === 'memory.extraction.completed')!;
    expect(completedEvent).toBeDefined();

    const parsed = MemoryExtractionCompletedEventPayload.safeParse(completedEvent.payload);
    expect(parsed.success).toBe(true);

    const payloadKeys = Object.keys(completedEvent.payload);
    expect(payloadKeys).not.toContain('content');
    expect(payloadKeys).not.toContain('summaryText');
    expect(payloadKeys).not.toContain('decisionText');
    expect(payloadKeys).not.toContain('rationale');
  });

  it('broadcasts events only after commit — extraction row is succeeded when first event fires', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const statusAtPublish: string[] = [];
    const observingBus = new class extends EventBus {
      override publish(event: DomainEvent): void {
        const row = getExtractionById(db, extractionId);
        statusAtPublish.push(row?.status ?? 'unknown');
        super.publish(event);
      }
    }();

    const observingCtx: CommitCtx = { db, bus: observingBus, now: () => NOW };
    const output: SessionExtractionOutput = {
      summary: { headline: 'h', text: 't', truncated: false },
      memoryCandidates: [],
      decisionCandidates: [],
    };

    commitExtractionResult(observingCtx, extractionId, output, SOURCE_META);

    // Every event was published after commit, so extraction is already 'succeeded'
    expect(statusAtPublish.length).toBeGreaterThan(0);
    for (const status of statusAtPublish) {
      expect(status).toBe('succeeded');
    }
  });

  it('works when output has no summary', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      memoryCandidates: [],
      decisionCandidates: [],
    };

    const stats = commitExtractionResult(ctx, extractionId, output, SOURCE_META);
    expect(stats.insertedMemoryCount).toBe(0);

    const extraction = getExtractionById(db, extractionId)!;
    expect(extraction.status).toBe('succeeded');
    expect(extraction.summaryId).toBeNull();

    const sumCount = (
      db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as { c: number }
    ).c;
    expect(sumCount).toBe(0);
  });
});

describe('commitExtractionResult — rollback on failure', () => {
  it('throws ExtractionNotRunningError when extraction is not running', () => {
    // Enqueue without starting — leaves it in 'pending' state
    const enqCtx = { db, bus, now: () => NOW };
    const extraction = enqueueExtraction(enqCtx, {
      goalId: GOAL_ID,
      sessionId: SESSION_ID,
      trigger: 'goal_open',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 100,
      extractorVersion: 'fake-1.0.0',
    });
    bus.captured.length = 0;

    expect(() =>
      commitExtractionResult(ctx, extraction.id, { memoryCandidates: [], decisionCandidates: [] }, SOURCE_META)
    ).toThrow(ExtractionNotRunningError);

    expect(bus.captured).toHaveLength(0);
    expect(getExtractionById(db, extraction.id)?.status).toBe('pending');
  });

  it('throws and writes nothing when extraction id does not exist', () => {
    bus.captured.length = 0;

    expect(() =>
      commitExtractionResult(ctx, 'nonexistent-id', { memoryCandidates: [], decisionCandidates: [] }, SOURCE_META)
    ).toThrow();

    const memCount = (db.prepare('SELECT COUNT(*) as c FROM goal_memory_items').get() as { c: number }).c;
    expect(memCount).toBe(0);
    expect(bus.captured).toHaveLength(0);
  });
});

describe('commitExtractionResult — duplicate memory candidates', () => {
  it('skips duplicate candidates; extraction still succeeds and itemCount reflects total', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    // Pre-seed a matching row
    const contentHash = computeContentHash({ type: 'blocker', content: 'DB connection failed' });
    db.prepare(
      `INSERT INTO goal_memory_items
         (id, goal_id, type, status, content, content_hash, confidence, source_type,
          source_id, source_session_id, source_extraction_id, source_offset_first, source_offset_last,
          created_at, updated_at, promoted_at, archived_at)
       VALUES ('pre-seed-1', ?, 'blocker', 'candidate', 'DB connection failed', ?, null, 'manual',
               null, null, null, null, null, ?, ?, null, null)`
    ).run(GOAL_ID, contentHash, NOW, NOW);

    const output: SessionExtractionOutput = {
      memoryCandidates: [
        { type: 'blocker', content: 'DB connection failed', confidence: 0.8, promoteEligible: false }, // duplicate
        { type: 'note', content: 'New unique note', confidence: 0.5, promoteEligible: false },
      ],
      decisionCandidates: [],
    };

    const stats = commitExtractionResult(ctx, extractionId, output, SOURCE_META);

    expect(stats.duplicateMemoryCount).toBe(1);
    expect(stats.insertedMemoryCount).toBe(1);

    const extraction = getExtractionById(db, extractionId)!;
    expect(extraction.status).toBe('succeeded');
    expect(extraction.itemCount).toBe(2); // total candidates = inserted + duplicate

    const memCount = (
      db.prepare('SELECT COUNT(*) as c FROM goal_memory_items WHERE goal_id = ?').get(GOAL_ID) as { c: number }
    ).c;
    expect(memCount).toBe(2); // pre-seed + 1 new
  });
});

describe('commitExtractionResult — auto-promotion rules', () => {
  it('auto-promotes high-confidence blocker when session had non-zero exit code', () => {
    // Seed a session with exit code 1
    seedTerminalSession(db, 'session-exit1', GOAL_ID, WS_ID, 1);
    const extractionId = makeRunningExtraction(db, bus, 'session-exit1', GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      memoryCandidates: [
        { type: 'blocker', content: 'Critical failure', confidence: 0.95, promoteEligible: false },
        { type: 'note', content: 'Just a note', confidence: 0.5, promoteEligible: false },
      ],
      decisionCandidates: [],
    };

    const stats = commitExtractionResult(ctx, extractionId, output, SOURCE_META);
    expect(stats.promotedCount).toBe(1);

    const promoted = db
      .prepare(`SELECT type FROM goal_memory_items WHERE goal_id = ? AND status = 'promoted'`)
      .all(GOAL_ID) as { type: string }[];
    expect(promoted).toHaveLength(1);
    expect(promoted[0].type).toBe('blocker');
  });

  it('does not auto-promote a generic note candidate', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      memoryCandidates: [
        { type: 'note', content: 'Just a note', confidence: 1.0, promoteEligible: false },
      ],
      decisionCandidates: [],
    };

    const stats = commitExtractionResult(ctx, extractionId, output, SOURCE_META);
    expect(stats.promotedCount).toBe(0);

    const memRow = db
      .prepare(`SELECT status FROM goal_memory_items WHERE goal_id = ?`)
      .get(GOAL_ID) as { status: string } | undefined;
    expect(memRow?.status).toBe('candidate');
  });

  it('emits memory.item.promoted event for auto-promoted items', () => {
    // Session with non-zero exit code
    seedTerminalSession(db, 'session-nonzero', GOAL_ID, WS_ID, 2);
    const extractionId = makeRunningExtraction(db, bus, 'session-nonzero', GOAL_ID);
    bus.captured.length = 0;

    const output: SessionExtractionOutput = {
      memoryCandidates: [
        { type: 'blocker', content: 'Build failed hard', confidence: 0.92, promoteEligible: false },
      ],
      decisionCandidates: [],
    };

    commitExtractionResult(ctx, extractionId, output, SOURCE_META);

    const promotedEvent = bus.captured.find((e) => e.type === 'memory.item.promoted');
    expect(promotedEvent).toBeDefined();
    expect(promotedEvent!.payload.type).toBe('blocker');
  });
});

describe('commitExtractionFailure', () => {
  it('emits only memory.extraction.failed and writes no memory/decision/summary rows', () => {
    const extractionId = makeRunningExtraction(db, bus, SESSION_ID, GOAL_ID);
    bus.captured.length = 0;

    commitExtractionFailure(ctx, extractionId, {
      failureCode: 'invalid_output',
      failureMessage: 'Extractor returned invalid schema',
    });

    const types = bus.captured.map((e) => e.type);
    expect(types).toEqual(['memory.extraction.failed']);

    const extraction = getExtractionById(db, extractionId)!;
    expect(extraction.status).toBe('failed');
    expect(extraction.failureCode).toBe('invalid_output');
    expect(extraction.failureMessage).toBe('Extractor returned invalid schema');

    const memCount = (db.prepare('SELECT COUNT(*) as c FROM goal_memory_items').get() as { c: number }).c;
    const decCount = (db.prepare('SELECT COUNT(*) as c FROM goal_decisions').get() as { c: number }).c;
    const sumCount = (db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as { c: number }).c;
    expect(memCount).toBe(0);
    expect(decCount).toBe(0);
    expect(sumCount).toBe(0);
  });
});
