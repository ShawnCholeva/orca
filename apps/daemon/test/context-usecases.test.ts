import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { FakeContextAssembler } from '../src/context/assembler.js';
import {
  requestContextPackage,
  resetPreparedStatements,
} from '../src/context/usecases.js';
import {
  getContextPackageById,
  resetPreparedStatements as resetProjectionStmts,
} from '../src/context/projection.js';
import type { DomainEvent } from '@orca/contracts';

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-ctx-uc-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string, archived = false): void {
  const now = '2026-01-01T00:00:00.000Z';
  const archivedAt = archived ? now : null;
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', ?, 1, ?, ?, ?)`
  ).run(goalId, archived ? 'archived' : 'active', now, now, archivedAt);
}

function makeBaseInput(overrides: Partial<Parameters<typeof requestContextPackage>[1]> = {}) {
  return {
    goalId: 'goal-1',
    adapterId: 'claude-code' as const,
    workspaceId: null,
    role: 'engineer',
    objective: 'Fix the rendering bug',
    replacePackageId: null,
    trigger: 'prepare',
    ...overrides,
  };
}

afterEach(() => {
  resetPreparedStatements();
  resetProjectionStmts();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('context-usecases: happy path', () => {
  it('creates assembly, package, and emits events in order: requested, completed, package.created', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    // Assembly result
    expect(result.reused).toBe(false);
    expect(result.assembly.status).toBe('succeeded');
    expect(result.assembly.goalId).toBe('goal-1');
    expect(result.assembly.adapterId).toBe('claude-code');
    expect(result.assembly.role).toBe('engineer');
    expect(result.assembly.packageId).toBeTruthy();

    // Package result
    expect(result.package).not.toBeNull();
    expect(result.package!.status).toBe('ready');
    expect(result.package!.sourceCount).toBe(2);
    expect(result.package!.warnings).toEqual(['goal_not_refined']);
    expect(result.package!.renderedBytes).toBeGreaterThan(0);
    expect(result.package!.estimatedTokens).toBe(Math.ceil(result.package!.renderedBytes / 4));

    // Event order
    expect(published).toHaveLength(3);
    expect(published[0]!.type).toBe('context.assembly.requested');
    expect(published[1]!.type).toBe('context.assembly.completed');
    expect(published[2]!.type).toBe('context.package.created');

    // Content-free payloads
    for (const event of published) {
      expect(event.payload).not.toHaveProperty('renderedContext');
      expect(event.payload).not.toHaveProperty('objective');
      expect(event.payload).not.toHaveProperty('memoryContent');
      expect(event.payload).not.toHaveProperty('decisionText');
      expect(event.payload).not.toHaveProperty('summaryText');
    }

    // DB rows exist
    const pkg = getContextPackageById(db, result.package!.id);
    expect(pkg).not.toBeNull();
    expect(pkg!.renderedContext).toContain('# Objective');
  });

  it('persists started_at and finished_at on succeeded assembly', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    expect(result.assembly.startedAt).toBeTruthy();
    expect(result.assembly.finishedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Commit-then-broadcast invariant
// ---------------------------------------------------------------------------

describe('context-usecases: commit-then-broadcast invariant', () => {
  it('DB rows are committed before bus.publish is called', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const seenDuringPublish: boolean[] = [];

    bus.subscribe((event) => {
      if (event.type === 'context.assembly.requested') {
        // If commit happened first, the assembly row must already exist in the DB.
        const row = db
          .prepare('SELECT id FROM context_assemblies WHERE id = ?')
          .get(event.payload['assemblyId'] as string);
        seenDuringPublish.push(row !== undefined);
      }
    });

    requestContextPackage({ db, bus, assembler }, makeBaseInput());

    expect(seenDuringPublish).toHaveLength(1);
    expect(seenDuringPublish[0]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('context-usecases: idempotency', () => {
  it('returns reused=true and emits no new events on duplicate active request', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const firstPublished: DomainEvent[] = [];
    bus.subscribe((e) => firstPublished.push(e));

    const r1 = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    expect(r1.reused).toBe(false);

    const beforeCount = firstPublished.length;

    const r2 = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    expect(r2.reused).toBe(true);
    expect(r2.assembly.id).toBe(r1.assembly.id);
    expect(r2.package?.id).toBe(r1.package?.id);

    // No new events for the second call
    expect(firstPublished.length).toBe(beforeCount);
  });

  it('produces one assembly row and one package row for two identical calls', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    requestContextPackage({ db, bus, assembler }, makeBaseInput());
    requestContextPackage({ db, bus, assembler }, makeBaseInput());

    const asmRows = db.prepare('SELECT count(*) as cnt FROM context_assemblies').get() as { cnt: number };
    const pkgRows = db.prepare('SELECT count(*) as cnt FROM context_packages').get() as { cnt: number };
    expect(asmRows.cnt).toBe(1);
    expect(pkgRows.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retry after failure
// ---------------------------------------------------------------------------

describe('context-usecases: retry after failure', () => {
  it('allows a new assembly after a previous failed one with the same fingerprint', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    assembler.simulateFailure('internal_error');
    const r1 = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    expect(r1.assembly.status).toBe('failed');
    expect(r1.reused).toBe(false);

    assembler.resetOverride();
    const r2 = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    expect(r2.reused).toBe(false);
    expect(r2.assembly.status).toBe('succeeded');
    expect(r2.assembly.id).not.toBe(r1.assembly.id);
    expect(r2.package).not.toBeNull();

    // Two assembly rows in DB, one failed and one succeeded
    const asmRows = db.prepare('SELECT status FROM context_assemblies ORDER BY requested_at ASC').all() as { status: string }[];
    expect(asmRows).toHaveLength(2);
    expect(asmRows[0]!.status).toBe('failed');
    expect(asmRows[1]!.status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('context-usecases: failure — assembler throws', () => {
  it('creates a failed assembly with internal_error; no package; emits requested then failed', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');
    assembler.simulateFailure('internal_error');

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    expect(result.assembly.status).toBe('failed');
    expect(result.assembly.failureCode).toBe('internal_error');
    expect(result.assembly.failureMessage).toBe('fake internal error');
    expect(result.package).toBeNull();

    expect(published).toHaveLength(2);
    expect(published[0]!.type).toBe('context.assembly.requested');
    expect(published[1]!.type).toBe('context.assembly.failed');
    expect(published[1]!.payload['failureCode']).toBe('internal_error');

    // No package row in DB
    const pkgCount = (db.prepare('SELECT count(*) as cnt FROM context_packages').get() as { cnt: number }).cnt;
    expect(pkgCount).toBe(0);
  });
});

describe('context-usecases: failure — invalid assembler output', () => {
  it('creates a failed assembly with invalid_output; no package', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');
    assembler.simulateFailure('invalid_output');

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    expect(result.assembly.status).toBe('failed');
    expect(result.assembly.failureCode).toBe('invalid_output');
    expect(result.package).toBeNull();
  });
});

describe('context-usecases: failure — output_too_large', () => {
  it('creates a failed assembly with output_too_large; no package; emits requested then failed', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');
    assembler.simulateFailure('output_too_large');

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    expect(result.assembly.status).toBe('failed');
    expect(result.assembly.failureCode).toBe('output_too_large');
    expect(result.package).toBeNull();

    expect(published).toHaveLength(2);
    expect(published[0]!.type).toBe('context.assembly.requested');
    expect(published[1]!.type).toBe('context.assembly.failed');
    expect(published[1]!.payload['failureCode']).toBe('output_too_large');
  });
});

// ---------------------------------------------------------------------------
// Goal archived
// ---------------------------------------------------------------------------

describe('context-usecases: goal archived', () => {
  it('creates a failed assembly with goal_archived; no package; emits failed event', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1', true); // archived

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    expect(result.assembly.status).toBe('failed');
    expect(result.assembly.failureCode).toBe('goal_archived');
    expect(result.package).toBeNull();
    expect(result.reused).toBe(false);

    // Only the failed event (no requested event for archived goals)
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe('context.assembly.failed');
    expect(published[0]!.payload['failureCode']).toBe('goal_archived');
  });
});

// ---------------------------------------------------------------------------
// Goal not found
// ---------------------------------------------------------------------------

describe('context-usecases: goal not found', () => {
  it('throws GoalNotFoundError without creating any rows', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();

    expect(() =>
      requestContextPackage({ db, bus, assembler }, makeBaseInput({ goalId: 'missing' }))
    ).toThrow('Goal not found');

    const asmCount = (db.prepare('SELECT count(*) as cnt FROM context_assemblies').get() as { cnt: number }).cnt;
    expect(asmCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event payload shape — content-free
// ---------------------------------------------------------------------------

describe('context-usecases: event payload content-free', () => {
  it('no event payload contains renderedContext, objective, or forbidden fields', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const published: DomainEvent[] = [];
    bus.subscribe((e) => published.push(e));
    requestContextPackage({ db, bus, assembler }, makeBaseInput());

    const forbidden = [
      'renderedContext',
      'objective',
      'memoryContent',
      'decisionText',
      'summaryText',
      'assemblerInput',
      'assemblerOutput',
      'prompt',
      'response',
      'sourcesText',
    ];

    for (const event of published) {
      for (const field of forbidden) {
        expect(event.payload).not.toHaveProperty(field);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context package fields
// ---------------------------------------------------------------------------

describe('context-usecases: package fields', () => {
  it('renderedBytes matches Buffer.byteLength of renderedContext in DB', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    const result = requestContextPackage({ db, bus, assembler }, makeBaseInput());

    const pkg = getContextPackageById(db, result.package!.id)!;
    expect(pkg.renderedBytes).toBe(Buffer.byteLength(pkg.renderedContext, 'utf8'));
    expect(pkg.estimatedTokens).toBe(Math.ceil(pkg.renderedBytes / 4));
  });

  it('supersedesPackageId is set when replacePackageId provided', () => {
    const db = openTestDb();
    const bus = new EventBus();
    const assembler = new FakeContextAssembler();
    seedGoal(db, 'goal-1');

    // First package
    const r1 = requestContextPackage({ db, bus, assembler }, makeBaseInput());
    const pkg1Id = r1.package!.id;

    // Second package supersedes first
    const r2 = requestContextPackage({ db, bus, assembler }, makeBaseInput({
      objective: 'Different objective for new fingerprint',
      replacePackageId: pkg1Id,
      trigger: 'regenerate',
    }));

    expect(r2.package!.supersedesPackageId).toBe(pkg1Id);
  });
});
