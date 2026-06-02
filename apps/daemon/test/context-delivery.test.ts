import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import type { Config } from '../src/config.js';
import { eventBus } from '../src/events.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability, AdapterContextDelivery } from '../src/adapters/types.js';
import { buildSpawnEnv } from '../src/adapters/types.js';
import { FakePtyManager, controlFakePty } from '../src/pty/fake.js';
import { SessionRuntime, resetPreparedStatements as resetRuntimeStmts } from '../src/sessions/runtime.js';
import { createSessionOutputStore } from '../src/sessions/output-store.js';
import {
  createSession,
  startSession,
  resetPreparedStatements as resetUsecaseStmts,
  type StartSessionCtx,
} from '../src/sessions/usecases.js';
import { resetPreparedStatements as resetProjectionStmts } from '../src/sessions/projection.js';
import {
  checkArgvEnvSafety,
  deleteContextFile,
  resetPreparedStatements as resetDeliveryStmts,
  sessionContextFilePath,
  sweepOrphanContextFiles,
  writeContextFile,
} from '../src/sessions/context-delivery.js';
import { insertContextPackage, resetPreparedStatements as resetContextProjectionStmts } from '../src/context/projection.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z';
const RENDERED_CONTEXT = '## Objective\nBuild the feature\n## Memory\nKey constraint: no side effects\n';

const tempDirs: string[] = [];

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
    getAuthToken: () => 'test-token',
  };
}

function freshDb(dataDir: string): Database.Database {
  const db = openDatabase(createConfig(dataDir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, null)`
  ).run(id, NOW, NOW);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string, wsPath: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at)
     VALUES (?, ?, ?, 'ws', 'folder', null, null, 'not_a_repo', ?)`
  ).run(id, goalId, wsPath, NOW);
}

function seedContextPackage(
  db: Database.Database,
  id: string,
  goalId: string,
  adapterId: string,
  renderedContext: string
): void {
  const bytes = Buffer.byteLength(renderedContext, 'utf8');
  insertContextPackage(db, {
    id,
    goalId,
    supersedesPackageId: null,
    adapterId,
    workspaceId: null,
    role: 'engineer',
    objective: 'Build the feature',
    status: 'ready',
    renderedContext,
    renderedBytes: bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    truncated: false,
    sparse: false,
    sourceCount: 1,
    sources: [{ type: 'goal', id: goalId, label: 'Goal', reason: 'required', marker: '[goal:g1]' }],
    warnings: [],
    sourceFingerprint: 'fp-1',
    assemblerVersion: '0.1.0',
    createdAt: NOW,
  });
}

// Build a test adapter with a real AdapterId and specific delivery mode.
function makeTestAdapter(
  id: 'claude-code' | 'codex',
  cwd: string,
  delivery: AdapterContextDelivery,
  argsOverride?: string[]
): AgentAdapter {
  return {
    id,
    title: `Test-${id}`,
    contextDelivery: delivery,
    async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
      return {
        command: '/bin/sh',
        args: argsOverride ? [...argsOverride] : [],
        env: buildSpawnEnv(input),
        cwd,
      };
    },
    async probeAvailability(): Promise<AdapterAvailability> {
      return { status: 'available' };
    },
  };
}

afterEach(async () => {
  closeDatabase();
  resetUsecaseStmts();
  resetProjectionStmts();
  resetRuntimeStmts();
  resetContextProjectionStmts();
  resetDeliveryStmts();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unit: checkArgvEnvSafety ──────────────────────────────────────────────────

describe('checkArgvEnvSafety', () => {
  it('passes when argv and env do not contain rendered content', () => {
    expect(checkArgvEnvSafety(['--foo', 'bar'], { KEY: 'value' }, RENDERED_CONTEXT)).toBe(true);
  });

  it('fails when an argv element contains the first 1 KiB prefix', () => {
    expect(checkArgvEnvSafety([RENDERED_CONTEXT], {}, RENDERED_CONTEXT)).toBe(false);
  });

  it('fails when an env value contains the first 1 KiB prefix', () => {
    expect(checkArgvEnvSafety([], { SECRET: RENDERED_CONTEXT }, RENDERED_CONTEXT)).toBe(false);
  });

  it('passes when rendered context is empty', () => {
    expect(checkArgvEnvSafety(['anything'], { KEY: 'anything' }, '')).toBe(true);
  });

  it('detects prefix substring match in argv', () => {
    const long = 'x'.repeat(2000);
    const prefix = long.slice(0, 1024);
    expect(checkArgvEnvSafety([`wrap: ${prefix}`], {}, long)).toBe(false);
  });
});

// ── Unit: writeContextFile / deleteContextFile ────────────────────────────────

describe('writeContextFile', () => {
  it('writes file with mode 0600', async () => {
    const dataDir = mktemp('orca-cd-write-');
    const filePath = await writeContextFile('sess-1', dataDir, RENDERED_CONTEXT);

    const content = await readFile(filePath, 'utf8');
    expect(content).toBe(RENDERED_CONTEXT);

    if (process.platform !== 'win32') {
      const stat = statSync(filePath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('returns the absolute path to the context file', async () => {
    const dataDir = mktemp('orca-cd-path-');
    const filePath = await writeContextFile('sess-2', dataDir, 'content');
    expect(filePath).toBe(sessionContextFilePath(dataDir, 'sess-2'));
  });

  it('throws EEXIST when file already exists (no silent overwrite)', async () => {
    const dataDir = mktemp('orca-cd-exist-');
    await writeContextFile('sess-3', dataDir, 'first');
    await expect(writeContextFile('sess-3', dataDir, 'second')).rejects.toThrow();
  });
});

describe('deleteContextFile', () => {
  it('deletes an existing context file', async () => {
    const dataDir = mktemp('orca-cd-del-');
    const filePath = await writeContextFile('sess-1', dataDir, RENDERED_CONTEXT);
    await deleteContextFile('sess-1', dataDir);
    expect(() => statSync(filePath)).toThrow();
  });

  it('is a no-op when the file does not exist', async () => {
    const dataDir = mktemp('orca-cd-noop-');
    await expect(deleteContextFile('no-such-session', dataDir)).resolves.not.toThrow();
  });
});

// ── Unit: sweepOrphanContextFiles ─────────────────────────────────────────────

describe('sweepOrphanContextFiles', () => {
  it('is a no-op when sessions directory does not exist', async () => {
    const dataDir = mktemp('orca-cd-sweep-');
    await expect(sweepOrphanContextFiles(dataDir, () => false)).resolves.not.toThrow();
  });

  it('deletes context files for sessions not returned by isActiveSession', async () => {
    const dataDir = mktemp('orca-cd-sweep2-');
    await writeContextFile('sess-orphan', dataDir, RENDERED_CONTEXT);
    const filePath = sessionContextFilePath(dataDir, 'sess-orphan');

    await sweepOrphanContextFiles(dataDir, () => false);
    expect(() => statSync(filePath)).toThrow();
  });

  it('preserves context files for active sessions', async () => {
    const dataDir = mktemp('orca-cd-sweep3-');
    await writeContextFile('sess-active', dataDir, RENDERED_CONTEXT);
    const filePath = sessionContextFilePath(dataDir, 'sess-active');

    await sweepOrphanContextFiles(dataDir, (id) => id === 'sess-active');
    expect(statSync(filePath).isFile()).toBe(true);
  });

  it('sweeps orphans while preserving active sessions', async () => {
    const dataDir = mktemp('orca-cd-sweep4-');
    await writeContextFile('sess-orphan', dataDir, 'orphan content');
    await writeContextFile('sess-active', dataDir, 'active content');

    await sweepOrphanContextFiles(dataDir, (id) => id === 'sess-active');

    expect(() => statSync(sessionContextFilePath(dataDir, 'sess-orphan'))).toThrow();
    expect(statSync(sessionContextFilePath(dataDir, 'sess-active')).isFile()).toBe(true);
  });
});

// ── Integration helpers ───────────────────────────────────────────────────────

async function setupSession(
  db: Database.Database,
  wsDir: string,
  adapterId: 'claude-code' | 'codex',
  delivery: AdapterContextDelivery,
  pkgId: string,
  argsOverride?: string[]
) {
  seedGoal(db, 'g1');
  seedWorkspace(db, 'ws1', 'g1', wsDir);
  seedContextPackage(db, pkgId, 'g1', adapterId, RENDERED_CONTEXT);

  const registry = new AdapterRegistry();
  registry.register(makeTestAdapter(adapterId, wsDir, delivery, argsOverride));

  const session = await createSession(
    { db, bus: eventBus, adapterRegistry: registry },
    { goalId: 'g1', workspaceId: 'ws1', adapterId, contextPackageId: pkgId }
  );
  return { registry, sessionId: session.id };
}

function makeStartCtx(
  db: Database.Database,
  registry: AdapterRegistry,
  ptyMgr: FakePtyManager,
  dataDir: string
): StartSessionCtx {
  const runtime = new SessionRuntime(ptyMgr);
  const outputStore = createSessionOutputStore(db, { tailBytes: 1024 * 1024 });
  return { db, bus: eventBus, adapterRegistry: registry, sessionOutputStore: outputStore, sessionRuntime: runtime, dataDir };
}

// ── Integration: initial_input delivery ───────────────────────────────────────

describe('initial_input delivery (shell/manual)', () => {
  it('writes rendered context + terminator to PTY stdin', async () => {
    const dataDir = mktemp('orca-cd-ii-');
    const wsDir = mktemp('orca-cd-ii-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = { mode: 'initial_input', maxBytes: 32768 };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-1');

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const handle = ctx.sessionRuntime.getHandle(sessionId);
    expect(handle).toBeDefined();
    const control = controlFakePty(handle!);

    const written = Buffer.concat(control.writtenChunks as Buffer[]).toString('utf8');
    expect(written).toContain(RENDERED_CONTEXT);
    expect(written).toContain('# END ORCA CONTEXT\n');
    expect(written.indexOf(RENDERED_CONTEXT)).toBeLessThan(written.indexOf('# END ORCA CONTEXT\n'));
  });

  it('argv and env do not contain the rendered context bytes', async () => {
    const dataDir = mktemp('orca-cd-ii2-');
    const wsDir = mktemp('orca-cd-ii2-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = { mode: 'initial_input', maxBytes: 32768 };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-2');

    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> = {};
    const ptyMgr = new FakePtyManager();
    const origStart = ptyMgr.start.bind(ptyMgr);
    ptyMgr.start = (opts) => { capturedArgs = opts.args; capturedEnv = opts.env; return origStart(opts); };

    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    expect(checkArgvEnvSafety(capturedArgs, capturedEnv, RENDERED_CONTEXT)).toBe(true);
  });
});

// ── Integration: preview_only delivery ───────────────────────────────────────

describe('preview_only delivery', () => {
  it('does not write a context file and does not send PTY input', async () => {
    const dataDir = mktemp('orca-cd-po-');
    const wsDir = mktemp('orca-cd-po-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = { mode: 'preview_only', maxBytes: 32768 };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-3');

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const handle = ctx.sessionRuntime.getHandle(sessionId);
    expect(handle).toBeDefined();
    const control = controlFakePty(handle!);

    expect(control.writtenChunks).toHaveLength(0);
    expect(() => statSync(sessionContextFilePath(dataDir, sessionId))).toThrow();
  });

  it('session starts successfully and carries contextPackageId', async () => {
    const dataDir = mktemp('orca-cd-po2-');
    const wsDir = mktemp('orca-cd-po2-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = { mode: 'preview_only', maxBytes: 32768 };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-4');

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    const session = await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    expect(session.status).toBe('running');
    expect(session.contextPackageId).toBe('pkg-4');
  });
});

// ── Integration: context_file delivery ───────────────────────────────────────

describe('context_file delivery', () => {
  it('writes context file with mode 0600 when contextFileArgFlag is set', async () => {
    const dataDir = mktemp('orca-cd-cf-');
    const wsDir = mktemp('orca-cd-cf-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = {
      mode: 'context_file',
      contextFileArgFlag: '--context-file',
      maxBytes: 32768,
    };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-5');

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const filePath = sessionContextFilePath(dataDir, sessionId);
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe(RENDERED_CONTEXT);

    if (process.platform !== 'win32') {
      const stat = statSync(filePath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('adds file path (not content) to argv via contextFileArgFlag', async () => {
    const dataDir = mktemp('orca-cd-cf2-');
    const wsDir = mktemp('orca-cd-cf2-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = {
      mode: 'context_file',
      contextFileArgFlag: '--context-file',
      maxBytes: 32768,
    };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-6');

    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> = {};
    const ptyMgr = new FakePtyManager();
    const origStart = ptyMgr.start.bind(ptyMgr);
    ptyMgr.start = (opts) => { capturedArgs = opts.args; capturedEnv = opts.env; return origStart(opts); };

    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const expectedPath = sessionContextFilePath(dataDir, sessionId);
    expect(capturedArgs).toContain('--context-file');
    expect(capturedArgs).toContain(expectedPath);
    expect(checkArgvEnvSafety(capturedArgs, capturedEnv, RENDERED_CONTEXT)).toBe(true);
  });

  it('adds file path to env via contextFileEnvVar (not the content)', async () => {
    const dataDir = mktemp('orca-cd-cf3-');
    const wsDir = mktemp('orca-cd-cf3-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = {
      mode: 'context_file',
      contextFileEnvVar: 'ORCA_CONTEXT_FILE',
      maxBytes: 32768,
    };
    const { registry, sessionId } = await setupSession(db, wsDir, 'codex', delivery, 'pkg-7');

    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> = {};
    const ptyMgr = new FakePtyManager();
    const origStart = ptyMgr.start.bind(ptyMgr);
    ptyMgr.start = (opts) => { capturedArgs = opts.args; capturedEnv = opts.env; return origStart(opts); };

    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const expectedPath = sessionContextFilePath(dataDir, sessionId);
    expect(capturedEnv['ORCA_CONTEXT_FILE']).toBe(expectedPath);
    expect(checkArgvEnvSafety(capturedArgs, capturedEnv, RENDERED_CONTEXT)).toBe(true);
  });

  it('deletes context file on session terminal state (exit)', async () => {
    const dataDir = mktemp('orca-cd-cleanup-');
    const wsDir = mktemp('orca-cd-cleanup-ws-');
    const db = freshDb(dataDir);

    const delivery: AdapterContextDelivery = {
      mode: 'context_file',
      contextFileArgFlag: '--context-file',
      maxBytes: 32768,
    };
    const { registry, sessionId } = await setupSession(db, wsDir, 'claude-code', delivery, 'pkg-8');

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);
    await startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 });

    const filePath = sessionContextFilePath(dataDir, sessionId);
    expect(statSync(filePath).isFile()).toBe(true);

    const handle = ctx.sessionRuntime.getHandle(sessionId);
    controlFakePty(handle!).emitExit({ exitCode: 0, signal: null });

    // Allow async cleanup
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(() => statSync(filePath)).toThrow();
  });
});

// ── Integration: defensive argv/env check ─────────────────────────────────────

describe('defensive argv/env check', () => {
  it('rejects start when rendered context appears in argv (misconfigured adapter)', async () => {
    const dataDir = mktemp('orca-cd-def-');
    const wsDir = mktemp('orca-cd-def-ws-');
    const db = freshDb(dataDir);

    // Adapter with initial_input mode but resolveSpawn returns context in args
    const delivery: AdapterContextDelivery = { mode: 'initial_input', maxBytes: 32768 };
    // argsOverride pre-fills args with the rendered context bytes
    const { registry, sessionId } = await setupSession(
      db, wsDir, 'claude-code', delivery, 'pkg-def', [RENDERED_CONTEXT]
    );

    const ptyMgr = new FakePtyManager();
    const ctx = makeStartCtx(db, registry, ptyMgr, dataDir);

    await expect(
      startSession(ctx, sessionId, { terminalCols: 80, terminalRows: 24 })
    ).rejects.toMatchObject({ code: 'delivery_unavailable' });
  });
});

// ── Boot sweep ────────────────────────────────────────────────────────────────

describe('boot sweep', () => {
  it('sweepOrphanContextFiles removes orphan files', async () => {
    const dataDir = mktemp('orca-cd-boot-');
    await writeContextFile('orphan-sess', dataDir, RENDERED_CONTEXT);
    const orphanPath = sessionContextFilePath(dataDir, 'orphan-sess');
    expect(statSync(orphanPath).isFile()).toBe(true);

    await sweepOrphanContextFiles(dataDir, () => false);
    expect(() => statSync(orphanPath)).toThrow();
  });

  it('sweepOrphanContextFiles preserves active session files', async () => {
    const dataDir = mktemp('orca-cd-boot2-');
    await writeContextFile('active-sess', dataDir, RENDERED_CONTEXT);
    const activePath = sessionContextFilePath(dataDir, 'active-sess');

    await sweepOrphanContextFiles(dataDir, (id) => id === 'active-sess');
    expect(statSync(activePath).isFile()).toBe(true);
  });
});
