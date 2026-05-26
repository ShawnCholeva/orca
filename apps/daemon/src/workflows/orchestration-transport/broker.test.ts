import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type {
  DomainEvent,
  ModelProviderId,
  OrchestrationRequest as OrchestrationRequestT,
} from "@orca/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import {
  markTransportAttemptFailed,
  markTransportAttemptRejected,
  markTransportAttemptRunning,
  markTransportAttemptSucceeded,
  type TransportAttemptUsecaseCtx,
} from "./attempts.js";
import { OrchestrationTransportBroker } from "./broker.js";

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

function seedWorkflow(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
  ).run(NOW);
}

function setup(): {
  db: Database.Database;
  bus: EventBus;
  events: DomainEvent[];
  broker: OrchestrationTransportBroker;
  attemptCtx: TransportAttemptUsecaseCtx;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-broker-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedWorkflow(db);
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  let nextId = 0;
  const idFactory = () => `id-${++nextId}`;
  const attemptCtx = { db, bus, now: () => NOW, idFactory };
  return {
    db,
    bus,
    events,
    broker: new OrchestrationTransportBroker(attemptCtx),
    attemptCtx,
  };
}

function request(providerId: ModelProviderId): OrchestrationRequestT {
  return {
    kind: "select_operator",
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    providerId,
    modelId: "model-1",
    payload: { requested: true },
  };
}

function attemptRows(db: Database.Database): Array<{
  id: string;
  transport: string;
  status: string;
  failure_reason: string | null;
}> {
  return db
    .prepare(
      "SELECT id, transport, status, failure_reason FROM orchestration_transport_attempts ORDER BY rowid ASC"
    )
    .all() as Array<{
    id: string;
    transport: string;
    status: string;
    failure_reason: string | null;
  }>;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestrationTransportBroker fallback", () => {
  it.each<ModelProviderId>(["orca/openai", "orca/google-gemini"])(
    "tries one-shot, hidden interactive, then human review for %s",
    async (providerId) => {
      const { broker, db, events, attemptCtx } = setup();
      const hiddenCalls: string[] = [];

      const result = await broker.propose(request(providerId), {
        runOneShot: async () => ({
          status: "failed",
          failureReason: "one_shot_rate_limited",
          failureMessage: "quota exceeded",
          rawTextLength: 0,
          latencyMs: 5,
        }),
        runHiddenInteractive: async ({ attemptId }) => {
          hiddenCalls.push(attemptId);
          markTransportAttemptRunning(attemptCtx, attemptId);
          markTransportAttemptFailed(attemptCtx, {
            attemptId,
            failureReason: "interactive_hung",
            failureMessage: "worker hung",
            latencyMs: 10,
          });
          return {
            status: "failed",
            failureReason: "interactive_hung",
            failureMessage: "worker hung",
            latencyMs: 10,
          };
        },
      });

      expect(result.status).toBe("needs_human_review");
      expect(hiddenCalls).toHaveLength(1);
      expect(attemptRows(db)).toEqual([
        {
          id: expect.any(String),
          transport: "one_shot",
          status: "failed",
          failure_reason: "one_shot_rate_limited",
        },
        {
          id: expect.any(String),
          transport: "hidden_interactive",
          status: "failed",
          failure_reason: "interactive_hung",
        },
        {
          id: expect.any(String),
          transport: "human_review",
          status: "pending",
          failure_reason: null,
        },
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "workflow.transport.attempt_started",
        "workflow.transport.attempt_started",
        "workflow.transport.attempt_finished",
        "workflow.transport.fallback",
        "workflow.transport.attempt_started",
        "workflow.transport.attempt_started",
        "workflow.transport.attempt_finished",
        "workflow.transport.fallback",
        "workflow.transport.attempt_started",
        "workflow.human_review.requested",
      ]);
      expect(events.filter((event) => event.type === "workflow.transport.fallback"))
        .toHaveLength(2);
    }
  );

  it("skips one-shot for Claude by policy", async () => {
    const { broker, db, attemptCtx } = setup();
    const runOneShot = vi.fn();

    const result = await broker.propose(request("orca/anthropic"), {
      runOneShot,
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptFailed(attemptCtx, {
          attemptId,
          failureReason: "interactive_auth_lost",
          failureMessage: "login required",
        });
        return {
          status: "failed",
          failureReason: "interactive_auth_lost",
          failureMessage: "login required",
        };
      },
    });

    expect(result.status).toBe("needs_human_review");
    expect(runOneShot).not.toHaveBeenCalled();
    expect(attemptRows(db).map((row) => row.transport)).toEqual([
      "hidden_interactive",
      "human_review",
    ]);
  });

  it("records rejected proposals distinctly before falling back", async () => {
    const { broker, db, events, attemptCtx } = setup();

    const result = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "proposed",
        parsed: { operatorId: "agent:missing" },
        rawTextLength: 31,
        latencyMs: 4,
      }),
      validateProposal: () => ({
        accepted: false,
        failureMessage: "selected operator is not ready or not registered",
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptFailed(attemptCtx, {
          attemptId,
          failureReason: "interactive_spawn_failed",
          failureMessage: "adapter unavailable",
        });
        return {
          status: "failed",
          failureReason: "interactive_spawn_failed",
          failureMessage: "adapter unavailable",
        };
      },
    });

    expect(result.status).toBe("needs_human_review");
    expect(attemptRows(db)[0]).toMatchObject({
      transport: "one_shot",
      status: "rejected",
      failure_reason: "proposal_rejected",
    });
    expect(events.find((event) => event.type === "workflow.transport.fallback"))
      ?.toMatchObject({ payload: { failureReason: "proposal_rejected" } });
  });

  it("returns a hidden interactive proposal without creating human review", async () => {
    const { broker, db, attemptCtx } = setup();

    const result = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_unavailable",
        failureMessage: "not configured",
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptSucceeded(attemptCtx, {
          attemptId,
          rawTextLength: 42,
          latencyMs: 9,
        });
        return {
          status: "proposed",
          parsed: { operatorId: "agent:codex" },
          rawTextLength: 42,
          latencyMs: 9,
        };
      },
    });

    expect(result).toMatchObject({
      status: "proposed",
      transport: "hidden_interactive",
      parsed: { operatorId: "agent:codex" },
    });
    expect(attemptRows(db).map((row) => row.transport)).toEqual([
      "one_shot",
      "hidden_interactive",
    ]);
  });

  it("records rejected hidden interactive proposals before falling back to human review", async () => {
    const { broker, db, events, attemptCtx } = setup();

    const result = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_unavailable",
        failureMessage: "not configured",
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptRejected(attemptCtx, {
          attemptId,
          failureReason: "proposal_rejected",
          failureMessage: "guardrail denied choice",
          rawTextLength: 52,
          latencyMs: 11,
        });
        return {
          status: "rejected",
          failureMessage: "guardrail denied choice",
          rawTextLength: 52,
          latencyMs: 11,
        };
      },
    });

    expect(result.status).toBe("needs_human_review");
    expect(attemptRows(db)).toMatchObject([
      {
        transport: "one_shot",
        status: "failed",
        failure_reason: "one_shot_unavailable",
      },
      {
        transport: "hidden_interactive",
        status: "rejected",
        failure_reason: "proposal_rejected",
      },
      {
        transport: "human_review",
        status: "pending",
        failure_reason: null,
      },
    ]);
    expect(
      events.filter((event) => event.type === "workflow.transport.fallback").at(-1)
    ).toMatchObject({ payload: { failureReason: "proposal_rejected" } });
  });
});
