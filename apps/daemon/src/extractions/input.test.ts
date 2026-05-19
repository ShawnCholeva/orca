import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionOutputSnapshot } from '@orca/contracts';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import {
  insertSession,
  setSessionStatus,
  resetPreparedStatements as resetSessionStmts,
} from '../sessions/projection.js';
import { resetPreparedStatements as resetRefinementStmts } from '../goal-refinements.js';
import { buildSessionExtractionInput, OutputUnavailableError, type InputBuilderCtx } from './input.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string) {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent' as const,
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    getAuthToken: () => 'test-token',
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-input-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Test Goal', '', 'active', 1, ?, ?, null)`,
  ).run(goalId, now, now);
}

function seedWorkspace(db: Database.Database, wsId: string, goalId: string, wsPath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'My Workspace', 'folder', null, null, 'not_a_repo', '2026-01-01T00:00:00.000Z')`,
  ).run(wsId, goalId, wsPath);
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  goalId: string,
  wsId: string,
  exitCode: number | null = 0,
): void {
  insertSession(db, {
    id: sessionId,
    goalId,
    workspaceId: wsId,
    adapterId: 'shell-manual',
    title: 'Test Session',
    status: 'exited',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  setSessionStatus(db, sessionId, 'exited', { exitCode, exitedAt: '2026-01-01T01:00:00.000Z' });
}

function makeSnapshot(chunks: { byteOffset: number; data: Buffer }[], firstByteOffset = 0): SessionOutputSnapshot {
  const totalBytesKept = chunks.reduce((sum, c) => sum + c.data.length, 0);
  return {
    sessionId: 'ignored',
    firstByteOffset,
    nextSeq: chunks.length,
    totalBytesKept,
    chunks: chunks.map((c, i) => ({
      seq: i,
      byteOffset: c.byteOffset,
      dataBase64: c.data.toString('base64'),
    })),
  };
}

function makeCtx(
  db: Database.Database,
  snapshot: SessionOutputSnapshot | null,
  cap = 131072,
): InputBuilderCtx {
  return {
    db,
    outputStore: { readTail: () => snapshot },
    config: { memoryExtractionMaxInputBytes: cap },
  };
}

const GOAL_ID = 'g-input-1';
const WS_ID = 'ws-input-1';
const SESSION_ID = 'sess-input-1';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
  seedGoal(db, GOAL_ID);
  seedWorkspace(db, WS_ID, GOAL_ID);
  seedSession(db, SESSION_ID, GOAL_ID, WS_ID, 0);
});

afterEach(() => {
  resetSessionStmts();
  resetRefinementStmts();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('buildSessionExtractionInput', () => {
  it('empty output yields empty text and truncated=false', async () => {
    const snapshot = makeSnapshot([]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.outputTail.text).toBe('');
    expect(result.outputTail.truncated).toBe(false);
    expect(result.outputTail.byteOffsetFirst).toBe(0);
    expect(result.outputTail.byteOffsetLast).toBe(0);
  });

  it('output exceeding cap returns only the last cap bytes with truncated=true', async () => {
    const cap = 128;
    // Create 300 bytes of data across 3 chunks, all at offset 0 in M4 (no M4 truncation)
    const chunk1 = Buffer.alloc(100, 0x41); // 'A' * 100
    const chunk2 = Buffer.alloc(100, 0x42); // 'B' * 100
    const chunk3 = Buffer.alloc(100, 0x43); // 'C' * 100

    const snapshot: SessionOutputSnapshot = {
      sessionId: SESSION_ID,
      firstByteOffset: 0,
      nextSeq: 3,
      totalBytesKept: 300,
      chunks: [
        { seq: 0, byteOffset: 0, dataBase64: chunk1.toString('base64') },
        { seq: 1, byteOffset: 100, dataBase64: chunk2.toString('base64') },
        { seq: 2, byteOffset: 200, dataBase64: chunk3.toString('base64') },
      ],
    };
    const ctx = makeCtx(db, snapshot, cap);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    // Last 128 bytes of 300: bytes 172..300, which spans part of chunk2 and all of chunk3
    expect(result.outputTail.truncated).toBe(true);
    expect(result.outputTail.byteOffsetFirst).toBe(300 - cap); // 172
    expect(result.outputTail.byteOffsetLast).toBe(300);
    // The text should only contain the last 128 bytes
    expect(result.outputTail.text.length).toBe(cap);
    // Last 128 bytes: 28 'B's and 100 'C's
    expect(result.outputTail.text).toBe('B'.repeat(28) + 'C'.repeat(100));
  });

  it('M4 truncation (firstByteOffset > 0) sets truncated=true even when within cap', async () => {
    const chunk = Buffer.from('hello world');
    const snapshot: SessionOutputSnapshot = {
      sessionId: SESSION_ID,
      firstByteOffset: 50000, // M4 dropped bytes
      nextSeq: 1,
      totalBytesKept: chunk.length,
      chunks: [
        { seq: 0, byteOffset: 50000, dataBase64: chunk.toString('base64') },
      ],
    };
    const ctx = makeCtx(db, snapshot, 131072);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.outputTail.truncated).toBe(true);
    expect(result.outputTail.text).toBe('hello world');
    expect(result.outputTail.byteOffsetFirst).toBe(50000);
    expect(result.outputTail.byteOffsetLast).toBe(50011);
  });

  it('strips ANSI CSI sequences', async () => {
    const raw = Buffer.from('\x1b[31mred text\x1b[0m normal');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: raw }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.outputTail.text).toBe('red text normal');
  });

  it('strips OSC sequences', async () => {
    const raw = Buffer.from('before\x1b]0;window title\x07after');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: raw }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.outputTail.text).toBe('beforeafter');
  });

  it('strips mouse sequences', async () => {
    // Mouse sequence: ESC [ M followed by 3 bytes; the 3 bytes will be stripped as C0 if < 0x20
    const raw = Buffer.from('text\x1b[M\x20\x30\x40more');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: raw }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    // \x1b[M is a CSI final byte 'M' - stripped; remaining bytes 0x20 0x30 0x40 are printable
    expect(result.outputTail.text).toContain('text');
    expect(result.outputTail.text).toContain('more');
    expect(result.outputTail.text).not.toContain('\x1b');
  });

  it('null bytes and invalid UTF-8 do not throw; they are replaced', async () => {
    // Mix of null bytes and invalid UTF-8 (0xFF is invalid UTF-8 start)
    const raw = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff, 0x77, 0x6f, 0x72, 0x6c, 0x64]);
    const snapshot = makeSnapshot([{ byteOffset: 0, data: raw }]);
    const ctx = makeCtx(db, snapshot);

    await expect(
      buildSessionExtractionInput(ctx, { sessionId: SESSION_ID, extractorVersion: 'test-1.0.0' }),
    ).resolves.toBeDefined();

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    // Should contain 'hello' and 'world'; null stripped; invalid byte becomes replacement char
    expect(result.outputTail.text).toContain('hello');
    expect(result.outputTail.text).toContain('world');
    // null byte (0x00) is C0 — stripped
    expect(result.outputTail.text).not.toContain('\x00');
  });

  it('unavailable output (null from store) throws OutputUnavailableError', async () => {
    const ctx = makeCtx(db, null);

    await expect(
      buildSessionExtractionInput(ctx, { sessionId: SESSION_ID, extractorVersion: 'test-1.0.0' }),
    ).rejects.toBeInstanceOf(OutputUnavailableError);
  });

  it('includes workspace metadata from DB without reading the workspace path', async () => {
    // Seed a workspace at a path that does not exist on disk; we still expect
    // the metadata to be returned correctly from the DB (no FS scan).
    const chunk = Buffer.from('some output');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: chunk }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].id).toBe(WS_ID);
    expect(result.workspaces[0].label).toBe('My Workspace');
    // /tmp/ws does not exist on disk; metadata is read from DB only
    expect(result.workspaces[0].rootPath).toBe('/tmp/ws');
  });

  it('produces a contract-valid SessionExtractionInput', async () => {
    const chunk = Buffer.from('hello world\n');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: chunk }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.goal.id).toBe(GOAL_ID);
    expect(result.goal.title).toBe('Test Goal');
    expect(result.goal.status).toBe('active');
    expect(result.goal.archived).toBe(false);
    expect(result.refinement).toBeNull();
    expect(result.session.id).toBe(SESSION_ID);
    expect(result.session.adapterId).toBe('shell-manual');
    expect(result.session.exitCode).toBe(0);
    expect(result.extractorVersion).toBe('test-1.0.0');
    expect(result.outputTail.text).toBe('hello world\n');
  });

  it('preserves \\n and \\t while stripping other C0 controls', async () => {
    const raw = Buffer.from('line1\nline2\t\x00\x01\x07indented');
    const snapshot = makeSnapshot([{ byteOffset: 0, data: raw }]);
    const ctx = makeCtx(db, snapshot);

    const result = await buildSessionExtractionInput(ctx, {
      sessionId: SESSION_ID,
      extractorVersion: 'test-1.0.0',
    });

    expect(result.outputTail.text).toContain('\n');
    expect(result.outputTail.text).toContain('\t');
    expect(result.outputTail.text).not.toContain('\x00');
    expect(result.outputTail.text).not.toContain('\x01');
    expect(result.outputTail.text).not.toContain('\x07');
  });
});
