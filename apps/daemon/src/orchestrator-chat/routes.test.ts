import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  CreateOrchestratorMessageResponse,
  ListOrchestratorMessagesResponse,
} from "@orca/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { createDaemonContext } from "../daemon-context.js";
import { closeDatabase, openDatabase } from "../db.js";
import { eventBus } from "../events.js";
import { ModelProviderRegistry } from "../llm/registry.js";
import type { ModelCompletionRequest, ModelProvider } from "../llm/types.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { createServer } from "../server.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const NOW = "2026-05-26T12:00:00.000Z";

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

function seedGoal(db: Database.Database, id: string, withModel = true): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, ?, ?)"
  ).run(id, NOW, NOW, withModel ? "orca/openai" : null, withModel ? "gpt-5" : null);
}

function fakeProvider(): ModelProvider {
  return {
    id: "orca/openai",
    displayName: "OpenAI",
    version: "test",
    async isAvailable() {
      return { available: true };
    },
    async listModels() {
      return [{ id: "gpt-5", displayName: "GPT-5", capabilities: ["chat"] }];
    },
    async complete<T>(_req: ModelCompletionRequest) {
      return {
        parsed: { replyText: "Start with a bounded verification pass." } as T,
        rawTextLength: 48,
        latencyMs: 1,
        providerVersion: "test",
      };
    },
  };
}

function fakeRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  registry.register(fakeProvider());
  return registry;
}

describe("orchestrator chat routes", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-orchestrator-chat-routes-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    const daemonContext = createDaemonContext(db, eventBus);
    daemonContext.modelProviderRegistry = fakeRegistry();
    daemonContext.now = () => NOW;
    let nextId = 0;
    daemonContext.idFactory = () => `fixed-id-${++nextId}`;
    server = createServer(config, { daemonContext });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /v1/goals/:goalId/orchestrator-messages returns goal-scoped rows", async () => {
    seedGoal(db, "goal-1");
    db.exec(`
      INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at)
      VALUES
        ('msg-1', 'goal-1', 'user', 'message', 'hello', NULL, '2026-05-26T12:00:00.000Z'),
        ('msg-2', 'goal-1', 'orchestrator', 'message', 'reply', NULL, '2026-05-26T12:00:01.000Z')
    `);

    const response = await server.inject({
      method: "GET",
      url: "/v1/goals/goal-1/orchestrator-messages",
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const parsed = ListOrchestratorMessagesResponse.parse(JSON.parse(response.body));
    expect(parsed.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("POST /v1/goals/:goalId/orchestrator-messages returns message and reply", async () => {
    seedGoal(db, "goal-1");

    const response = await server.inject({
      method: "POST",
      url: "/v1/goals/goal-1/orchestrator-messages",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { body: "Need a rollout plan." },
    });

    expect(response.statusCode).toBe(201);
    const parsed = CreateOrchestratorMessageResponse.parse(JSON.parse(response.body));
    expect(parsed.message.role).toBe("user");
    expect(parsed.reply?.role).toBe("orchestrator");
  });

  it("POST /v1/goals/:goalId/orchestrator-messages returns 409 when no model is configured", async () => {
    seedGoal(db, "goal-without-model", false);

    const response = await server.inject({
      method: "POST",
      url: "/v1/goals/goal-without-model/orchestrator-messages",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { body: "Need a rollout plan." },
    });

    expect(response.statusCode).toBe(409);
  });
});
