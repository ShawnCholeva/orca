import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token"
  };
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tableColumns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function sqliteObjects(
  db: ReturnType<typeof openDatabase>,
  type: "table" | "index"
): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = ?")
      .all(type) as { name: string }[]
  ).map((row) => row.name);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("suggested orchestration migration schema", () => {
  it("creates all orchestration tables, columns, and indexes on a fresh DB", () => {
    const dataDir = createTempDir("orca-orchestration-migration-fresh-");
    const db = openDatabase(createConfig(dataDir));

    runMigrations(db, defaultMigrationsDir());

    const tables = sqliteObjects(db, "table");
    expect(tables).toContain("tasks");
    expect(tables).toContain("task_generations");
    expect(tables).toContain("recommendations");
    expect(tables).toContain("recommendation_generations");
    expect(tables).toContain("recommendation_feedback");
    expect(tables).toContain("conflicts");

    const indexes = sqliteObjects(db, "index");
    const requiredIndexes = [
      "idx_tasks_goal_status_created",
      "idx_tasks_workspace_status",
      "idx_tasks_parent",
      "idx_tasks_goal_fingerprint_active",
      "idx_task_generations_active_fp",
      "idx_task_generations_goal_requested",
      "idx_task_generations_status",
      "idx_recs_goal_status_created",
      "idx_recs_goal_type",
      "idx_recs_task",
      "idx_recs_session",
      "idx_recs_conflict",
      "idx_recs_goal_fingerprint_active",
      "idx_rec_generations_active_fp",
      "idx_rec_generations_goal_requested",
      "idx_rec_generations_status",
      "idx_feedback_goal_created",
      "idx_feedback_recommendation",
      "idx_feedback_terminal_action",
      "idx_conflicts_goal_status",
      "idx_conflicts_goal_fp_open",
      "idx_sessions_task",
      "idx_context_packages_task"
    ];

    for (const indexName of requiredIndexes) {
      expect(indexes).toContain(indexName);
    }

    expect(tableColumns(db, "sessions")).toContain("task_id");
    expect(tableColumns(db, "sessions")).toContain("from_recommendation_id");
    expect(tableColumns(db, "context_packages")).toContain("task_id");
    expect(tableColumns(db, "context_packages")).toContain("from_recommendation_id");
  });

  it("upgrades a recorded context baseline fixture DB without mutating pre-existing row counts", () => {
    const fixturePath = fileURLToPath(
      new URL("../../test-fixtures/context-baseline.sqlite", import.meta.url)
    );

    expect(existsSync(fixturePath)).toBe(true);

    const dataDir = createTempDir("orca-orchestration-migration-upgrade-");
    copyFileSync(fixturePath, path.join(dataDir, "orca.db"));

    const db = openDatabase(createConfig(dataDir));

    const preCounts = {
      goals: (db.prepare("SELECT count(*) AS cnt FROM goals").get() as { cnt: number }).cnt,
      workspaces: (db.prepare("SELECT count(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt,
      sessions: (db.prepare("SELECT count(*) AS cnt FROM sessions").get() as { cnt: number }).cnt,
      contextPackages: (
        db.prepare("SELECT count(*) AS cnt FROM context_packages").get() as { cnt: number }
      ).cnt,
      contextAssemblies: (
        db.prepare("SELECT count(*) AS cnt FROM context_assemblies").get() as { cnt: number }
      ).cnt
    };

    const result = runMigrations(db, defaultMigrationsDir());
    expect(result.applied).toEqual([
      "0007_agents.sql",
      "0008_suggested_orchestration.sql",
      "0009_agent_readiness.sql",
      "0010_workflows.sql",
      "0011_workflow_recommendation_types.sql",
      "0012_orchestration_transport.sql",
      "0013_orchestrator_messages.sql",
      "0014_workflow_step_runs_operator_selection.sql",
      "0015_adapter_execution_modes.sql",
      "0016_workflow_step_runs_revise_attempts.sql",
      "0017_orchestrator_messages_chat_kinds.sql",
      "0018_workflow_step_runs_crash_retries.sql",
      "0019_orchestrator_messages_pending_question.sql",
      "0020_drop_removed_provider_execution_modes.sql",
      "0021_workflow_template_scope_graph.sql",
      "0022_workflow_step_result.sql",
      "0023_worker_permission_mode.sql",
      "0024_activities.sql",
      "0025_activity_step_result.sql",
      "0026_app_settings.sql",
      "0027_step_run_pending_completion.sql",
      "0028_step_revision_signals.sql",
      "0029_workflow_graph_cursor.sql",
      "0030_provider_recovery.sql",
      "0031_workflow_ledger.sql",
      "0032_gate_decision_ledger_version.sql",
      "0033_workflow_run_template_snapshot.sql",
      "0034_activity_steps.sql",
      "0035_orchestrator_message_pending_revision.sql",
      "0036_workspaces_first_class.sql",
      "0037_step_run_pending_judge.sql",
      "0038_workflow_split_decisions.sql",
      "0039_workflow_run_pending_split_route.sql",
      "0040_harness_transitions.sql",
      "0041_goal_operating_mode.sql",
      "0042_gate_approval_counts.sql",
      "0043_activity_recommendation_id.sql",
      "0044_workflow_template_category.sql",
      "0045_step_run_confirmed_lead.sql",
      "0046_step_run_pending_revision.sql",
      "0047_activity_steps_tool_use_id.sql",
      "0048_step_run_prior_claims.sql",
      "0049_learning_proposals.sql",
      "0050_workflow_compositions.sql",
      "0051_workflow_template_inputs.sql",
      "0052_harness_transitions_refute.sql",
      "0053_learning_proposal_judgment.sql",
      "0054_decision_reasoning.sql",
      "0055_proposal_component.sql",
      "0056_learning_events.sql",
      "0057_template_catalog_version.sql",
      "0058_goal_documents.sql",
      "0059_goal_intent_rename.sql",
      "0060_orchestrator_phase.sql"
    ]);

    const postCounts = {
      goals: (db.prepare("SELECT count(*) AS cnt FROM goals").get() as { cnt: number }).cnt,
      workspaces: (db.prepare("SELECT count(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt,
      sessions: (db.prepare("SELECT count(*) AS cnt FROM sessions").get() as { cnt: number }).cnt,
      contextPackages: (
        db.prepare("SELECT count(*) AS cnt FROM context_packages").get() as { cnt: number }
      ).cnt,
      contextAssemblies: (
        db.prepare("SELECT count(*) AS cnt FROM context_assemblies").get() as { cnt: number }
      ).cnt
    };

    expect(postCounts).toEqual(preCounts);

    const sessionsWithAssociations = (
      db
        .prepare(
          "SELECT count(*) AS cnt FROM sessions WHERE task_id IS NOT NULL OR from_recommendation_id IS NOT NULL"
        )
        .get() as { cnt: number }
    ).cnt;
    expect(sessionsWithAssociations).toBe(0);

    const contextPackagesWithAssociations = (
      db
        .prepare(
          "SELECT count(*) AS cnt FROM context_packages WHERE task_id IS NOT NULL OR from_recommendation_id IS NOT NULL"
        )
        .get() as { cnt: number }
    ).cnt;
    expect(contextPackagesWithAssociations).toBe(0);
  });
});
