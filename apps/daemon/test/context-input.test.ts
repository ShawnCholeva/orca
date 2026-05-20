import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import {
  buildContextAssemblyInput,
  resetPreparedStatements as resetInputStatements,
} from '../src/context/input.js';
import { GoalNotFoundError } from '../src/sessions/errors.js';
import { resetPreparedStatements as resetRefinementStatements } from '../src/goal-refinements.js';
import { resetPreparedStatements as resetWorkspaceStatements } from '../src/workspaces/projection.js';
import { resetPreparedStatements as resetMemoryStatements } from '../src/memory/projection.js';
import { resetPreparedStatements as resetDecisionStatements } from '../src/decisions/projection.js';

const ASSEMBLER_VERSION = '0.1.0-test';

const tempDirs: string[] = [];

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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-input-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

afterEach(() => {
  resetInputStatements();
  resetRefinementStatements();
  resetWorkspaceStatements();
  resetMemoryStatements();
  resetDecisionStatements();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = '2026-01-01T00:00:00.000Z';

function seedGoal(
  db: Database.Database,
  goalId: string,
  options: { archived?: boolean } = {}
): void {
  const archivedAt = options.archived ? NOW : null;
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', 'desc', ?, 1, ?, ?, ?)`
  ).run(goalId, options.archived ? 'archived' : 'active', NOW, NOW, archivedAt);
}

function seedRefinement(db: Database.Database, goalId: string): void {
  db.prepare(
    `INSERT INTO goal_refinements (goal_id, skill_id, success_criteria, constraints, assumptions, refined_at)
     VALUES (?, 'guided-goal-refinement', '["pass tests"]', '["no side effects"]', '[]', ?)`
  ).run(goalId, NOW);
}

function seedWorkspace(db: Database.Database, goalId: string, wsId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, '/repo', 'my-repo', 'repo', 'main', 0, 'ok', ?)`
  ).run(wsId, goalId, NOW);
}

function seedMemoryItem(
  db: Database.Database,
  goalId: string,
  id: string,
  options: {
    content?: string;
    status?: string;
    type?: string;
    updatedAt?: string;
    archivedAt?: string | null;
  } = {}
): void {
  const content = options.content ?? 'some memory content';
  const status = options.status ?? 'promoted';
  const type = options.type ?? 'constraint';
  const updatedAt = options.updatedAt ?? NOW;
  const archivedAt = options.archivedAt ?? null;
  const contentHash = Buffer.from(type + content).toString('hex').slice(0, 64);
  db.prepare(
    `INSERT INTO goal_memory_items
       (id, goal_id, type, status, content, content_hash, confidence, source_type,
        source_id, source_session_id, source_extraction_id, source_offset_first,
        source_offset_last, created_at, updated_at, promoted_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'manual', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`
  ).run(id, goalId, type, status, content, contentHash, NOW, updatedAt, archivedAt);
}

function seedDecision(
  db: Database.Database,
  goalId: string,
  id: string,
  options: {
    title?: string;
    decisionText?: string;
    status?: string;
    confirmationRequired?: number;
    archivedAt?: string | null;
    updatedAt?: string;
  } = {}
): void {
  const title = options.title ?? 'Use TypeScript';
  const decisionText = options.decisionText ?? 'We use TypeScript for type safety.';
  const status = options.status ?? 'proposed';
  const confirmationRequired = options.confirmationRequired ?? 0;
  const archivedAt = options.archivedAt ?? null;
  const updatedAt = options.updatedAt ?? NOW;
  db.prepare(
    `INSERT INTO goal_decisions
       (id, goal_id, title, decision_text, rationale, status, confirmation_required,
        confidence, source_type, source_id, source_session_id, source_extraction_id,
        source_offset_first, source_offset_last, created_at, updated_at, confirmed_at, archived_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 'manual', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`
  ).run(id, goalId, title, decisionText, status, confirmationRequired, NOW, updatedAt, archivedAt);
}

function seedSession(
  db: Database.Database,
  goalId: string,
  sessionId: string,
  options: { archived?: boolean; workspaceId?: string } = {}
): void {
  const archivedAt = options.archived ? NOW : null;
  // Sessions require a non-null workspace_id FK. Create a shared throwaway workspace per goal.
  const wsId = options.workspaceId ?? `test-ws-for-${goalId}`;
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
       (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, '/tmp/test-ws', 'test-ws', 'folder', NULL, NULL, 'not_a_repo', ?)`
  ).run(wsId, goalId, NOW);
  db.prepare(
    `INSERT INTO sessions
       (id, goal_id, workspace_id, adapter_id, role, instruction, title, status,
        pid, command, args_json, cwd, terminal_cols, terminal_rows, exit_code,
        exit_signal, failure_reason, failure_detail, created_at, started_at, exited_at, archived_at)
     VALUES (?, ?, ?, 'shell-manual', NULL, NULL, 'Test Session', 'exited',
             NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, NULL, ?, ?)`
  ).run(sessionId, goalId, wsId, NOW, NOW, archivedAt);
}

function seedSummary(
  db: Database.Database,
  goalId: string,
  sessionId: string,
  summaryId: string,
  options: { createdAt?: string } = {}
): void {
  const createdAt = options.createdAt ?? NOW;
  const extractionId = randomUUID();
  db.prepare(
    `INSERT INTO memory_extractions
       (id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
        source_offset_first, source_offset_last, summary_id, item_count, decision_count,
        promoted_count, failure_code, failure_message, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, 'terminal_state', 'succeeded', '0.1.0', 'fp', 0, 100, ?, 0, 0, 0, NULL, NULL, ?, ?, ?)`
  ).run(extractionId, goalId, sessionId, summaryId, NOW, NOW, NOW);

  db.prepare(
    `INSERT INTO session_summaries
       (id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
        source_offset_first, source_offset_last, created_at)
     VALUES (?, ?, ?, ?, 'Did some work', 'Session summary text.', 0, 0, 100, ?)`
  ).run(summaryId, sessionId, goalId, extractionId, createdAt);
}

function makeRequest(overrides: Partial<Parameters<typeof buildContextAssemblyInput>[1]> = {}) {
  return {
    goalId: 'goal-1',
    workspaceId: null,
    role: 'engineer' as const,
    adapterId: 'shell-manual',
    objective: 'Fix the rendering bug',
    objectiveHash: 'abc123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Goal not found
// ---------------------------------------------------------------------------

describe('goal not found', () => {
  it('throws GoalNotFoundError for missing goal', () => {
    const db = openTestDb();
    expect(() =>
      buildContextAssemblyInput(
        { db, assemblerVersion: ASSEMBLER_VERSION },
        makeRequest({ goalId: 'nonexistent' })
      )
    ).toThrow(GoalNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Empty Goal (no refinement, no memory, no decisions, no summaries)
// ---------------------------------------------------------------------------

describe('empty goal', () => {
  it('builds input with only goal data', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.refinement).toBeNull();
    expect(result.input.memory).toHaveLength(0);
    expect(result.input.decisions).toHaveLength(0);
    expect(result.input.siblingSummaries).toHaveLength(0);
    expect(result.input.workspace).toBeUndefined();
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.goalArchivedAt).toBeNull();
  });

  it('returns goalArchivedAt for an archived goal', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1', { archived: true });
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.goalArchivedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

describe('refinement', () => {
  it('includes refinement when present', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedRefinement(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.refinement).not.toBeNull();
    expect(result.input.refinement?.id).toBe('goal-1');
    expect(result.input.refinement?.constraints).toEqual(['no side effects']);
    expect(result.input.refinement?.successCriteria).toEqual(['pass tests']);
  });
});

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

describe('workspace', () => {
  it('includes workspace when found and attached to goal', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'goal-1', 'ws-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest({ workspaceId: 'ws-1' })
    );
    expect(result.input.workspace).toBeDefined();
    expect(result.input.workspace?.id).toBe('ws-1');
    expect(result.input.workspace?.name).toBe('my-repo');
    expect(result.input.workspace?.pathDisplay).toBe('/repo');
    expect(result.input.workspace?.branch).toBe('main');
    expect(result.input.workspace?.dirty).toBe(false);
  });

  it('sets workspace to undefined for foreign workspaceId', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedGoal(db, 'goal-2');
    seedWorkspace(db, 'goal-2', 'ws-other');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest({ workspaceId: 'ws-other' })
    );
    expect(result.input.workspace).toBeUndefined();
  });

  it('sets workspace to undefined when workspaceId does not exist', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest({ workspaceId: 'nonexistent-ws' })
    );
    expect(result.input.workspace).toBeUndefined();
  });

  it('sets workspace to undefined when workspaceId is null', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest({ workspaceId: null })
    );
    expect(result.input.workspace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sparse goal (refinement only, no memory/decisions/summaries)
// ---------------------------------------------------------------------------

describe('sparse goal', () => {
  it('has refinement but no memory, decisions, or summaries', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedRefinement(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.refinement).not.toBeNull();
    expect(result.input.memory).toHaveLength(0);
    expect(result.input.decisions).toHaveLength(0);
    expect(result.input.siblingSummaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Oversized memory list (all returned; selection trims in M6-007)
// ---------------------------------------------------------------------------

describe('oversized memory list', () => {
  it('returns all 50 items (selection caps later)', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    for (let i = 0; i < 50; i++) {
      // Use unique content per item to avoid content_hash uniqueness constraint.
      seedMemoryItem(db, 'goal-1', `mem-${i.toString().padStart(3, '0')}`, {
        content: `memory content item ${i}`,
      });
    }
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.memory).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Archived items excluded
// ---------------------------------------------------------------------------

describe('archived items excluded', () => {
  it('excludes archived memory items', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedMemoryItem(db, 'goal-1', 'mem-active');
    seedMemoryItem(db, 'goal-1', 'mem-archived', { archivedAt: NOW, status: 'archived' });
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.memory).toHaveLength(1);
    expect(result.input.memory[0]?.id).toBe('mem-active');
  });

  it('excludes archived decisions', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedDecision(db, 'goal-1', 'dec-active');
    seedDecision(db, 'goal-1', 'dec-archived', {
      status: 'archived',
      archivedAt: NOW,
    });
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.decisions).toHaveLength(1);
    expect(result.input.decisions[0]?.id).toBe('dec-active');
  });

  it('excludes summaries from archived sessions', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedSession(db, 'goal-1', 'sess-active');
    seedSession(db, 'goal-1', 'sess-archived', { archived: true });
    seedSummary(db, 'goal-1', 'sess-active', 'sum-1');
    seedSummary(db, 'goal-1', 'sess-archived', 'sum-2');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.siblingSummaries).toHaveLength(1);
    expect(result.input.siblingSummaries[0]?.id).toBe('sum-1');
  });
});

// ---------------------------------------------------------------------------
// Sibling summaries included
// ---------------------------------------------------------------------------

describe('sibling summaries', () => {
  it('includes summaries for non-archived sessions', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedSession(db, 'goal-1', 'sess-1');
    seedSummary(db, 'goal-1', 'sess-1', 'sum-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.siblingSummaries).toHaveLength(1);
    expect(result.input.siblingSummaries[0]?.id).toBe('sum-1');
    expect(result.input.siblingSummaries[0]?.sessionId).toBe('sess-1');
    expect(result.input.siblingSummaries[0]?.headline).toBe('Did some work');
    expect(result.input.siblingSummaries[0]?.summaryText).toBe('Session summary text.');
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('redacts password in memory content', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedMemoryItem(db, 'goal-1', 'mem-1', { content: 'Use password=supersecret for auth' });
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.memory[0]?.content).toBe('Use password=[redacted] for auth');
    expect(result.input.memory[0]?.content).not.toContain('supersecret');
  });

  it('redacts token in decision text', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedDecision(db, 'goal-1', 'dec-1', {
      decisionText: 'Connect using token=mytoken123',
    });
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.decisions[0]?.decisionText).toBe('Connect using token=[redacted]');
    expect(result.input.decisions[0]?.decisionText).not.toContain('mytoken123');
  });

  it('redacts api_key in sibling summary text', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedSession(db, 'goal-1', 'sess-1');
    // Insert summary directly with secret
    const extractionId = randomUUID();
    db.prepare(
      `INSERT INTO memory_extractions
         (id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
          source_offset_first, source_offset_last, summary_id, item_count, decision_count,
          promoted_count, failure_code, failure_message, requested_at, started_at, finished_at)
       VALUES (?, ?, ?, 'terminal_state', 'succeeded', '0.1.0', 'fp', 0, 100, ?, 0, 0, 0, NULL, NULL, ?, ?, ?)`
    ).run(extractionId, 'goal-1', 'sess-1', 'sum-sec', NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO session_summaries
         (id, session_id, goal_id, extraction_id, headline, summary_text, truncated,
          source_offset_first, source_offset_last, created_at)
       VALUES (?, ?, ?, ?, 'Headline', 'Used api_key=verysecret in prod', 0, 0, 100, ?)`
    ).run('sum-sec', 'sess-1', 'goal-1', extractionId, NOW);

    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.siblingSummaries[0]?.summaryText).toBe('Used api_key=[redacted] in prod');
    expect(result.input.siblingSummaries[0]?.summaryText).not.toContain('verysecret');
  });
});

// ---------------------------------------------------------------------------
// Source fingerprint determinism
// ---------------------------------------------------------------------------

describe('source fingerprint', () => {
  it('produces identical fingerprints for identical inputs', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedMemoryItem(db, 'goal-1', 'mem-1');
    const r1 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    const r2 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);
  });

  it('produces different fingerprint when memory updatedAt changes', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    seedMemoryItem(db, 'goal-1', 'mem-1', { updatedAt: '2026-01-01T00:00:00.000Z' });
    const r1 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );

    // Update the updatedAt in place to simulate a content change.
    db.prepare(
      `UPDATE goal_memory_items SET updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'mem-1'`
    ).run();
    resetInputStatements(); // ensure fresh prepared statements pick up new db state

    const r2 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );

    expect(r1.sourceFingerprint).not.toBe(r2.sourceFingerprint);
  });

  it('produces different fingerprint when a decision is added', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');

    const r1 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );

    seedDecision(db, 'goal-1', 'dec-1');

    const r2 = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );

    expect(r1.sourceFingerprint).not.toBe(r2.sourceFingerprint);
  });

  it('fingerprint differs across assembler versions', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const r1 = buildContextAssemblyInput(
      { db, assemblerVersion: '0.1.0' },
      makeRequest()
    );
    const r2 = buildContextAssemblyInput(
      { db, assemblerVersion: '0.2.0' },
      makeRequest()
    );
    expect(r1.sourceFingerprint).not.toBe(r2.sourceFingerprint);
  });

  it('fingerprint is a 64-character hex string', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Budget fields
// ---------------------------------------------------------------------------

describe('budget fields', () => {
  it('includes budget with correct defaults', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest()
    );
    expect(result.input.budget.maxBytes).toBe(32 * 1024);
    expect(result.input.budget.perSectionMaxBytes).toBe(8 * 1024);
    expect(result.input.budget.estimatedTokenBudget).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// Objective handling
// ---------------------------------------------------------------------------

describe('objective handling', () => {
  it('truncates objective to 4000 chars', () => {
    const db = openTestDb();
    seedGoal(db, 'goal-1');
    const longObj = 'x'.repeat(5000);
    const result = buildContextAssemblyInput(
      { db, assemblerVersion: ASSEMBLER_VERSION },
      makeRequest({ objective: longObj, objectiveHash: 'hash123' })
    );
    expect(result.input.objective).toHaveLength(4000);
  });
});
