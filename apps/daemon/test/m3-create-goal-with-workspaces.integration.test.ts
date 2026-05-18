import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CreateGoalResponse,
  type DomainEvent,
  GoalDetailResponse,
  InspectWorkspaceResponse,
  type RefineGoalResponse,
} from '@orca/contracts';
import { loadConfig } from '../src/config.js';
import { closeDatabase, getDatabase, openDatabase } from '../src/db.js';
import { eventBus } from '../src/events.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { bootstrapRegistries } from '../src/registry/bootstrap.js';

// Boot registries once per file — mirrors daemon index.ts boot sequence.
beforeAll(() => {
  bootstrapRegistries();
});

const ORCA_ENV_KEYS = ['ORCA_DATA_DIR', 'ORCA_PORT', 'ORCA_LOG_LEVEL', 'ORCA_TOKEN'] as const;
const AUTH_HEADERS = { authorization: 'Bearer m3-int-token' } as const;

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-m3-int-'));
  tempDirs.push(dir);
  return dir;
}

function resetOrcaEnv(dataDir: string): void {
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  process.env.ORCA_DATA_DIR = dataDir;
  process.env.ORCA_LOG_LEVEL = 'silent';
  process.env.ORCA_TOKEN = 'm3-int-token';
}

interface BootResult {
  server: FastifyInstance;
  baseUrl: string;
}

async function boot(dataDir: string): Promise<BootResult> {
  resetOrcaEnv(dataDir);
  const config = loadConfig();
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  const server = createServer(config);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const addr = server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to resolve server address');
  return { server, baseUrl: `http://127.0.0.1:${(addr as AddressInfo).port}` };
}

async function stop(server: FastifyInstance): Promise<void> {
  await server.close();
  closeDatabase();
}

// Step 11: all temp dirs cleaned after the suite.
afterAll(() => {
  closeDatabase();
  for (const key of ORCA_ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.sequential('M3-009 daemon integration: full M3 create-Goal loop', () => {
  it('inspect → refine → create-with-workspaces → detail → restart → detach', async () => {
    // ─── Fixture setup ───────────────────────────────────────────────────────
    const tmpDir = createTempDir();
    const gitRepoDir = path.join(tmpDir, 'git-repo');
    const plainFolderDir = path.join(tmpDir, 'plain-folder');
    const dbDir = path.join(tmpDir, 'daemon-db');

    mkdirSync(gitRepoDir);
    mkdirSync(plainFolderDir);
    mkdirSync(dbDir);

    execFileSync('git', ['init', gitRepoDir]);
    execFileSync('git', ['-C', gitRepoDir, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', gitRepoDir, 'config', 'user.email', 'test@example.com']);
    writeFileSync(path.join(gitRepoDir, 'README.md'), '# Test');
    execFileSync('git', ['-C', gitRepoDir, 'add', '.']);
    execFileSync('git', ['-C', gitRepoDir, 'commit', '-m', 'Initial commit']);
    // Read branch structurally — do not hardcode 'main' or 'master'.
    const expectedBranch = execFileSync(
      'git', ['-C', gitRepoDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8' }
    ).trim();

    // ─── Boot daemon (first instance) ────────────────────────────────────────
    let server1: FastifyInstance | undefined;
    let server2: FastifyInstance | undefined;
    let unsubscribe: (() => void) | undefined;

    // Collect bus events in order; must be subscribed BEFORE the first request.
    const publishedEvents: DomainEvent[] = [];

    try {
      const boot1 = await boot(dbDir);
      server1 = boot1.server;
      const url1 = boot1.baseUrl;

      unsubscribe = eventBus.subscribe((e) => publishedEvents.push(e));

      // ─── Step 1: inspect git repo ─────────────────────────────────────────
      {
        const resp = await fetch(`${url1}/v1/workspaces/inspect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
          body: JSON.stringify({ inputPath: gitRepoDir }),
        });
        expect(resp.status).toBe(200);
        const body = InspectWorkspaceResponse.parse(await resp.json());
        expect(body.preview.gitProbe).toBe('ok');
        expect(body.preview.branch).toBe(expectedBranch);
        expect(body.preview.workspaceType).toBe('repo');
        expect(body.preview.isDirty).toBe(false);
      }

      // ─── Step 2: inspect plain folder ────────────────────────────────────
      {
        const resp = await fetch(`${url1}/v1/workspaces/inspect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
          body: JSON.stringify({ inputPath: plainFolderDir }),
        });
        expect(resp.status).toBe(200);
        const body = InspectWorkspaceResponse.parse(await resp.json());
        expect(body.preview.gitProbe).toBe('not_a_repo');
        expect(body.preview.workspaceType).toBe('folder');
        expect(body.preview.branch).toBeNull();
      }

      // ─── Step 3: POST /v1/goals/refine ───────────────────────────────────
      const refineDescription = `This is a preamble paragraph.

Goals:
- Ship the feature
- Pass all tests

Constraints:
- No breaking changes
- Must work offline`;

      let draft!: RefineGoalResponse['draft'];
      {
        const resp = await fetch(`${url1}/v1/goals/refine`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
          body: JSON.stringify({ title: 'M3 Integration Goal', description: refineDescription }),
        });
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as RefineGoalResponse;
        expect(body.draft.skillId).toBe('guided-goal-refinement');
        expect(body.draft.successCriteria).toContain('Ship the feature');
        expect(body.draft.successCriteria).toContain('Pass all tests');
        expect(body.draft.constraints).toContain('No breaking changes');
        expect(body.draft.constraints).toContain('Must work offline');
        draft = body.draft;
      }

      // ─── Step 4: POST /v1/goals with refined + 2 workspaces ─────────────
      let goalId!: string;
      {
        const resp = await fetch(`${url1}/v1/goals`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            refined: draft,
            workspaces: [
              { inputPath: gitRepoDir },
              { inputPath: plainFolderDir },
            ],
          }),
        });
        expect(resp.status).toBe(201);
        const body = CreateGoalResponse.parse(await resp.json());
        goalId = body.goal.id;
        expect(body.goal.title).toBe(draft.title);
        expect(body.goal.status).toBe('active');
      }

      // ─── Step 5: assert exact event order by seq ─────────────────────────
      {
        const db = getDatabase();
        const rows = db
          .prepare('SELECT seq, type FROM events WHERE goal_id = ? ORDER BY seq ASC')
          .all(goalId) as { seq: number; type: string }[];

        expect(rows).toHaveLength(5);
        expect(rows[0]?.type).toBe('skill.invoked');
        expect(rows[1]?.type).toBe('goal.created');
        expect(rows[2]?.type).toBe('goal.refined');
        expect(rows[3]?.type).toBe('workspace.attached');
        expect(rows[4]?.type).toBe('workspace.attached');

        // Bus must publish in the same order as DB seq.
        const busEvents = publishedEvents.filter((e) => e.goalId === goalId);
        expect(busEvents).toHaveLength(5);
        expect(busEvents.map((e) => e.type)).toEqual([
          'skill.invoked',
          'goal.created',
          'goal.refined',
          'workspace.attached',
          'workspace.attached',
        ]);
        // Seq values from bus events must be monotonically increasing and match DB rows.
        const busSeqs = busEvents.map((e) => e.seq);
        const dbSeqs = rows.map((r) => r.seq);
        expect(busSeqs).toEqual(dbSeqs);
      }

      // ─── Step 6: GET /v1/goals/:id ───────────────────────────────────────
      let preShutdownDetail!: GoalDetailResponse;
      let gitWsId!: string;
      let folderWsId!: string;
      {
        const resp = await fetch(`${url1}/v1/goals/${goalId}`, {
          headers: AUTH_HEADERS,
        });
        expect(resp.status).toBe(200);
        const body = GoalDetailResponse.parse(await resp.json());

        expect(body.goal.id).toBe(goalId);
        expect(body.refinement).not.toBeNull();
        expect(body.refinement?.skillId).toBe('guided-goal-refinement');
        expect(body.refinement?.successCriteria).toContain('Ship the feature');
        expect(body.workspaces).toHaveLength(2);

        const gitWs = body.workspaces.find((w) => w.workspaceType === 'repo');
        const folderWs = body.workspaces.find((w) => w.workspaceType === 'folder');

        expect(gitWs).toBeDefined();
        expect(gitWs?.branch).toBe(expectedBranch);
        expect(gitWs?.gitProbe).toBe('ok');
        expect(gitWs?.isDirty).toBe(false);

        expect(folderWs).toBeDefined();
        expect(folderWs?.gitProbe).toBe('not_a_repo');
        expect(folderWs?.branch).toBeNull();

        gitWsId = gitWs!.id;
        folderWsId = folderWs!.id;
        preShutdownDetail = body;
      }

      // ─── Step 7: shutdown daemon ──────────────────────────────────────────
      unsubscribe();
      unsubscribe = undefined;
      await stop(server1);
      server1 = undefined;

      // ─── Step 8: reboot daemon against same DB path ───────────────────────
      const boot2 = await boot(dbDir);
      server2 = boot2.server;
      const url2 = boot2.baseUrl;

      // ─── Step 9: restart persistence — bundle must be byte-equal ─────────
      {
        const resp = await fetch(`${url2}/v1/goals/${goalId}`, {
          headers: AUTH_HEADERS,
        });
        expect(resp.status).toBe(200);
        const body = GoalDetailResponse.parse(await resp.json());

        expect(body.goal).toEqual(preShutdownDetail.goal);
        expect(body.refinement).toEqual(preShutdownDetail.refinement);
        expect(body.workspaces).toEqual(preShutdownDetail.workspaces);
      }

      // ─── Step 10: DELETE one workspace; verify removal ───────────────────
      {
        const deleteResp = await fetch(
          `${url2}/v1/goals/${goalId}/workspaces/${gitWsId}`,
          { method: 'DELETE', headers: AUTH_HEADERS }
        );
        expect(deleteResp.status).toBe(204);

        const detailResp = await fetch(`${url2}/v1/goals/${goalId}`, {
          headers: AUTH_HEADERS,
        });
        expect(detailResp.status).toBe(200);
        const body = GoalDetailResponse.parse(await detailResp.json());
        expect(body.workspaces).toHaveLength(1);
        expect(body.workspaces[0]?.id).toBe(folderWsId);

        const db = getDatabase();
        const removedRows = db
          .prepare(
            "SELECT type FROM events WHERE goal_id = ? AND type = 'workspace.removed'"
          )
          .all(goalId) as { type: string }[];
        expect(removedRows).toHaveLength(1);
      }

      await stop(server2);
      server2 = undefined;

    } finally {
      // Step 11: ensure all servers are stopped and env is clean.
      unsubscribe?.();
      if (server1) await stop(server1).catch(() => {});
      if (server2) await stop(server2).catch(() => {});
    }
  });
});
