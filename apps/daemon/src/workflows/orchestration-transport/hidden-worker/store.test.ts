import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { closeDatabase, openDatabase } from "../../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../../migrations.js";
import { createOrchestrationWorkerStore } from "./store.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-worker-store-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedWorkflowGraph(db: Database.Database): void {
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
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'intake', 1, 1, 'pending', '[]', '[]', NULL, ?, NULL, 'fp-step-1')"
  ).run(NOW);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestrationWorkerStore", () => {
  it("creates workers, assigns goal/run/step, transitions state, and marks stopped", () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const store = createOrchestrationWorkerStore(db, { now: () => NOW });

    const created = store.createWorker({
      id: "worker-1",
      providerId: "orca/openai",
      modelId: "gpt-5",
      adapterId: "codex",
      state: "starting",
      pid: 1234,
      command: "codex",
      argsJson: '["agent"]',
      cwd: "/tmp",
      createdAt: NOW,
      startedAt: NOW,
    });
    expect(created.state).toBe("starting");
    expect(created.pid).toBe(1234);

    const assigned = store.updateWorkerAssignment({
      workerId: "worker-1",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
    });
    expect(assigned.current_goal_id).toBe("goal-1");
    expect(assigned.current_workflow_run_id).toBe("run-1");
    expect(assigned.current_step_run_id).toBe("step-1");

    const ready = store.transitionWorkerState({
      workerId: "worker-1",
      state: "ready",
      lastHealthAt: NOW,
      startedAt: NOW,
    });
    expect(ready.state).toBe("ready");
    expect(ready.last_health_at).toBe(NOW);

    const stopped = store.markWorkerStopped("worker-1", NOW);
    expect(stopped.state).toBe("stopped");
    expect(stopped.stopped_at).toBe(NOW);
    expect(stopped.current_goal_id).toBeNull();
    expect(stopped.current_workflow_run_id).toBeNull();
    expect(stopped.current_step_run_id).toBeNull();
    expect(stopped.failure_reason).toBeNull();
    expect(stopped.failure_detail).toBeNull();
  });

  it("marks failed workers with sanitized and capped failure details", () => {
    const db = setupDb();
    const store = createOrchestrationWorkerStore(db, { now: () => NOW });
    store.createWorker({
      id: "worker-2",
      providerId: "orca/openai",
      modelId: "gpt-5",
      adapterId: "codex",
      state: "ready",
      createdAt: NOW,
    });

    const failed = store.markWorkerFailed({
      workerId: "worker-2",
      failureReason: "interactive_auth_lost",
      failureDetail: `Authorization: Bearer abc.def.ghi ${"x".repeat(400)}`,
      stoppedAt: NOW,
    });

    expect(failed.state).toBe("failed");
    expect(failed.failure_reason).toBe("interactive_auth_lost");
    expect(failed.failure_detail).not.toContain("abc.def.ghi");
    expect(failed.failure_detail).toContain("<redacted>");
    expect((failed.failure_detail ?? "").length).toBeLessThanOrEqual(256);
    expect(failed.stopped_at).toBe(NOW);
  });

  it("persists output chunks with byte offsets, redacts output, and caps retention", () => {
    const db = setupDb();
    const store = createOrchestrationWorkerStore(db, {
      outputRetentionBytes: 16,
      outputTailBytes: 16,
      now: () => NOW,
    });
    store.createWorker({
      id: "worker-3",
      providerId: "orca/openai",
      modelId: "gpt-5",
      adapterId: "codex",
      state: "ready",
      createdAt: NOW,
    });

    const first = store.appendWorkerOutput(
      "worker-3",
      Buffer.from("abcdefghijklmnopqrst", "utf8")
    );
    expect(first).toEqual({ seq: 0, byteOffset: 4, byteLength: 16 });

    const second = store.appendWorkerOutput(
      "worker-3",
      Buffer.from("token=sk-ant-AbCdEfGhIjKlMnOpQrSt", "utf8")
    );
    expect(second.seq).toBe(1);
    expect(second.byteOffset).toBe(20);
    expect(second.byteLength).toBeLessThanOrEqual(16);

    const persisted = db
      .prepare(
        "SELECT seq, byte_offset, byte_length, data FROM orchestration_worker_output_chunks WHERE worker_id = ? ORDER BY seq ASC"
      )
      .all("worker-3") as Array<{
      seq: number;
      byte_offset: number;
      byte_length: number;
      data: Buffer;
    }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].seq).toBe(1);
    expect(persisted[0].byte_offset).toBe(20);
    expect(persisted[0].byte_length).toBe(second.byteLength);
    expect(persisted[0].data.toString("utf8")).toContain("<redacted>");
    expect(persisted[0].data.toString("utf8")).not.toContain("sk-ant-");

    const worker = store.getWorker("worker-3");
    expect(worker.last_output_at).toBe(NOW);
  });

  it("caps output-tail responses independently of retained bytes", () => {
    const db = setupDb();
    const store = createOrchestrationWorkerStore(db, {
      outputRetentionBytes: 64,
      outputTailBytes: 8,
      now: () => NOW,
    });
    store.createWorker({
      id: "worker-4",
      providerId: "orca/openai",
      modelId: "gpt-5",
      adapterId: "codex",
      state: "ready",
      createdAt: NOW,
    });

    store.appendWorkerOutput("worker-4", Buffer.from("abcd", "utf8"));
    store.appendWorkerOutput("worker-4", Buffer.from("efgh", "utf8"));
    store.appendWorkerOutput("worker-4", Buffer.from("ijkl", "utf8"));

    const tail = store.readWorkerOutputTail("worker-4");
    expect(tail.totalBytesKept).toBe(12);
    expect(tail.tailBytesReturned).toBe(8);
    expect(Buffer.byteLength(tail.tailText, "utf8")).toBeLessThanOrEqual(8);
    expect(tail.tailText).toBe("efghijkl");
  });

  it("keeps hidden-worker output isolated from sessions and workflow events", () => {
    const db = setupDb();
    const store = createOrchestrationWorkerStore(db, { now: () => NOW });
    store.createWorker({
      id: "worker-5",
      providerId: "orca/openai",
      modelId: "gpt-5",
      adapterId: "codex",
      state: "ready",
      createdAt: NOW,
    });

    store.appendWorkerOutput("worker-5", Buffer.from("output", "utf8"));
    const tail = store.readWorkerOutputTail("worker-5");
    expect(tail.tailText).toBe("output");

    const sessionChunkCount = (
      db.prepare("SELECT count(*) AS cnt FROM session_output_chunks").get() as { cnt: number }
    ).cnt;
    expect(sessionChunkCount).toBe(0);

    const eventCount = (
      db
        .prepare("SELECT count(*) AS cnt FROM events WHERE type LIKE 'workflow.worker.%'")
        .get() as { cnt: number }
    ).cnt;
    expect(eventCount).toBe(0);
  });
});
