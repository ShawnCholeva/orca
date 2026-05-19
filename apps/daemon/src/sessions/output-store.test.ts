import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase } from '../db.js';
import { defaultMigrationsDir, runMigrations } from '../migrations.js';
import { createSessionOutputStore } from './output-store.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-output-store-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedSession(db: Database.Database, sessionId: string, goalId = 'g1', workspaceId = 'ws1'): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, null)`
  ).run(goalId, now, now);

  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'Workspace', 'folder', null, null, 'not_a_repo', ?)`
  ).run(workspaceId, goalId, process.cwd(), now);

  db.prepare(
    `INSERT INTO sessions (
      id, goal_id, workspace_id, adapter_id, role, instruction, title, status,
      created_at, output_seq, output_bytes_kept, output_offset_first
    ) VALUES (?, ?, ?, 'shell-manual', null, null, 'Session', 'created', ?, 0, 0, 0)`
  ).run(sessionId, goalId, workspaceId, now);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SessionOutputStore', () => {
  it('appends chunks with monotonic offsets and correct nextSeq/bytes', () => {
    const db = freshDb();
    const sessionId = 's-1';
    seedSession(db, sessionId);

    const store = createSessionOutputStore(db, { tailBytes: 1024 });

    const first = store.appendChunk(sessionId, Buffer.from('abc'));
    const second = store.appendChunk(sessionId, Buffer.from('defg'));
    const third = store.appendChunk(sessionId, Buffer.from('h'));

    expect(first).toEqual({ seq: 0, byteOffset: 0 });
    expect(second).toEqual({ seq: 1, byteOffset: 3 });
    expect(third).toEqual({ seq: 2, byteOffset: 7 });

    const tail = store.readTail(sessionId);
    expect(tail.nextSeq).toBe(3);
    expect(tail.firstByteOffset).toBe(0);
    expect(tail.totalBytesKept).toBe(8);
    expect(tail.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(tail.chunks.map((chunk) => chunk.byteOffset)).toEqual([0, 3, 7]);
  });

  it('enforces cap by deleting whole oldest chunks and advancing first offset', () => {
    const db = freshDb();
    const sessionId = 's-cap';
    seedSession(db, sessionId);

    const store = createSessionOutputStore(db, { tailBytes: 64 });

    const chunkA = Buffer.alloc(50, 65);
    const chunkB = Buffer.alloc(50, 66);
    const chunkC = Buffer.alloc(50, 67);

    store.appendChunk(sessionId, chunkA);
    let tail = store.readTail(sessionId);
    expect(tail.totalBytesKept).toBeLessThanOrEqual(64);
    expect(tail.chunks.map((chunk) => chunk.seq)).toEqual([0]);

    store.appendChunk(sessionId, chunkB);
    tail = store.readTail(sessionId);
    expect(tail.totalBytesKept).toBeLessThanOrEqual(64);
    expect(tail.firstByteOffset).toBe(50);
    expect(tail.chunks.map((chunk) => chunk.seq)).toEqual([1]);

    store.appendChunk(sessionId, chunkC);
    tail = store.readTail(sessionId);
    expect(tail.totalBytesKept).toBeLessThanOrEqual(64);
    expect(tail.firstByteOffset).toBe(100);
    expect(tail.chunks.map((chunk) => chunk.seq)).toEqual([2]);
  });

  it('keeps tails independent across sessions', () => {
    const db = freshDb();
    seedSession(db, 's-a', 'g-a', 'ws-a');
    seedSession(db, 's-b', 'g-b', 'ws-b');

    const store = createSessionOutputStore(db, { tailBytes: 1024 });
    store.appendChunk('s-a', Buffer.from('hello'));
    store.appendChunk('s-b', Buffer.from('x'));
    store.appendChunk('s-a', Buffer.from('world'));

    const tailA = store.readTail('s-a');
    const tailB = store.readTail('s-b');

    expect(tailA.nextSeq).toBe(2);
    expect(tailA.totalBytesKept).toBe(10);
    expect(tailA.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);

    expect(tailB.nextSeq).toBe(1);
    expect(tailB.totalBytesKept).toBe(1);
    expect(tailB.chunks.map((chunk) => chunk.seq)).toEqual([0]);
  });

  it('never writes output rows to the event store', () => {
    const db = freshDb();
    const sessionId = 's-events';
    seedSession(db, sessionId);

    const before = (
      db
        .prepare("SELECT count(*) AS c FROM events WHERE type LIKE 'session.output%'")
        .get() as { c: number }
    ).c;

    const store = createSessionOutputStore(db, { tailBytes: 1024 });
    store.appendChunk(sessionId, Buffer.from('data'));

    const after = (
      db
        .prepare("SELECT count(*) AS c FROM events WHERE type LIKE 'session.output%'")
        .get() as { c: number }
    ).c;

    expect(after).toBe(before);
  });

  it('returns an empty snapshot for unknown sessions', () => {
    const db = freshDb();
    const store = createSessionOutputStore(db, { tailBytes: 1024 });

    expect(store.readTail('missing')).toEqual({
      sessionId: 'missing',
      firstByteOffset: 0,
      nextSeq: 0,
      totalBytesKept: 0,
      chunks: [],
    });
  });
});
