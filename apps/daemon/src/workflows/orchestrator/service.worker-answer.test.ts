import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { EventBus } from "../../events.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { OrchestratorService } from "./service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import { fakeStepDispatch } from "./skill-step-test-helpers.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";
const now = () => NOW;

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
    getAuthToken: () => "test-token",
  };
}

type DeliverResult = "delivered" | "no_session" | "timeout";

/** Build a service with stubbed worker stdin delivery + interrupt, recording the
 *  order in which they are called so we can assert the composer is cleared first. */
function makeService(
  workerDeliver: (sessionId: string, text: string) => Promise<DeliverResult>,
  workerInterrupt: (sessionId: string) => Promise<void>
): OrchestratorService {
  const broker = { async propose() { return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: {}, rawTextLength: null, latencyMs: 1 }; } };
  const operators = { async list() { return []; } };
  const launcher = { async launch() { return { sessionId: "sess-x" }; } };
  const engine = new DispatchEngine(broker, operators, launcher as never, fakeStepDispatch(), undefined, workerDeliver, undefined);
  return new OrchestratorService(
    engine,
    broker,
    operators,
    undefined,
    fakeStepDispatch(),
    undefined,
    workerDeliver,
    undefined,
    undefined,
    undefined,
    workerInterrupt
  );
}

/** Seed an active run + active step run + a running worker session for it. */
function seed(db: Database, opts: { withSession: boolean }): { goalId: string; runId: string; stepRunId: string; sessionId: string } {
  const goalId = "goal-1";
  const runId = "run-1";
  const stepRunId = "step-1";
  const sessionId = "session-1";
  const workspaceId = "ws-1";
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'G', 'd', 'active', 1, ?, ?, NULL)"
  ).run(goalId, NOW, NOW);
  db.prepare(
    "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, '/tmp/ws', 'w', '', ?, ?)"
  ).run(workspaceId, NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/t', 'T', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, started_at) VALUES (?, ?, 'orca/t', 1, 'active', ?, ?)"
  ).run(runId, goalId, stepRunId, NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, status, fingerprint, started_at) VALUES (?, ?, ?, 'step-a', 0, 'active', 'fp', ?)"
  ).run(stepRunId, goalId, runId, NOW);
  if (opts.withSession) {
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, workflow_step_run_id, created_at) VALUES (?, ?, ?, 'claude-code', 't', 'running', ?, ?)"
    ).run(sessionId, goalId, workspaceId, stepRunId, NOW);
  }
  return { goalId, runId, stepRunId, sessionId };
}

function setup(): Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-worker-answer-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("deliverWorkerAnswer", () => {
  it("delivers the answer without interrupting the worker (deliver() clears the composer itself)", async () => {
    // An interrupt would trip Claude's Esc-Esc rewind menu and re-wedge the worker;
    // deliver() tolerates the placeholder and clears real leftover with C-u, so the
    // flush must NOT interrupt.
    const db = setup();
    const { goalId, stepRunId } = seed(db, { withSession: true });
    const workerInterrupt = vi.fn(async () => {});
    const workerDeliver = vi.fn(async () => "delivered" as const);
    const service = makeService(workerDeliver, workerInterrupt);

    service.deliverWorkerAnswer(db, now, { goalId, stepRunId, reason: "answer" }, { bus: new EventBus(), idFactory: () => "id" });
    await flush();
    await flush();

    expect(workerDeliver).toHaveBeenCalledWith("session-1", "answer");
    expect(workerInterrupt).not.toHaveBeenCalled();
  });

  it("clears the stash and keeps the run active when delivery succeeds", async () => {
    const db = setup();
    const { goalId, runId, stepRunId } = seed(db, { withSession: true });
    const service = makeService(async () => "delivered", async () => {});

    service.deliverWorkerAnswer(db, now, { goalId, stepRunId, reason: "answer" }, { bus: new EventBus(), idFactory: () => "id" });
    await flush();
    await flush();

    const run = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(runId) as { status: string };
    const step = db.prepare("SELECT pending_worker_answer_json FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { pending_worker_answer_json: string | null };
    expect(run.status).toBe("active");
    expect(step.pending_worker_answer_json).toBeNull();
  });

  it("blocks the run with a clear reason when delivery times out", async () => {
    const db = setup();
    const { goalId, runId, stepRunId } = seed(db, { withSession: true });
    const service = makeService(async () => "timeout", async () => {});

    service.deliverWorkerAnswer(db, now, { goalId, stepRunId, reason: "answer" }, { bus: new EventBus(), idFactory: () => "id" });
    await flush();
    await flush();

    const run = db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = ?").get(runId) as { status: string; blocked_reason: string | null };
    const step = db.prepare("SELECT pending_worker_answer_json FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { pending_worker_answer_json: string | null };
    const blockedEvent = db.prepare("SELECT count(*) AS n FROM events WHERE type = 'workflow.run.blocked' AND json_extract(payload, '$.workflowRunId') = ?").get(runId) as { n: number };
    expect(run.status).toBe("blocked");
    expect(run.blocked_reason).toBe("worker_answer_delivery_failed");
    expect(step.pending_worker_answer_json).toBeNull();
    expect(blockedEvent.n).toBe(1);
  });

  it("blocks the run when there is no live worker session to deliver to", async () => {
    const db = setup();
    const { goalId, runId, stepRunId } = seed(db, { withSession: false });
    const service = makeService(async () => "delivered", async () => {});

    service.deliverWorkerAnswer(db, now, { goalId, stepRunId, reason: "answer" }, { bus: new EventBus(), idFactory: () => "id" });
    await flush();

    const run = db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = ?").get(runId) as { status: string; blocked_reason: string | null };
    const step = db.prepare("SELECT pending_worker_question_id FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { pending_worker_question_id: string | null };
    expect(run.status).toBe("blocked");
    expect(run.blocked_reason).toBe("worker_answer_delivery_failed");
    expect(step.pending_worker_question_id).toBeNull();
  });
});
