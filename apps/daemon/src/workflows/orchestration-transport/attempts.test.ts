import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import {
  WORKFLOW_EVENT_MAX_PAYLOAD_BYTES,
  type DomainEvent,
  type OrchestrationTransportFailureReason,
} from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { ProviderError, type ProviderFailureCode } from "../../llm/types.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import {
  createPendingTransportAttempt,
  mapProviderErrorToTransportFailureReason,
  markTransportAttemptFailed,
  markTransportAttemptFallback,
  markTransportAttemptRejected,
  markTransportAttemptRunning,
  markTransportAttemptSucceeded,
  type TransportAttemptUsecaseCtx,
} from "./attempts.js";

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  ctx: TransportAttemptUsecaseCtx;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-transport-attempts-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedWorkflowGraph(db);
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  let nextId = 0;
  return {
    db,
    events,
    ctx: {
      db,
      bus,
      now: () => NOW,
      idFactory: () => `fixed-id-${++nextId}`,
    },
  };
}

function seedWorkflowGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 4, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
  ).run(NOW);
  db.prepare("UPDATE workflow_runs SET current_step_run_id = 'step-1' WHERE id = 'run-1'").run();
}

function createAttempt(
  ctx: TransportAttemptUsecaseCtx,
  transport: "one_shot" | "hidden_interactive" | "human_review" = "one_shot"
): string {
  return createPendingTransportAttempt(ctx, {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    decisionKind: "select_operator",
    providerId: "orca/openai",
    modelId: "gpt-5",
    transport,
    inputFingerprint: "fp-input",
  }).id;
}

function persistedEventTypes(db: Database.Database): string[] {
  return (
    db.prepare("SELECT type FROM events ORDER BY seq ASC").all() as { type: string }[]
  ).map((row) => row.type);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("orchestration transport attempts", () => {
  it("creates a pending attempt and emits a compact started event after commit", () => {
    const { db, events, ctx } = setup();

    const attempt = createPendingTransportAttempt(ctx, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      decisionId: null,
      decisionKind: "select_operator",
      providerId: "orca/openai",
      modelId: "gpt-5",
      transport: "one_shot",
      inputFingerprint: "fp-input",
    });

    expect(attempt).toMatchObject({
      id: "fixed-id-1",
      goal_id: "goal-1",
      workflow_run_id: "run-1",
      step_run_id: "step-1",
      provider_id: "orca/openai",
      model: "gpt-5",
      transport: "one_shot",
      status: "pending",
      input_fingerprint: "fp-input",
      created_at: NOW,
      finished_at: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "workflow.transport.attempt_started",
      payload: {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        attemptId: "fixed-id-1",
        providerId: "orca/openai",
        transport: "one_shot",
        status: "pending",
      },
    });
    expect(persistedEventTypes(db)).toEqual(["workflow.transport.attempt_started"]);
  });

  it("writes an event for every attempt transition", () => {
    const { db, events, ctx } = setup();

    const runningId = createAttempt(ctx);
    markTransportAttemptRunning(ctx, runningId);

    const succeededId = createAttempt(ctx);
    markTransportAttemptSucceeded(ctx, { attemptId: succeededId, rawTextLength: 42, latencyMs: 9 });

    const rejectedId = createAttempt(ctx);
    markTransportAttemptRejected(ctx, {
      attemptId: rejectedId,
      failureMessage: "guardrail denied token=secret",
    });

    const failedId = createAttempt(ctx);
    markTransportAttemptFailed(ctx, {
      attemptId: failedId,
      failureReason: "one_shot_unavailable",
      failureMessage: "provider unavailable",
    });

    const fallbackId = createAttempt(ctx);
    markTransportAttemptFallback(ctx, {
      attemptId: fallbackId,
      failureReason: "one_shot_parse_failed",
      failureMessage: "invalid envelope",
    });

    expect(events.map((event) => event.type)).toEqual([
      "workflow.transport.attempt_started",
      "workflow.transport.attempt_started",
      "workflow.transport.attempt_started",
      "workflow.transport.attempt_finished",
      "workflow.transport.attempt_started",
      "workflow.transport.attempt_finished",
      "workflow.transport.attempt_started",
      "workflow.transport.attempt_finished",
      "workflow.transport.attempt_started",
      "workflow.transport.fallback",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      attemptId: fallbackId,
      status: "fallback",
      failureReason: "one_shot_parse_failed",
    });

    const rows = db
      .prepare(
        "SELECT id, status, failure_reason, failure_message, raw_text_length, latency_ms, finished_at FROM orchestration_transport_attempts ORDER BY created_at ASC, id ASC"
      )
      .all() as Array<{
      id: string;
      status: string;
      failure_reason: string | null;
      failure_message: string | null;
      raw_text_length: number | null;
      latency_ms: number | null;
      finished_at: string | null;
    }>;

    expect(rows.find((row) => row.id === runningId)).toMatchObject({
      status: "running",
      finished_at: null,
    });
    expect(rows.find((row) => row.id === succeededId)).toMatchObject({
      status: "succeeded",
      raw_text_length: 42,
      latency_ms: 9,
      finished_at: NOW,
    });
    expect(rows.find((row) => row.id === rejectedId)).toMatchObject({
      status: "rejected",
      failure_reason: "proposal_rejected",
      failure_message: "guardrail denied token=[redacted]",
      finished_at: NOW,
    });
    expect(rows.find((row) => row.id === failedId)).toMatchObject({
      status: "failed",
      failure_reason: "one_shot_unavailable",
      failure_message: "provider unavailable",
      finished_at: NOW,
    });
    expect(rows.find((row) => row.id === fallbackId)).toMatchObject({
      status: "fallback",
      failure_reason: "one_shot_parse_failed",
      failure_message: "invalid envelope",
      finished_at: NOW,
    });
  });

  it("keeps transport event payloads content-free and under 4 KiB", () => {
    const { events, ctx } = setup();
    const attemptId = createAttempt(ctx);

    markTransportAttemptFailed(ctx, {
      attemptId,
      failureReason: "one_shot_unavailable",
      failureMessage: "x".repeat(10_000),
    });

    for (const event of events) {
      const payloadJson = JSON.stringify(event.payload);
      expect(Buffer.byteLength(payloadJson, "utf8")).toBeLessThanOrEqual(
        WORKFLOW_EVENT_MAX_PAYLOAD_BYTES
      );
      expect(payloadJson).not.toContain("x".repeat(100));
      expect(payloadJson).not.toContain("failureMessage");
    }
  });

  it("maps provider failure codes to one-shot transport failure reasons", () => {
    const cases: Record<ProviderFailureCode, OrchestrationTransportFailureReason> = {
      invalid_output: "one_shot_parse_failed",
      rate_limited: "one_shot_rate_limited",
      missing_api_key: "one_shot_unavailable",
      provider_error: "one_shot_unavailable",
      timeout: "one_shot_unavailable",
      internal_error: "one_shot_unavailable",
    };

    for (const [code, expected] of Object.entries(cases) as Array<
      [ProviderFailureCode, OrchestrationTransportFailureReason]
    >) {
      expect(mapProviderErrorToTransportFailureReason(code)).toBe(expected);
      expect(mapProviderErrorToTransportFailureReason(new ProviderError(code, "failed"))).toBe(
        expected
      );
    }
  });
});
