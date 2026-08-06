import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { WorkflowRunResponse } from "@orca/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Config } from "./config.js";
import { seedAdapterExecutionModes } from "./adapters/execution-modes.js";
import { createDaemonContext } from "./daemon-context.js";
import { closeDatabase, openDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { bootstrapRegistries } from "./registry/bootstrap.js";
import { createServer } from "./server.js";
import { resetWorkflowEventPreparedStatements } from "./workflows/events.js";
import { resetPreparedStatements as resetRunProjectionPreparedStatements } from "./workflows/runs/projection.js";
import {
  markWorkflowRunBlocked,
  startWorkflowRun,
  type WorkflowRunUsecaseCtx,
} from "./workflows/runs/usecases.js";
import { markStepBlocked } from "./workflows/steps/usecases.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const NOW = "2026-08-05T00:00:00.000Z";

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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database, id: string, version: number): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)"
  ).run(
    id,
    "Engineering",
    "desc",
    version,
    JSON.stringify([
      {
        id: "intake",
        ordinal: 0,
        name: "Intake",
        instructions: "Collect user input and capture a goal brief.",
        outputSchema: [{ key: "goal_brief", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) {
      if (check()) return;
      throw new Error("condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("resume respawn success (server.ts wiring)", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  afterEach(async () => {
    await server.close();
    closeDatabase();
    resetWorkflowEventPreparedStatements();
    resetRunProjectionPreparedStatements();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the run active with no re-block message when the respawn does not throw", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-resume-recovery-ok-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    seedAdapterExecutionModes(db, () => NOW, { "claude-code": ["shadow_session", "one_shot"] });
    const daemonContext = createDaemonContext(db, eventBus);
    daemonContext.now = () => NOW;
    daemonContext.stepDispatchCapabilities = {
      ...daemonContext.stepDispatchCapabilities,
      isAdapterReady: async () => true, // a ready agent is found
    };
    server = createServer(config, {
      daemonContext,
      workerDeliver: async () => "delivered",
    });

    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering", 1);
    let ctxNextId = 0;
    const ctx: WorkflowRunUsecaseCtx = { db, bus: eventBus, now: () => NOW, idFactory: () => `ctx-fixed-id-${++ctxNextId}` };
    const run = startWorkflowRun(ctx, { goalId: "goal-1", templateId: "orca/engineering" });
    const terminalStepRunId = run.currentStepRunId!;
    markStepBlocked(db, () => NOW, terminalStepRunId, "no progress after 3 restarts");
    markWorkflowRunBlocked(ctx, run.id, "no progress after 3 restarts");

    const response = await server.inject({
      method: "POST",
      url: `/v1/goals/goal-1/workflow-runs/${run.id}/resume`,
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const parsed = WorkflowRunResponse.parse(JSON.parse(response.body));
    expect(parsed.run.status).toBe("active");

    // No workspace is attached to this goal, so the actual session launch
    // fails too — but *inside* spawnStepAgent's own try/catch, which already
    // posts its own message and never throws back out. Wait for that
    // pre-existing message so we know the background work has settled before
    // asserting my new re-block path never fired.
    await waitForCondition(() => {
      const count = (
        db.prepare("SELECT COUNT(*) AS c FROM orchestrator_messages WHERE goal_id = ?").get("goal-1") as { c: number }
      ).c;
      return count > 0;
    });

    const runRow = db
      .prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = ?")
      .get(run.id) as { status: string; blocked_reason: string | null };
    expect(runRow.status).toBe("active");
    expect(runRow.blocked_reason).toBeNull();

    const messages = db
      .prepare("SELECT body FROM orchestrator_messages WHERE goal_id = ?")
      .all("goal-1") as Array<{ body: string }>;
    expect(messages.some((m) => m.body.includes("couldn't get an agent going"))).toBe(false);
  });
});
