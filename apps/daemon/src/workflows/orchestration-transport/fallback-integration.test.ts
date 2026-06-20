import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  GetOrchestrationWorkerResponse,
  ListOrchestrationAttemptsResponse,
  ListSessionsResponse,
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  type DomainEvent,
  type OrchestrationRequest as OrchestrationRequestT,
} from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { createServer } from "../../server.js";
import { insertSession, resetPreparedStatements } from "../../sessions/projection.js";
import {
  markTransportAttemptFailed,
  markTransportAttemptRunning,
  markTransportAttemptSucceeded,
  type TransportAttemptUsecaseCtx,
} from "./attempts.js";
import { OrchestrationTransportBroker } from "./broker.js";

const NOW = "2026-01-01T00:00:00.000Z";
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
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
    getAuthToken: () => "test-token",
  };
}

function setup(): {
  db: Database.Database;
  bus: EventBus;
  events: DomainEvent[];
  attemptCtx: TransportAttemptUsecaseCtx;
  broker: OrchestrationTransportBroker;
  config: Config;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-transport-integration-"));
  tempDirs.push(dir);
  const config = createConfig(dir);
  const db = openDatabase(config);
  runMigrations(db, defaultMigrationsDir());
  seedWorkflowGraph(db);
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let nextId = 0;
  const attemptCtx = {
    db,
    bus,
    now: () => NOW,
    idFactory: () => `transport-int-${++nextId}`,
  };
  return {
    db,
    bus,
    events,
    attemptCtx,
    broker: new OrchestrationTransportBroker(attemptCtx),
    config,
  };
}

function seedWorkflowGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('ws-1', '/tmp/ws', 'ws', '', NOW, NOW);
  db.prepare(
    `INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run('goal-1', 'ws-1', NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-step-1')"
  ).run(NOW);
}

function request(providerId: OrchestrationRequestT["providerId"]): OrchestrationRequestT {
  return {
    kind: "select_operator",
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    providerId,
    modelId: "model-1",
    payload: {
      stepName: "execution",
      stepPurpose: "Pick an operator",
      readyOperators: [{ id: "human", kind: "human", capabilities: ["judgment"] }],
    },
  };
}

function attemptRows(db: Database.Database): Array<{
  transport: string;
  status: string;
  failure_reason: string | null;
}> {
  return db
    .prepare(
      "SELECT transport, status, failure_reason FROM orchestration_transport_attempts ORDER BY rowid ASC"
    )
    .all() as Array<{
    transport: string;
    status: string;
    failure_reason: string | null;
  }>;
}

afterEach(async () => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("transport fallback proof integration", () => {
  it("falls back from one-shot failure to hidden interactive success without human review", async () => {
    const { broker, db, attemptCtx } = setup();

    const result = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_parse_failed",
        failureMessage: "invalid envelope",
        rawTextLength: 19,
        latencyMs: 4,
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptSucceeded(attemptCtx, {
          attemptId,
          rawTextLength: 84,
          latencyMs: 12,
        });
        return {
          status: "proposed",
          parsed: { operatorId: "human", operatorKind: "human" },
          rawTextLength: 84,
          latencyMs: 12,
        };
      },
    });

    expect(result).toMatchObject({
      status: "proposed",
      transport: "hidden_interactive",
    });
    expect(attemptRows(db)).toEqual([
      {
        transport: "one_shot",
        status: "failed",
        failure_reason: "one_shot_parse_failed",
      },
      {
        transport: "hidden_interactive",
        status: "succeeded",
        failure_reason: null,
      },
    ]);
  });

  it("requests human review after automated transports fail", async () => {
    const { broker, db, events, attemptCtx } = setup();

    const result = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_rate_limited",
        failureMessage: "quota exceeded",
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptFailed(attemptCtx, {
          attemptId,
          failureReason: "interactive_hung",
          failureMessage: "worker hung",
        });
        return {
          status: "failed",
          failureReason: "interactive_hung",
          failureMessage: "worker hung",
        };
      },
    });

    expect(result.status).toBe("needs_human_review");
    expect(attemptRows(db).map((row) => row.transport)).toEqual([
      "one_shot",
      "hidden_interactive",
      "human_review",
    ]);
    expect(events.map((event) => event.type)).toContain("workflow.human_review.requested");
    const reviewCount = (
      db
        .prepare("SELECT count(*) AS count FROM orchestration_human_reviews WHERE attempt_id = ? AND status = 'pending'")
        .get(result.attemptId) as { count: number }
    ).count;
    expect(reviewCount).toBe(1);
  });

  it("keeps hidden workers out of session lists and returns capped debug diagnostics", async () => {
    const { db, config } = setup();
    let server: FastifyInstance | undefined;
    try {
      insertSession(db, {
        id: "session-visible",
        goalId: "goal-1",
        workspaceId: "ws-1",
        adapterId: "claude-code",
        title: "Visible session",
        status: "created",
        createdAt: NOW,
      });
      db.prepare(
        "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, current_goal_id, current_workflow_run_id, current_step_run_id, last_health_at, created_at) VALUES ('worker-debug', 'orca/openai', 'gpt-5', 'codex', 'ready', 'goal-1', 'run-1', 'step-1', ?, ?)"
      ).run(NOW, NOW);
      db.prepare(
        "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-debug', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-debug', 'failed', 'interactive_output_invalid', 'token=[redacted]', 120, 10, 'fp-debug', ?, ?)"
      ).run(NOW, NOW);
      const output = Buffer.from(
        `${"x".repeat(ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES + 32)} authorization: bearer [redacted]`,
        "utf8"
      );
      db.prepare(
        "INSERT INTO orchestration_worker_output_chunks (worker_id, seq, byte_offset, byte_length, written_at, data) VALUES ('worker-debug', 0, 0, ?, ?, ?)"
      ).run(output.length, NOW, output);

      server = createServer(config);

      const sessionsResponse = await server.inject({
        method: "GET",
        url: "/v1/goals/goal-1/sessions",
        headers: AUTH_HEADERS,
      });
      expect(sessionsResponse.statusCode).toBe(200);
      const sessions = ListSessionsResponse.parse(JSON.parse(sessionsResponse.body));
      expect(sessions.sessions.map((session) => session.id)).toEqual(["session-visible"]);

      const attemptsResponse = await server.inject({
        method: "GET",
        url: "/v1/goals/goal-1/orchestration-attempts?workflowRunId=run-1",
        headers: AUTH_HEADERS,
      });
      expect(attemptsResponse.statusCode).toBe(200);
      const attempts = ListOrchestrationAttemptsResponse.parse(JSON.parse(attemptsResponse.body));
      expect(attempts.attempts[0]?.diagnostics).toContain("token=[redacted]");
      expect(attempts.attempts[0]?.diagnostics).not.toContain("sk-");

      const workerResponse = await server.inject({
        method: "GET",
        url: "/v1/orchestration-workers/worker-debug",
        headers: AUTH_HEADERS,
      });
      expect(workerResponse.statusCode).toBe(200);
      const worker = GetOrchestrationWorkerResponse.parse(JSON.parse(workerResponse.body)).worker;
      expect(Buffer.byteLength(worker.outputTail ?? "", "utf8")).toBeLessThanOrEqual(
        ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
      );
      expect(worker.outputTail).toContain("authorization: bearer [redacted]");
      expect(worker.outputTail).not.toContain("secret");
    } finally {
      await server?.close();
    }
  });
});
