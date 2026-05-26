import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { EventBus } from "../../../events.js";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { closeDatabase, openDatabase } from "../../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../../migrations.js";
import {
  findReusableWorker,
  isWorkerHealthCurrent,
  reconcileHiddenWorkersOnBoot,
} from "./reconcile.js";

const NOW = "2026-01-01T00:00:00.000Z";
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
    getAuthToken: () => "test-token",
  };
}

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-worker-reconcile-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-step-1')"
  ).run(NOW);
  db.prepare("UPDATE workflow_runs SET current_step_run_id = 'step-1' WHERE id = 'run-1'").run();
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileHiddenWorkersOnBoot", () => {
  it("marks stale workers and attempts failed with daemon_restart and emits events", () => {
    const db = setupDb();
    seedGraph(db);
    const bus = new EventBus();

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, current_goal_id, current_workflow_run_id, current_step_run_id, created_at) VALUES ('worker-starting', 'orca/openai', 'gpt-5', 'codex', 'starting', 'goal-1', 'run-1', 'step-1', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, current_goal_id, current_workflow_run_id, current_step_run_id, created_at) VALUES ('worker-ready', 'orca/openai', 'gpt-5', 'codex', 'ready', 'goal-1', 'run-1', 'step-1', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, created_at) VALUES ('worker-stopped', 'orca/openai', 'gpt-5', 'codex', 'stopped', ?)"
    ).run(NOW);

    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-pending', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-ready', 'pending', NULL, NULL, NULL, NULL, 'fp-1', ?, NULL)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-running', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-starting', 'running', NULL, NULL, NULL, NULL, 'fp-2', ?, NULL)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-succeeded', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'one_shot', NULL, 'succeeded', NULL, NULL, NULL, NULL, 'fp-3', ?, ?)"
    ).run(NOW, NOW);

    reconcileHiddenWorkersOnBoot({ db, bus, now: NOW, idFactory: makeIdFactory() });

    const workers = db
      .prepare(
        "SELECT id, state, failure_reason, stopped_at, current_goal_id, current_workflow_run_id, current_step_run_id FROM orchestration_workers ORDER BY id ASC"
      )
      .all() as Array<Record<string, unknown>>;
    expect(workers).toEqual([
      {
        id: "worker-ready",
        state: "failed",
        failure_reason: "daemon_restart",
        stopped_at: NOW,
        current_goal_id: null,
        current_workflow_run_id: null,
        current_step_run_id: null,
      },
      {
        id: "worker-starting",
        state: "failed",
        failure_reason: "daemon_restart",
        stopped_at: NOW,
        current_goal_id: null,
        current_workflow_run_id: null,
        current_step_run_id: null,
      },
      {
        id: "worker-stopped",
        state: "stopped",
        failure_reason: null,
        stopped_at: null,
        current_goal_id: null,
        current_workflow_run_id: null,
        current_step_run_id: null,
      },
    ]);

    const attempts = db
      .prepare("SELECT id, status, failure_reason, finished_at FROM orchestration_transport_attempts ORDER BY id ASC")
      .all() as Array<Record<string, unknown>>;
    expect(attempts).toEqual([
      {
        id: "attempt-pending",
        status: "failed",
        failure_reason: "daemon_restart",
        finished_at: NOW,
      },
      {
        id: "attempt-running",
        status: "failed",
        failure_reason: "daemon_restart",
        finished_at: NOW,
      },
      {
        id: "attempt-succeeded",
        status: "succeeded",
        failure_reason: null,
        finished_at: NOW,
      },
    ]);

    const eventRows = db
      .prepare(
        "SELECT type, payload FROM events WHERE type IN ('workflow.worker.state_changed', 'workflow.transport.attempt_finished') ORDER BY seq ASC"
      )
      .all() as Array<{ type: string; payload: string }>;
    expect(eventRows).toHaveLength(4);
    for (const row of eventRows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload.failureReason).toBe("daemon_restart");
    }
  });

  it("is idempotent once stale rows are reconciled", () => {
    const db = setupDb();
    seedGraph(db);
    const bus = new EventBus();

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, current_goal_id, current_workflow_run_id, current_step_run_id, created_at) VALUES ('worker-ready', 'orca/openai', 'gpt-5', 'codex', 'ready', 'goal-1', 'run-1', 'step-1', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-running', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-ready', 'running', NULL, NULL, NULL, NULL, 'fp-1', ?, NULL)"
    ).run(NOW);

    reconcileHiddenWorkersOnBoot({ db, bus, now: NOW, idFactory: makeIdFactory() });
    reconcileHiddenWorkersOnBoot({ db, bus, now: NOW, idFactory: makeIdFactory() });

    const count = (
      db
        .prepare(
          "SELECT count(*) AS cnt FROM events WHERE type IN ('workflow.worker.state_changed', 'workflow.transport.attempt_finished')"
        )
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(2);
  });

  it("is wired on daemon boot before HTTP listen", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/index.ts"), "utf8");
    const workflowReconciler = source.indexOf("reconcileWorkflowsOnBoot(db, () => new Date().toISOString())");
    const hiddenWorkerReconciler = source.indexOf(
      "reconcileHiddenWorkersOnBoot({ db, bus: eventBus, now: bootNow });"
    );
    const listen = source.indexOf("await server.listen");

    expect(workflowReconciler).toBeGreaterThan(0);
    expect(hiddenWorkerReconciler).toBeGreaterThan(workflowReconciler);
    expect(listen).toBeGreaterThan(hiddenWorkerReconciler);
  });
});

describe("hidden-worker reuse policy", () => {
  it("accepts reuse only for provider/model match in ready/awaiting_input with current health", () => {
    const db = setupDb();
    seedGraph(db);

    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, last_health_at, created_at) VALUES ('worker-a', 'orca/openai', 'gpt-5', 'codex', 'ready', '2026-01-01T00:00:00.000Z', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, last_health_at, created_at) VALUES ('worker-b', 'orca/openai', 'gpt-5', 'codex', 'awaiting_input', '2025-12-31T23:58:00.000Z', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, last_health_at, created_at) VALUES ('worker-c', 'orca/openai', 'gpt-5', 'codex', 'hung', '2026-01-01T00:00:00.000Z', ?)"
    ).run(NOW);
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, last_health_at, created_at) VALUES ('worker-d', 'orca/openai', 'gpt-4.1', 'codex', 'ready', '2026-01-01T00:00:00.000Z', ?)"
    ).run(NOW);

    const reused = findReusableWorker({
      db,
      providerId: "orca/openai",
      modelId: "gpt-5",
      nowMs: Date.parse("2026-01-01T00:00:20.000Z"),
      healthMaxAgeMs: 60_000,
    });
    expect(reused?.id).toBe("worker-a");
  });

  it("treats missing, stale, or invalid health timestamp as not current", () => {
    const nowMs = Date.parse("2026-01-01T00:01:00.000Z");
    expect(isWorkerHealthCurrent(null, nowMs, 60_000)).toBe(false);
    expect(isWorkerHealthCurrent("bad", nowMs, 60_000)).toBe(false);
    expect(isWorkerHealthCurrent("2026-01-01T00:00:10.000Z", nowMs, 60_000)).toBe(true);
    expect(isWorkerHealthCurrent("2025-12-31T23:59:00.000Z", nowMs, 60_000)).toBe(false);
  });
});

function makeIdFactory(): () => string {
  let counter = 0;
  return () => `event-${++counter}`;
}
