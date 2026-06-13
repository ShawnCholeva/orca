import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { resetWorkflowEventPreparedStatements } from "./events.js";
import { reconcileWorkflowsOnBoot } from "./reconcile.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

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
    getAuthToken: () => "test-token",
  };
}

function setup(): Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-workflows-reconcile-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database, goalId = "goal-1"): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(goalId, "Goal", "desc", NOW, NOW);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileWorkflowsOnBoot", () => {
  it("fails stale pending/running llm calls, blocks active runs, and writes blocked events", () => {
    const db = setup();
    seedGoal(db);
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
    ).run(NOW);
    db.prepare(
      "INSERT INTO workflow_llm_calls (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, provider_version, model, usage_tokens_input, usage_tokens_output, latency_ms, status, failure_code, failure_message, created_at) VALUES ('call-pending', 'goal-1', 'run-1', 'step-1', NULL, 'openai', 'v1', 'gpt-5', NULL, NULL, NULL, 'pending', NULL, NULL, ?), ('call-running', 'goal-1', 'run-1', 'step-1', NULL, 'openai', 'v1', 'gpt-5', NULL, NULL, NULL, 'running', NULL, NULL, ?), ('call-ok', 'goal-1', 'run-1', 'step-1', NULL, 'openai', 'v1', 'gpt-5', NULL, NULL, NULL, 'succeeded', NULL, NULL, ?)"
    ).run(NOW, NOW, NOW);

    reconcileWorkflowsOnBoot(db, () => NOW);

    const calls = db
      .prepare(
        "SELECT id, status, failure_code, failure_message FROM workflow_llm_calls ORDER BY id ASC"
      )
      .all() as Array<{
      id: string;
      status: string;
      failure_code: string | null;
      failure_message: string | null;
    }>;
    expect(calls).toEqual([
      {
        id: "call-ok",
        status: "succeeded",
        failure_code: null,
        failure_message: null,
      },
      {
        id: "call-pending",
        status: "failed",
        failure_code: "daemon_restart",
        failure_message: "daemon restarted during LLM call",
      },
      {
        id: "call-running",
        status: "failed",
        failure_code: "daemon_restart",
        failure_message: "daemon restarted during LLM call",
      },
    ]);

    const run = db
      .prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = 'run-1'")
      .get() as { status: string; blocked_reason: string | null };
    expect(run).toEqual({
      status: "blocked",
      blocked_reason: "daemon_restart_during_llm_call",
    });

    const events = db
      .prepare(
        "SELECT type, goal_id, payload FROM events WHERE type='workflow.run.blocked' ORDER BY seq ASC"
      )
      .all() as Array<{ type: string; goal_id: string | null; payload: string }>;
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.type).toBe("workflow.run.blocked");
      expect(event.goal_id).toBe("goal-1");
      expect(JSON.parse(event.payload)).toMatchObject({
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        failureCode: "daemon_restart",
      });
    }
  });

  it("re-asserts a confirmation checkpoint for a held non-terminal step", () => {
    const db = setup();
    seedGoal(db);
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
    ).run(NOW);
    // held: stash present, step non-terminal, and NO activity row yet
    db.prepare("UPDATE workflow_step_runs SET pending_completion_json = ? WHERE id = 'step-1'").run(
      JSON.stringify({ block: {}, scoring: { successScore: 0.8, quality: { outputCompleteness: 0.8, outputCorrectness: 0.8, instructionAdherence: 0.8, downstreamReadiness: 0.8, riskLevel: 0.2 }, reason: "ok", handoffReady: true }, finishedAt: NOW })
    );

    reconcileWorkflowsOnBoot(db, () => NOW);

    const act = db
      .prepare("SELECT status, source_kind FROM activities WHERE step_run_id = 'step-1' ORDER BY turn_ordinal DESC LIMIT 1")
      .get() as { status: string; source_kind: string } | undefined;
    expect(act?.status).toBe("paused_for_input");
    expect(act?.source_kind).toBe("step_confirmation_pending");
  });

  it("does not flag a run parked on a gate as drift", () => {
    const db = setup();
    seedGoal(db);
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
    ).run(NOW, NOW);
    const runId = "run-gate";
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
    ).run(runId, NOW);
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', ?, 'intake', 0, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-gate')"
    ).run(runId, NOW, NOW);
    // Park the run on a gate: cursor points to a gate node, not a step run
    db.prepare(
      "UPDATE workflow_runs SET current_step_run_id=NULL, current_node_id='gate', current_node_kind='gate' WHERE id=?"
    ).run(runId);

    reconcileWorkflowsOnBoot(db, () => NOW);

    const after = db
      .prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id=?")
      .get(runId) as { status: string; blocked_reason: string | null };
    expect(after.status).toBe("active");
    expect(after.blocked_reason).toBeNull();
  });

  it("repairs active-run step drift by blocking the run and writing blocked event", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedGoal(db, "goal-2");
    seedGoal(db, "goal-3");
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-missing', 'goal-1', 'orca/engineering', 1, 'active', 'missing-step', NULL, ?, NULL), ('run-passed', 'goal-2', 'orca/engineering', 1, 'active', 'step-passed', NULL, ?, NULL), ('run-valid', 'goal-3', 'orca/engineering', 1, 'active', 'step-active', NULL, ?, NULL)"
    ).run(NOW, NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-passed', 'goal-2', 'run-passed', 'intake', 0, 1, 'passed', '[]', '[]', NULL, ?, ?, 'fp-passed'), ('step-active', 'goal-3', 'run-valid', 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-active')"
    ).run(NOW, NOW, NOW);

    reconcileWorkflowsOnBoot(db, () => NOW);

    const runs = db
      .prepare("SELECT id, status, blocked_reason FROM workflow_runs ORDER BY id ASC")
      .all() as Array<{ id: string; status: string; blocked_reason: string | null }>;
    expect(runs).toEqual([
      {
        id: "run-missing",
        status: "blocked",
        blocked_reason: "daemon_restart_state_drift",
      },
      {
        id: "run-passed",
        status: "blocked",
        blocked_reason: "daemon_restart_state_drift",
      },
      {
        id: "run-valid",
        status: "active",
        blocked_reason: null,
      },
    ]);

    const events = db
      .prepare(
        "SELECT payload FROM events WHERE type='workflow.run.blocked' ORDER BY seq ASC"
      )
      .all() as Array<{ payload: string }>;
    const payloads = events.map((event) =>
      JSON.parse(event.payload) as Record<string, unknown>
    );
    expect(payloads).toEqual([
      {
        goalId: "goal-1",
        workflowRunId: "run-missing",
        failureCode: "daemon_restart_state_drift",
      },
      {
        goalId: "goal-2",
        workflowRunId: "run-passed",
        failureCode: "daemon_restart_state_drift",
      },
    ]);
  });
});
