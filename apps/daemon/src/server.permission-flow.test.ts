import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { createServer } from './server.js';
import { closeDatabase, openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { eventBus } from './events.js';
import { createDaemonContext } from './daemon-context.js';
import { seedAgents } from './agents.js';
import { actionClassOf, resetPreparedStatements as resetAccountabilityStatements } from './harness-risk/accountability.js';
import { classifyToolAction } from './harness-risk/classify.js';
import type { Config } from './config.js';

beforeAll(() => {
  bootstrapRegistries();
});

const AUTH_HEADERS = { authorization: 'Bearer test-token' } as const;

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

async function startServer(): Promise<{
  server: FastifyInstance;
  db: ReturnType<typeof openDatabase>;
  dataDir: string;
}> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-permission-test-'));
  const config = createConfig(dir);
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  seedAgents(db);
  const daemonContext = createDaemonContext(db, eventBus);
  const server = createServer(config, { daemonContext });
  return { server, db, dataDir: dir };
}

/**
 * Insert a bare goal row directly (bypasses the skill pipeline).
 * Returns the goalId.
 */
function insertGoal(db: ReturnType<typeof openDatabase>, goalId: string, permissionMode: 'ask' | 'auto'): void {
  const now = new Date().toISOString();
  // The governed gate reads goals.operating_mode (not worker_permission_mode). A
  // direct INSERT bypasses the backfill migration, so set it explicitly here:
  // 'auto' → automated (unattended except the safety floor); 'ask' → human_review.
  const operatingMode = permissionMode === 'auto' ? 'automated' : 'human_review';
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, worker_permission_mode, operating_mode)
     VALUES (?, ?, '', 'active', 1, ?, ?, ?, ?)`
  ).run(goalId, 'test-goal', now, now, permissionMode, operatingMode);
}

/**
 * Insert a bare workspace + session row directly.
 * The session points to the goal and uses adapter_id='claude-code'.
 */
function insertSession(db: ReturnType<typeof openDatabase>, sessionId: string, goalId: string): void {
  const now = new Date().toISOString();
  const workspaceId = `ws-${sessionId}`;
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(workspaceId, `/tmp/ws-${sessionId}`, 'test', '', now, now);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, workspaceId, now);
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
     VALUES (?, ?, ?, 'claude-code', 'test session', 'created', ?)`
  ).run(sessionId, goalId, workspaceId, now);
}

/**
 * Insert a workspace row with a specific path (for always-allow write tests).
 */
function insertWorkspace(db: ReturnType<typeof openDatabase>, workspaceId: string, goalId: string, wsPath: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(workspaceId, wsPath, 'test', '', now, now);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run(goalId, workspaceId, now);
}

/**
 * Insert a session row pointing to an existing workspace.
 */
function insertSessionWithWorkspace(db: ReturnType<typeof openDatabase>, sessionId: string, goalId: string, workspaceId: string, adapterId = 'claude-code'): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at)
     VALUES (?, ?, ?, ?, 'test session', 'created', ?)`
  ).run(sessionId, goalId, workspaceId, adapterId, now);
}

describe('permission decision flow', () => {
  let server: FastifyInstance;
  let db: ReturnType<typeof openDatabase>;
  let dataDir: string;

  beforeEach(async () => {
    const result = await startServer();
    server = result.server;
    db = result.db;
    dataDir = result.dataDir;
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // (a) auto-mode goal: permission hook → "allow" immediately, no chat message
  it('auto-mode goal: POST /v1/agent-hooks/permission resolves allow immediately without a chat message', async () => {
    const goalId = 'goal-auto-1';
    const sessionId = 'session-auto-1';
    insertGoal(db, goalId, 'auto');
    insertSession(db, sessionId, goalId);

    const res = await server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-auto-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput: { hookEventName: string; decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('allow');

    // No chat message should have been posted for auto-mode
    const messages = db
      .prepare("SELECT COUNT(*) AS cnt FROM orchestrator_messages WHERE goal_id = ?")
      .get(goalId) as { cnt: number };
    expect(messages.cnt).toBe(0);
  });

  // (b) ask-mode goal: hook holds → chat message with pendingApproval → answer → resolves allow
  it('ask-mode goal: hook holds, chat message appears, answer route resolves it', async () => {
    const goalId = 'goal-ask-1';
    const sessionId = 'session-ask-1';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    // Fire the permission hook but don't await it — a plain bash command is held
    // (require_approval) under human_review, so it should hold open.
    const permissionPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-ask-1' },
    });

    // Wait for the chat message to appear (the hook posts it before blocking)
    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        const parsed = JSON.parse(row.pending_approval) as { approvalId: string };
        return parsed.approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    expect(typeof approvalId).toBe('string');
    expect(approvalId.length).toBeGreaterThan(0);

    // Submit the allow decision via the answer route
    const answerRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'allow' },
    });
    expect(answerRes.statusCode).toBe(200);
    expect(answerRes.json()).toMatchObject({ ok: true });

    // Now await the held permission hook — it should resolve to "allow"
    const permissionRes = await permissionPromise;
    expect(permissionRes.statusCode).toBe(200);
    const body = permissionRes.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  // (b2) pendingApproval.canRemember reflects the session adapter's persistence capability
  it('ask-mode goal: pendingApproval.canRemember is true for claude-code, false for codex', async () => {
    const goalId = 'goal-canremember';
    insertGoal(db, goalId, 'ask');
    insertWorkspace(db, 'ws-canremember', goalId, '/tmp/ws-canremember');
    insertSessionWithWorkspace(db, 'session-claude-cr', goalId, 'ws-canremember', 'claude-code');
    insertSessionWithWorkspace(db, 'session-codex-cr', goalId, 'ws-canremember', 'codex');

    // canRemember is streak-gated (Task 7): it only advertises once the action
    // class has reached the consecutive-approval threshold. Pre-seed a built streak
    // for the exact action class the pending approval keys on ('ls' is a plain bash
    // command → Bash:sandbox_edit), so the assertion isolates the provider's
    // supportsPermissionPersistence capability (claude-code=true, codex=false).
    const actionClass = actionClassOf(
      'Bash',
      classifyToolAction({ toolName: 'Bash', toolInput: { command: 'ls' } })
    );
    db.prepare(
      `INSERT INTO gate_approval_counts (goal_id, action_class, consecutive_approvals, last_decision, updated_at)
       VALUES (?, ?, 3, 'allow', ?)`
    ).run(goalId, actionClass, new Date().toISOString());

    const readCanRemember = async (sessionId: string, toolUseId: string): Promise<boolean | undefined> => {
      const hookPromise = server.inject({
        method: 'POST',
        url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: toolUseId },
      });
      const approval = await vi.waitFor(
        () => {
          const row = db
            .prepare("SELECT pending_approval FROM orchestrator_messages WHERE pending_approval LIKE ?")
            .get(`%${sessionId}%`) as { pending_approval: string } | undefined;
          if (!row) throw new Error('pending approval message not yet posted');
          return JSON.parse(row.pending_approval) as { approvalId: string; canRemember?: boolean };
        },
        { timeout: 2000, interval: 50 }
      );
      // Resolve so the held hook doesn't dangle.
      await server.inject({
        method: 'POST',
        url: `/v1/goals/${goalId}/permission-approvals/${approval.approvalId}`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { decision: 'deny' },
      });
      await hookPromise;
      return approval.canRemember;
    };

    expect(await readCanRemember('session-claude-cr', 'tu-cr-claude')).toBe(true);
    expect(await readCanRemember('session-codex-cr', 'tu-cr-codex')).toBe(false);
  });

  // (b3) the pending-approval card carries a file-path summary + a human detail line
  it('ask-mode goal: Edit pendingApproval has a file-path summary and a non-empty detail', async () => {
    const goalId = 'goal-detail-1';
    const sessionId = 'session-detail-1';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const hookPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Edit', tool_input: { file_path: '/tmp/r/App.tsx', old_string: 'a', new_string: 'b' }, tool_use_id: 'tu-detail-1' },
    });

    const approval = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return JSON.parse(row.pending_approval) as { approvalId: string; summary: string; detail?: string };
      },
      { timeout: 2000, interval: 50 }
    );

    expect(approval.summary).toContain('/tmp/r/App.tsx'); // not a bare "Edit"
    expect(approval.detail).toBeTruthy();
    expect(approval.detail).toContain('App.tsx');
    // Honest tense: the action has NOT run yet, so the detail must be present-tense
    // ("Edit App.tsx"), never past-tense ("Edited App.tsx").
    expect(approval.detail).toBe('Edit App.tsx');

    // Resolve so the held hook doesn't dangle.
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approval.approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'deny' },
    });
    await hookPromise;
  });

  // (b4) re-answering an already-resolved approval → 404 and clears any lingering card
  it('ask-mode goal: re-POST after resolution returns 404 and clears the card (no phantom)', async () => {
    const goalId = 'goal-phantom-1';
    const sessionId = 'session-phantom-1';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const hookPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-phantom-1' },
    });
    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    // First answer resolves + deletes the message.
    await server.inject({
      method: 'POST', url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS }, payload: { decision: 'allow' },
    });
    await hookPromise;

    // Re-POST the same (now-gone) approval → 404, and the route must not error.
    const reRes = await server.inject({
      method: 'POST', url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS }, payload: { decision: 'allow' },
    });
    expect(reRes.statusCode).toBe(404);
    expect(reRes.json()).toMatchObject({ error: { code: 'approval_not_found' } });
    // The card stays gone (no phantom resurrected).
    const remaining = db
      .prepare("SELECT COUNT(*) AS cnt FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
      .get(goalId) as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  // (c) answer route with wrong goalId → 404, then resolve with correct goalId to unblock
  it('answer route with a different goalId returns 404', async () => {
    const goalId = 'goal-ask-2';
    const sessionId = 'session-ask-2';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const permissionPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-ask-2' },
    });

    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    // Using the WRONG goalId → should 404
    const wrongRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/wrong-goal-id/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'deny' },
    });
    expect(wrongRes.statusCode).toBe(404);
    expect(wrongRes.json()).toMatchObject({ error: { code: 'approval_not_found' } });

    // Resolve correctly so the held hook doesn't dangle
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'deny' },
    });
    const permissionRes = await permissionPromise;
    expect(permissionRes.statusCode).toBe(200);
    const body = permissionRes.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  // (d) PUT /v1/goals/:goalId/worker-permission-mode → 200, mode updated in DB, event replayable
  it('PUT /v1/goals/:goalId/worker-permission-mode updates the mode to auto', async () => {
    const goalId = 'goal-mode-toggle';
    insertGoal(db, goalId, 'ask');

    const res = await server.inject({
      method: 'PUT',
      url: `/v1/goals/${goalId}/worker-permission-mode`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workerPermissionMode: 'auto' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; workerPermissionMode: string };
    expect(body.ok).toBe(true);
    expect(body.workerPermissionMode).toBe('auto');

    // Verify the DB was actually updated
    const row = db
      .prepare("SELECT worker_permission_mode FROM goals WHERE id = ?")
      .get(goalId) as { worker_permission_mode: string };
    expect(row.worker_permission_mode).toBe('auto');

    // Verify the event is DB-backed and replayable via GET /v1/events
    const eventsRes = await server.inject({
      method: 'GET',
      url: '/v1/events?sinceSeq=0',
      headers: AUTH_HEADERS,
    });
    expect(eventsRes.statusCode).toBe(200);
    const eventsBody = eventsRes.json() as { events: Array<{ type: string; goalId: string; seq: number }> };
    const modeEvent = eventsBody.events.find(
      (e) => e.type === 'goal.worker_permission_mode_changed' && e.goalId === goalId
    );
    expect(modeEvent).toBeDefined();
    expect(modeEvent!.seq).toBeGreaterThan(0);
  });

  it('PUT /v1/goals/:goalId/worker-permission-mode returns 404 for unknown goal', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/goals/does-not-exist/worker-permission-mode',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { workerPermissionMode: 'auto' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'goal_not_found' } });
  });

  it('unknown session id on permission hook → safe deny', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/agent-hooks/permission?sessionId=no-such-session',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-unknown' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('missing sessionId on permission hook → safe deny', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/agent-hooks/permission',
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-nosession' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  // ---- Always-allow native rule write tests ----

  it('remember+allow writes the native rule into the workspace settings', async () => {
    const goalId = 'goal-remember-1';
    const sessionId = 'session-remember-1';
    const ws = mkdtempSync(join(os.tmpdir(), 'orca-ws-'));
    insertGoal(db, goalId, 'ask');
    insertWorkspace(db, 'ws-remember-1', goalId, ws);
    insertSessionWithWorkspace(db, sessionId, goalId, 'ws-remember-1', 'claude-code');

    const hookPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'rm build' }, tool_use_id: 'tu-remember-1' },
    });

    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'allow', remember: true },
    });
    await hookPromise;

    const settings = JSON.parse(readFileSync(join(ws, '.claude', 'settings.local.json'), 'utf8')) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain('Bash(rm:*)');
    rmSync(ws, { recursive: true, force: true });
  });

  it('remember+allow records an auditable relaxation GoalDecision (but plain allow does not)', async () => {
    const goalId = 'goal-relax-1';
    const ws = mkdtempSync(join(os.tmpdir(), 'orca-ws-'));
    insertGoal(db, goalId, 'ask');
    insertWorkspace(db, 'ws-relax-1', goalId, ws);
    insertSessionWithWorkspace(db, 'session-relax-plain', goalId, 'ws-relax-1', 'claude-code');
    insertSessionWithWorkspace(db, 'session-relax-remember', goalId, 'ws-relax-1', 'claude-code');

    const answer = async (sessionId: string, toolUseId: string, remember: boolean): Promise<void> => {
      const hookPromise = server.inject({
        method: 'POST',
        url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { tool_name: 'Bash', tool_input: { command: 'rm build' }, tool_use_id: toolUseId },
      });
      const approvalId = await vi.waitFor(
        () => {
          const row = db
            .prepare("SELECT pending_approval FROM orchestrator_messages WHERE pending_approval LIKE ?")
            .get(`%${sessionId}%`) as { pending_approval: string } | undefined;
          if (!row) throw new Error('pending approval message not yet posted');
          return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
        },
        { timeout: 2000, interval: 50 }
      );
      await server.inject({
        method: 'POST',
        url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
        headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
        payload: { decision: 'allow', remember },
      });
      await hookPromise;
    };

    // Plain allow (no remember) must NOT record a relaxation decision.
    await answer('session-relax-plain', 'tu-relax-plain', false);
    const afterPlain = db
      .prepare("SELECT COUNT(*) AS cnt FROM goal_decisions WHERE goal_id = ? AND title LIKE 'Gate relaxed:%'")
      .get(goalId) as { cnt: number };
    expect(afterPlain.cnt).toBe(0);

    // remember+allow records exactly one auditable, confirmed relaxation decision.
    await answer('session-relax-remember', 'tu-relax-remember', true);
    const rows = db
      .prepare("SELECT title, status, confirmation_required FROM goal_decisions WHERE goal_id = ? AND title LIKE 'Gate relaxed:%'")
      .all(goalId) as { title: string; status: string; confirmation_required: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('Bash:');
    expect(rows[0]!.status).toBe('confirmed');
    expect(rows[0]!.confirmation_required).toBe(0);
    rmSync(ws, { recursive: true, force: true });
  });

  it('remember+deny writes nothing', async () => {
    const goalId = 'goal-remember-2';
    const sessionId = 'session-remember-2';
    const ws = mkdtempSync(join(os.tmpdir(), 'orca-ws-'));
    insertGoal(db, goalId, 'ask');
    insertWorkspace(db, 'ws-remember-2', goalId, ws);
    insertSessionWithWorkspace(db, sessionId, goalId, 'ws-remember-2', 'claude-code');

    const hookPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'rm build' }, tool_use_id: 'tu-remember-2' },
    });

    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'deny', remember: true },
    });
    await hookPromise;

    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  it('remember with an unmapped tool succeeds and writes nothing', async () => {
    const goalId = 'goal-remember-3';
    const sessionId = 'session-remember-3';
    const ws = mkdtempSync(join(os.tmpdir(), 'orca-ws-'));
    insertGoal(db, goalId, 'ask');
    insertWorkspace(db, 'ws-remember-3', goalId, ws);
    insertSessionWithWorkspace(db, sessionId, goalId, 'ws-remember-3', 'claude-code');

    const hookPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      // MultiEdit is held under human_review (an edit tool → require_approval) but
      // has no native-rule mapping in the provider's permissionRule (returns null),
      // so remember+allow must succeed and write nothing.
      payload: { tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/x', edits: [] }, tool_use_id: 'tu-remember-3' },
    });

    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    const res = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'allow', remember: true },
    });
    await hookPromise;

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  // ---- Governed-gate floor + read-only locks ----

  // Hard-constraint action (rm -rf) → deny in human_review, never held, no message.
  it('human_review goal: rm -rf is denied immediately without a chat message (safety floor)', async () => {
    const goalId = 'goal-floor-1';
    const sessionId = 'session-floor-1';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const res = await server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'tu-floor-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('deny');

    const messages = db
      .prepare("SELECT COUNT(*) AS cnt FROM orchestrator_messages WHERE goal_id = ?")
      .get(goalId) as { cnt: number };
    expect(messages.cnt).toBe(0);
  });

  // Read-only tool → allow immediately in human_review, never held, no message.
  it('human_review goal: a read-only tool is allowed immediately without a chat message', async () => {
    const goalId = 'goal-readonly-1';
    const sessionId = 'session-readonly-1';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const res = await server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Glob', tool_input: { pattern: '**' }, tool_use_id: 'tu-readonly-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('allow');

    const messages = db
      .prepare("SELECT COUNT(*) AS cnt FROM orchestrator_messages WHERE goal_id = ?")
      .get(goalId) as { cnt: number };
    expect(messages.cnt).toBe(0);
  });

  // (1a) Accountability writes are best-effort audit. A DB error in
  // recordApprovalOutcome/recordRelaxationDecision must NOT 500 the resolve route
  // (the gate is already unblocked by resolveDecision before the audit writes run).
  // We force the throw deterministically by dropping the gate_approval_counts table
  // so the recordApprovalOutcome upsert can't prepare/execute against it.
  it('resolve route still succeeds (200) when an accountability write throws', async () => {
    const goalId = 'goal-acct-throw';
    const sessionId = 'session-acct-throw';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const permissionPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/permission?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-acct-throw' },
    });

    const approvalId = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL")
          .get(goalId) as { pending_approval: string } | undefined;
        if (!row) throw new Error('pending approval message not yet posted');
        return (JSON.parse(row.pending_approval) as { approvalId: string }).approvalId;
      },
      { timeout: 2000, interval: 50 }
    );

    // Force recordApprovalOutcome to throw: the upsert targets gate_approval_counts.
    // resetPreparedStatements() clears the cached statements so ensure() re-prepares
    // against the now-missing table (raising "no such table") inside the wrapped call.
    db.exec('DROP TABLE gate_approval_counts');
    resetAccountabilityStatements();

    const answerRes = await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/permission-approvals/${approvalId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { decision: 'allow' },
    });

    // The audit write threw, but the route swallowed (logged) it and still succeeded.
    expect(answerRes.statusCode).toBe(200);
    expect(answerRes.json()).toMatchObject({ ok: true });

    // And the gate decision was still applied: the held hook resolves to allow.
    const permissionRes = await permissionPromise;
    expect(permissionRes.statusCode).toBe(200);
    const body = permissionRes.json() as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(body.hookSpecificOutput.decision.behavior).toBe('allow');

    resetAccountabilityStatements();
  });
});

// ---- Worker question (elicit hook) flow ----

describe('worker question (elicit hook) flow', () => {
  let server: FastifyInstance;
  let db: ReturnType<typeof openDatabase>;
  let dataDir: string;

  beforeEach(async () => {
    const result = await startServer();
    server = result.server;
    db = result.db;
    dataDir = result.dataDir;
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Seed a full workflow step-run context so resolveStepContext() returns a
   * non-null result for the given session.
   */
  function insertSessionWithWorkflowContext(
    sessionId: string,
    goalId: string,
  ): { stepRunId: string; workflowRunId: string } {
    const now = new Date().toISOString();
    const workspaceId = `ws-wf-${sessionId}`;
    const templateId = `tmpl-wf-${sessionId}`;
    const workflowRunId = `wr-wf-${sessionId}`;
    const stepRunId = `sr-wf-${sessionId}`;

    db.prepare(
      `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(workspaceId, `/tmp/ws-wf-${sessionId}`, 'test', '', now, now);
    db.prepare(
      `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
    ).run(goalId, workspaceId, now);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, steps_json, created_at, updated_at) VALUES (?, ?, '', 1, '[]', ?, ?)`
    ).run(templateId, 'test-template', now, now);
    db.prepare(
      `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, started_at) VALUES (?, ?, ?, 1, 'active', ?, ?)`
    ).run(workflowRunId, goalId, templateId, stepRunId, now);
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, status, fingerprint, started_at) VALUES (?, ?, ?, 'step-1', 0, 'active', 'fp-test', ?)`
    ).run(stepRunId, goalId, workflowRunId, now);
    db.prepare(
      `INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, workflow_step_run_id, created_at) VALUES (?, ?, ?, 'claude-code', 'test session', 'running', ?, ?)`
    ).run(sessionId, goalId, workspaceId, stepRunId, now);

    return { stepRunId, workflowRunId };
  }

  it('elicit hook stamps stepRunId on pending_question and supersedes open orchestrator question', async () => {
    const goalId = 'goal-elicit-wf';
    const sessionId = 'session-elicit-wf';
    insertGoal(db, goalId, 'ask');
    const { stepRunId } = insertSessionWithWorkflowContext(sessionId, goalId);

    // Pre-seed an open orchestrator question for the same step run.
    const orchMsgId = 'orch-msg-wf';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, pending_question, created_at)
       VALUES (?, ?, 'orchestrator', 'message', 'What should I do?', 'corr-wf', ?, ?)`
    ).run(
      orchMsgId, goalId,
      JSON.stringify({
        questionId: 'orch-q-wf',
        toolUseId: 'tu-orch-wf',
        source: 'orchestrator',
        questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Yes', description: 'Proceed' }], multiSelect: false }],
        stepRunId,
      }),
      now
    );

    // Fire the elicit hook — it returns immediately (the step parks; the answer
    // is delivered to the parked worker out of band).
    const elicitPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/elicit?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        tool_input: { questions: [{ question: 'What next?', header: 'H', options: [{ label: 'OK', description: 'proceed' }], multiSelect: false }] },
        tool_use_id: 'tu-elicit-wf',
      },
    });

    // Wait for the worker question message to appear in orchestrator_messages.
    const workerQ = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_question FROM orchestrator_messages WHERE goal_id = ? AND json_extract(pending_question, '$.source') = 'worker'")
          .get(goalId) as { pending_question: string } | undefined;
        if (!row) throw new Error('worker question message not yet posted');
        return JSON.parse(row.pending_question) as { questionId: string; stepRunId?: string };
      },
      { timeout: 2000, interval: 50 }
    );

    // The worker question must carry stepRunId (Task 6 requirement).
    expect(workerQ.stepRunId).toBe(stepRunId);

    // onWorkerQuestion itself must have superseded the pre-seeded orchestrator
    // question for this step run (no direct helper call — the route does it).
    const orchRow = db
      .prepare("SELECT pending_question FROM orchestrator_messages WHERE id = ?")
      .get(orchMsgId) as { pending_question: string };
    expect(JSON.parse(orchRow.pending_question)).toMatchObject({ withdrawn: true });

    // Answer the question; it is delivered to the parked worker out of band.
    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/worker-questions/${workerQ.questionId}/answer`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { freeText: 'proceed' },
    });
    const elicitRes = await elicitPromise;
    expect(elicitRes.statusCode).toBe(200);
    expect(elicitRes.json().hookSpecificOutput.permissionDecision).toBe('deny');
    // Answering clears the park synchronously (the answer is then delivered out
    // of band), so the worker's Stop-hook no longer treats the step as parked.
    const parked = db
      .prepare('SELECT pending_worker_question_id FROM workflow_step_runs WHERE id = ?')
      .get(stepRunId) as { pending_worker_question_id: string | null };
    expect(parked.pending_worker_question_id).toBeNull();
  });

  it('elicit hook without workflow context: pending_question has no stepRunId (no crash)', async () => {
    const goalId = 'goal-elicit-plain';
    const sessionId = 'session-elicit-plain';
    insertGoal(db, goalId, 'ask');
    insertSession(db, sessionId, goalId);

    const elicitPromise = server.inject({
      method: 'POST',
      url: `/v1/agent-hooks/elicit?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: {
        tool_input: { questions: [{ question: 'Proceed?', header: 'H', options: [{ label: 'OK', description: 'ok' }], multiSelect: false }] },
        tool_use_id: 'tu-elicit-plain',
      },
    });

    const workerQ = await vi.waitFor(
      () => {
        const row = db
          .prepare("SELECT pending_question FROM orchestrator_messages WHERE goal_id = ? AND json_extract(pending_question, '$.source') = 'worker'")
          .get(goalId) as { pending_question: string } | undefined;
        if (!row) throw new Error('worker question not yet posted');
        return JSON.parse(row.pending_question) as { questionId: string; stepRunId?: string };
      },
      { timeout: 2000, interval: 50 }
    );

    // No workflow context → no stepRunId on the message.
    expect(workerQ.stepRunId).toBeUndefined();

    await server.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/worker-questions/${workerQ.questionId}/answer`,
      headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
      payload: { freeText: 'ok' },
    });
    await elicitPromise;
  });
});
