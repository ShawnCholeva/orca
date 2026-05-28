import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  HumanReviewPayload,
  NextOrchestratorDecisionResponse,
  type DomainEvent,
  type ModelProviderId,
  type OrchestrationRequest as OrchestrationRequestT,
} from "@orca/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";
import {
  markTransportAttemptFailed,
  markTransportAttemptRunning,
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
    getAuthToken: () => "test-token",
  };
}

function seedWorkflow(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, orchestrator_provider, orchestrator_model, active_workflow_run_id, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', 'Goal desc', 'active', 1, 'orca/openai', 'gpt-5', NULL, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(
    JSON.stringify([
      {
        id: "execution",
        ordinal: 1,
        name: "Execution",
        instructions: "Implement the selected plan.",
        outputSchema: [{ key: "result", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
    ]),
    NOW,
    NOW
  );
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[\"done\"]', NULL, ?, NULL, 'fp-1')"
  ).run(NOW);
}

function request(providerId: ModelProviderId): OrchestrationRequestT {
  return {
    kind: "select_operator",
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    providerId,
    modelId: "gpt-5",
    payload: {
      stepName: "execution",
      stepPurpose: "Implement the selected plan",
      recommendedCapabilities: ["implementation"],
      recommendedOperatorIds: ["human"],
      excludedOperatorIds: [],
      readyOperators: [
        { id: "human", kind: "human", capabilities: ["judgment", "qa"] },
        { id: "agent:codex", kind: "agent", capabilities: ["implementation"] },
      ],
    },
  };
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("M9 human review orchestration flow", () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let broker: OrchestrationTransportBroker;
  let attemptCtx: TransportAttemptUsecaseCtx;
  let emittedEvents: DomainEvent[];

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-m9-human-review-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    seedWorkflow(db);

    const bus = new EventBus();
    emittedEvents = [];
    bus.subscribe((event) => emittedEvents.push(event));

    let nextId = 0;
    const idFactory = () => `id-${++nextId}`;
    const now = () => NOW;
    attemptCtx = { db, bus, now, idFactory };
    broker = new OrchestrationTransportBroker({ db, bus, now, idFactory });
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a persisted pending human review payload when fallback reaches human review", async () => {
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
    const row = db
      .prepare(
        "SELECT status, payload_json FROM orchestration_human_reviews WHERE attempt_id = ?"
      )
      .get(result.attemptId) as { status: string; payload_json: string } | undefined;
    expect(row?.status).toBe("pending");
    const payload = HumanReviewPayload.parse(JSON.parse(row?.payload_json ?? "{}"));
    expect(payload.kind).toBe("select_operator");
    expect(payload.summary).toContain("Failed transports:");
    expect(payload.choices.length).toBeGreaterThan(0);
    expect(emittedEvents.map((event) => event.type)).toContain(
      "workflow.human_review.requested"
    );
  });

  it("submits a human review proposal through the route and persists decision handoff", async () => {
    const fallback = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_unavailable",
        failureMessage: "not configured",
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
    expect(fallback.status).toBe("needs_human_review");

    const reviewPayload = HumanReviewPayload.parse(
      JSON.parse(
        (
          db
            .prepare("SELECT payload_json FROM orchestration_human_reviews WHERE attempt_id = ?")
            .get(fallback.attemptId) as { payload_json: string }
        ).payload_json
      )
    );
    const humanChoice = reviewPayload.choices.find((choice) => choice.id === "human");
    expect(humanChoice).toBeTruthy();

    const response = await server.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/run-1/human-review/${fallback.attemptId}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        choiceId: humanChoice?.id,
        proposal: humanChoice?.proposal,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsed = NextOrchestratorDecisionResponse.parse(JSON.parse(response.body));
    expect(parsed.decision.decisionType).toBe("select_operator");
    expect(parsed.recommendationIds).toHaveLength(1);

    const attemptRow = db
      .prepare(
        "SELECT status, decision_id FROM orchestration_transport_attempts WHERE id = ?"
      )
      .get(fallback.attemptId) as { status: string; decision_id: string | null };
    expect(attemptRow.status).toBe("succeeded");
    expect(attemptRow.decision_id).toBe(parsed.decision.decisionId);

    const reviewRow = db
      .prepare(
        "SELECT status, submitted_at FROM orchestration_human_reviews WHERE attempt_id = ?"
      )
      .get(fallback.attemptId) as { status: string; submitted_at: string | null };
    expect(reviewRow.status).toBe("accepted");
    expect(reviewRow.submitted_at).toBeTruthy();

    const recommendationCount = (
      db
        .prepare(
          "SELECT count(*) AS c FROM recommendations WHERE goal_id = 'goal-1' AND type = 'launch_workflow_session' AND status = 'proposed'"
        )
        .get() as { c: number }
    ).c;
    expect(recommendationCount).toBe(1);
  });

  it("returns 404 when goal ownership does not match on submission", async () => {
    const fallback = await broker.propose(request("orca/openai"), {
      runOneShot: async () => ({
        status: "failed",
        failureReason: "one_shot_unavailable",
      }),
      runHiddenInteractive: async ({ attemptId }) => {
        markTransportAttemptRunning(attemptCtx, attemptId);
        markTransportAttemptFailed(attemptCtx, {
          attemptId,
          failureReason: "interactive_spawn_failed",
        });
        return {
          status: "failed",
          failureReason: "interactive_spawn_failed",
        };
      },
    });
    expect(fallback.status).toBe("needs_human_review");
    const payload = HumanReviewPayload.parse(
      JSON.parse(
        (
          db
            .prepare("SELECT payload_json FROM orchestration_human_reviews WHERE attempt_id = ?")
            .get(fallback.attemptId) as { payload_json: string }
        ).payload_json
      )
    );

    const response = await server.inject({
      method: "POST",
      url: `/v1/goals/goal-wrong/workflow-runs/run-1/human-review/${fallback.attemptId}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        choiceId: payload.choices[0]?.id,
        proposal: payload.choices[0]?.proposal,
      },
    });

    expect(response.statusCode).toBe(404);
  });
});
