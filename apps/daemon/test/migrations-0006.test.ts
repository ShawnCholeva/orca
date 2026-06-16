import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { defaultMigrationsDir, runMigrations } from '../src/migrations.js';

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

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-context-migration-'));
  tempDirs.push(dir);
  return openDatabase(createConfig(dir));
}

function createMigrationsDir(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-context-migrations-'));
  tempDirs.push(dir);

  const sourceDir = defaultMigrationsDir();
  for (const file of files) {
    copyFileSync(path.join(sourceDir, file), path.join(dir, file));
  }

  return dir;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    'INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'Goal', 'goal for migration tests', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
}

function seedWorkspace(db: Database.Database, id: string, goalId: string): void {
  db.prepare(
    'INSERT INTO workspaces (id, goal_id, path, name, workspace_type, branch, is_dirty, git_probe, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, goalId, '/tmp/ws', 'ws', 'folder', null, null, 'not_a_repo', '2026-01-01T00:00:00.000Z');
}

function seedSession(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    'INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, goalId, workspaceId, 'claude-code', 'Session', 'created', '2026-01-01T00:00:00.000Z');
}

function insertContextPackage(db: Database.Database, params?: { id?: string; role?: string; status?: string }): void {
  db.prepare(
    `INSERT INTO context_packages (
      id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective, status,
      rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
      sources_json, warnings_json, source_fingerprint, assembler_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params?.id ?? 'pkg-1',
    'goal-1',
    null,
    'claude-code',
    'ws-1',
    params?.role ?? 'engineer',
    'objective',
    params?.status ?? 'ready',
    'rendered context',
    15,
    4,
    0,
    0,
    1,
    '[]',
    '[]',
    'source-fp',
    'deterministic-v1',
    '2026-01-01T00:00:00.000Z'
  );
}

function insertContextAssembly(
  db: Database.Database,
  params?: { id?: string; requestFingerprint?: string; status?: string }
): void {
  db.prepare(
    `INSERT INTO context_assemblies (
      id, goal_id, package_id, replace_package_id, adapter_id, workspace_id, role,
      objective_hash, source_fingerprint, assembler_version, request_fingerprint,
      status, trigger, failure_code, failure_message, requested_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params?.id ?? 'asm-1',
    'goal-1',
    null,
    null,
    'claude-code',
    'ws-1',
    'engineer',
    'objective-hash',
    'source-fp',
    'deterministic-v1',
    params?.requestFingerprint ?? 'request-fp',
    params?.status ?? 'pending',
    'prepare',
    null,
    null,
    '2026-01-01T00:00:00.000Z',
    null,
    null
  );
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('context migration 0006_context.sql', () => {
  it('creates expected tables, columns, and indexes on a fresh database', () => {
    const db = freshDb();
    const result = runMigrations(db, defaultMigrationsDir());

    expect(result.applied).toEqual([
      '0001_init.sql',
      '0002_workspaces_refinements.sql',
      '0004_sessions.sql',
      '0005_memory.sql',
      '0006_context.sql',
      '0007_agents.sql',
      '0008_suggested_orchestration.sql',
      '0009_agent_readiness.sql',
      '0010_workflows.sql',
      '0011_workflow_recommendation_types.sql',
      '0012_orchestration_transport.sql',
      '0013_orchestrator_messages.sql',
      '0014_workflow_step_runs_operator_selection.sql',
      '0015_adapter_execution_modes.sql',
      '0016_workflow_step_runs_revise_attempts.sql',
      '0017_orchestrator_messages_chat_kinds.sql',
      '0018_workflow_step_runs_crash_retries.sql',
      '0019_orchestrator_messages_pending_question.sql',
      '0020_drop_removed_provider_execution_modes.sql',
      '0021_workflow_template_scope_graph.sql',
      '0022_workflow_step_result.sql',
      '0023_worker_permission_mode.sql',
      '0024_activities.sql',
      '0025_activity_step_result.sql',
      '0026_app_settings.sql',
      '0027_step_run_pending_completion.sql',
      '0028_step_revision_signals.sql',
      '0029_workflow_graph_cursor.sql',
      '0030_provider_recovery.sql',
      '0031_workflow_ledger.sql',
      '0032_gate_decision_ledger_version.sql',
      '0033_workflow_run_template_snapshot.sql',
    ]);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(tables).toContain('context_packages');
    expect(tables).toContain('context_assemblies');

    const sessionColumns = (db.prepare("PRAGMA table_info('sessions')").all() as { name: string }[]).map(
      (row) => row.name
    );
    expect(sessionColumns).toContain('context_package_id');

    const packageIndexes = (db.prepare("PRAGMA index_list('context_packages')").all() as { name: string }[]).map(
      (row) => row.name
    );
    const assemblyIndexes = (
      db.prepare("PRAGMA index_list('context_assemblies')").all() as {
        name: string;
        unique: 0 | 1;
        partial: 0 | 1;
      }[]
    );
    const sessionIndexes = (
      db.prepare("PRAGMA index_list('sessions')").all() as {
        name: string;
        partial: 0 | 1;
      }[]
    );

    expect(packageIndexes).toContain('idx_context_packages_goal_created');
    expect(assemblyIndexes.map((row) => row.name)).toContain('idx_context_assemblies_goal_requested');
    expect(assemblyIndexes.map((row) => row.name)).toContain('idx_context_assemblies_status_requested');

    const activeFingerprint = assemblyIndexes.find(
      (row) => row.name === 'idx_context_assemblies_active_fingerprint'
    );
    expect(activeFingerprint).toBeDefined();
    expect(activeFingerprint?.unique).toBe(1);
    expect(activeFingerprint?.partial).toBe(1);

    const sessionContextIndex = sessionIndexes.find((row) => row.name === 'idx_sessions_context_package');
    expect(sessionContextIndex).toBeDefined();
    expect(sessionContextIndex?.partial).toBe(1);
  });

  it('upgrades a memory fixture database to context assembly without data loss', () => {
    const db = freshDb();
    const m5Dir = createMigrationsDir([
      '0001_init.sql',
      '0002_workspaces_refinements.sql',
      '0004_sessions.sql',
      '0005_memory.sql',
    ]);

    runMigrations(db, m5Dir);

    seedGoal(db, 'goal-upgrade');
    seedWorkspace(db, 'ws-upgrade', 'goal-upgrade');
    seedSession(db, 'sess-upgrade', 'goal-upgrade', 'ws-upgrade');

    const upgrade = runMigrations(db, defaultMigrationsDir());
    expect(upgrade.applied).toEqual([
      '0006_context.sql',
      '0007_agents.sql',
      '0008_suggested_orchestration.sql',
      '0009_agent_readiness.sql',
      '0010_workflows.sql',
      '0011_workflow_recommendation_types.sql',
      '0012_orchestration_transport.sql',
      '0013_orchestrator_messages.sql',
      '0014_workflow_step_runs_operator_selection.sql',
      '0015_adapter_execution_modes.sql',
      '0016_workflow_step_runs_revise_attempts.sql',
      '0017_orchestrator_messages_chat_kinds.sql',
      '0018_workflow_step_runs_crash_retries.sql',
      '0019_orchestrator_messages_pending_question.sql',
      '0020_drop_removed_provider_execution_modes.sql',
      '0021_workflow_template_scope_graph.sql',
      '0022_workflow_step_result.sql',
      '0023_worker_permission_mode.sql',
      '0024_activities.sql',
      '0025_activity_step_result.sql',
      '0026_app_settings.sql',
      '0027_step_run_pending_completion.sql',
      '0028_step_revision_signals.sql',
      '0029_workflow_graph_cursor.sql',
      '0030_provider_recovery.sql',
      '0031_workflow_ledger.sql',
      '0032_gate_decision_ledger_version.sql',
      '0033_workflow_run_template_snapshot.sql',
    ]);

    const counts = {
      goals: (db.prepare('SELECT count(*) AS cnt FROM goals').get() as { cnt: number }).cnt,
      workspaces: (db.prepare('SELECT count(*) AS cnt FROM workspaces').get() as { cnt: number }).cnt,
      sessions: (db.prepare('SELECT count(*) AS cnt FROM sessions').get() as { cnt: number }).cnt,
    };

    expect(counts).toEqual({ goals: 1, workspaces: 1, sessions: 1 });

    const upgradedSession = db
      .prepare('SELECT id, context_package_id FROM sessions WHERE id = ?')
      .get('sess-upgrade') as { id: string; context_package_id: string | null };

    expect(upgradedSession.id).toBe('sess-upgrade');
    expect(upgradedSession.context_package_id).toBeNull();
  });

  it('enforces the active-fingerprint unique index for pending/running/succeeded rows', () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    insertContextAssembly(db, { id: 'asm-pending-1', requestFingerprint: 'same-fp', status: 'pending' });

    expect(() => {
      insertContextAssembly(db, { id: 'asm-pending-2', requestFingerprint: 'same-fp', status: 'pending' });
    }).toThrow(/UNIQUE constraint failed/);

    insertContextAssembly(db, { id: 'asm-failed-1', requestFingerprint: 'same-fp', status: 'failed' });
  });

  it('supports sessions.context_package_id as nullable FK and sets it to NULL on package delete', () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');
    seedSession(db, 'sess-1', 'goal-1', 'ws-1');

    const before = db
      .prepare('SELECT context_package_id FROM sessions WHERE id = ?')
      .get('sess-1') as { context_package_id: string | null };
    expect(before.context_package_id).toBeNull();

    insertContextPackage(db, { id: 'pkg-1' });

    db.prepare('UPDATE sessions SET context_package_id = ? WHERE id = ?').run('pkg-1', 'sess-1');

    const withPackage = db
      .prepare('SELECT context_package_id FROM sessions WHERE id = ?')
      .get('sess-1') as { context_package_id: string | null };
    expect(withPackage.context_package_id).toBe('pkg-1');

    db.prepare('DELETE FROM context_packages WHERE id = ?').run('pkg-1');

    const afterDelete = db
      .prepare('SELECT context_package_id FROM sessions WHERE id = ?')
      .get('sess-1') as { context_package_id: string | null };
    expect(afterDelete.context_package_id).toBeNull();
  });

  it('rejects unknown role and status values via CHECK constraints', () => {
    const db = freshDb();
    runMigrations(db, defaultMigrationsDir());

    seedGoal(db, 'goal-1');
    seedWorkspace(db, 'ws-1', 'goal-1');

    expect(() => {
      insertContextPackage(db, { id: 'pkg-bad-role', role: 'qa' });
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      insertContextAssembly(db, { id: 'asm-bad-status', status: 'queued' });
    }).toThrow(/CHECK constraint failed/);
  });
});
