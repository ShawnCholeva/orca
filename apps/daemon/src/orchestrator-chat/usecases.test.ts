import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import { PendingQuestion } from "@orca/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { EventBus } from "../events.js";
import { ModelProviderRegistry } from "../llm/registry.js";
import type { ModelCompletionRequest, ModelProvider } from "../llm/types.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";
import {
  createOrchestratorMessage,
  deletePendingApprovalMessage,
  GoalOrchestratorModelMissingError,
  recordPromptSuppressed,
  withdrawOrchestratorPromptsForStepRun,
  type OrchestratorChatCtx,
} from "./usecases.js";

const tempDirs: string[] = [];
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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  ctx: OrchestratorChatCtx;
  completions: ModelCompletionRequest[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-orchestrator-chat-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, 'orca/openai', 'gpt-5')"
  ).run("goal-1", NOW, NOW);
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'No Model', 'Missing model', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run("goal-without-model", NOW, NOW);
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  let nextId = 0;
  const completions: ModelCompletionRequest[] = [];
  const modelProviderRegistry = new ModelProviderRegistry();
  modelProviderRegistry.register(fakeProvider(completions));
  return {
    db,
    events,
    completions,
    ctx: {
      db,
      bus,
      modelProviderRegistry,
      now: () => NOW,
      idFactory: () => `fixed-id-${++nextId}`,
    },
  };
}

function fakeProvider(completions: ModelCompletionRequest[]): ModelProvider {
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
    async complete<T>(req: ModelCompletionRequest) {
      completions.push(req);
      return {
        parsed: { replyText: "Start with a bounded verification pass." } as T,
        rawTextLength: 48,
        latencyMs: 1,
        providerVersion: "test",
      };
    },
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("orchestrator chat projection", () => {
  it("lists orchestrator messages for a goal in ascending created_at order", () => {
    const { db } = setup();
    db.exec(`
      INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at)
      VALUES
        ('msg-1', 'goal-1', 'user', 'message', 'first', NULL, '2026-05-26T12:00:00.000Z'),
        ('msg-2', 'goal-1', 'orchestrator', 'message', 'second', 'corr-1', '2026-05-26T12:00:01.000Z')
    `);

    expect(listOrchestratorMessagesByGoal(db, "goal-1").map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
    ]);
  });

  it("round-trips internal_thought rows with internal_kind/why_rationale and agent_paraphrased raw_agent_text", () => {
    const { db } = setup();
    db.exec(`
      INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, raw_agent_text, why_rationale, internal_kind)
      VALUES
        ('it-1', 'goal-1', 'internal_thought', 'message', 'Starting Intake', NULL, '2026-05-26T12:00:00.000Z', NULL, 'step instructions said...', 'step_started'),
        ('ap-1', 'goal-1', 'agent_paraphrased', 'message', 'The agent finished the research.', NULL, '2026-05-26T12:00:01.000Z', '<full raw transcript>', NULL, NULL)
    `);

    const messages = listOrchestratorMessagesByGoal(db, "goal-1");
    expect(messages).toHaveLength(2);

    const thought = messages[0];
    expect(thought.role).toBe("internal_thought");
    expect(thought.internalKind).toBe("step_started");
    expect(thought.whyRationale).toBe("step instructions said...");

    const paraphrase = messages[1];
    expect(paraphrase.role).toBe("agent_paraphrased");
    expect(paraphrase.rawAgentText).toBe("<full raw transcript>");
  });
});

describe("orchestrator chat usecases", () => {
  it("persists a user message and orchestrator reply for a goal", async () => {
    const { db, ctx, events, completions } = setup();

    const result = await createOrchestratorMessage(ctx, "goal-1", {
      body: "Need a rollout plan.",
    });

    expect(result.message).toMatchObject({
      id: "fixed-id-1",
      role: "user",
      body: "Need a rollout plan.",
      correlationId: "fixed-id-2",
    });
    expect(result.reply).toMatchObject({
      id: "fixed-id-4",
      role: "orchestrator",
      body: "Start with a bounded verification pass.",
      correlationId: "fixed-id-2",
    });
    expect(listOrchestratorMessagesByGoal(db, "goal-1").map((message) => message.id)).toEqual([
      "fixed-id-1",
      "fixed-id-4",
    ]);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      model: "gpt-5",
      responseSchemaName: "OrchestratorGuidanceReply",
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      "orchestrator.message.created",
      "orchestrator.message.created",
    ]);
  });

  it("returns goal_orchestrator_model_missing when the goal lacks provider/model", async () => {
    const { ctx } = setup();

    await expect(
      createOrchestratorMessage(ctx, "goal-without-model", {
        body: "Need a rollout plan.",
      })
    ).rejects.toBeInstanceOf(GoalOrchestratorModelMissingError);
  });

  it("does not mutate workflow recommendations or step-run state", async () => {
    const { db, ctx } = setup();
    const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM recommendations").get() as {
      count: number;
    };

    await createOrchestratorMessage(ctx, "goal-1", {
      body: "Need a rollout plan.",
    });

    const afterCount = db.prepare("SELECT COUNT(*) AS count FROM recommendations").get() as {
      count: number;
    };
    expect(afterCount.count).toBe(beforeCount.count);
  });

  it("deletePendingApprovalMessage removes the message and emits message.updated", () => {
    const { db, ctx, events } = setup();
    db.prepare(
      `INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_approval)
       VALUES ('msg-ap', 'goal-1', 'orchestrator', 'message', 'The agent wants to run Bash.', NULL, ?, ?)`
    ).run(NOW, JSON.stringify({ approvalId: "ap-1", sessionId: "s1", toolName: "Bash", summary: "ls" }));

    const ok = deletePendingApprovalMessage(ctx, { goalId: "goal-1", approvalId: "ap-1" });

    expect(ok).toBe(true);
    expect(listOrchestratorMessagesByGoal(db, "goal-1")).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["orchestrator.message.updated"]);
  });

  it("deletePendingApprovalMessage is a no-op (returns false) for an unknown approval", () => {
    const { ctx, events } = setup();
    expect(deletePendingApprovalMessage(ctx, { goalId: "goal-1", approvalId: "nope" })).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("routes Google provider shadow chat through antigravity", async () => {
    const { db, ctx } = setup();
    db.prepare("UPDATE goals SET orchestrator_provider = 'orca/google', orchestrator_model = 'gemini-3.5-flash' WHERE id = 'goal-1'").run();
    const shadowAsk = vi.fn().mockResolvedValue({ text: '{"replyText":"Start small."}' });

    await createOrchestratorMessage(
      {
        ...ctx,
        shadowAsk,
        resolveOrchestratorMode: () => "shadow_session",
        onOrchestratorReply: vi.fn(),
      },
      "goal-1",
      { body: "Need a rollout plan." }
    );

    expect(shadowAsk.mock.calls[0]?.[1].adapterId).toBe("antigravity");
  });
});

function seedQuestion(db: Database.Database, id: string, pq: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?, 'goal-1', 'orchestrator', 'message', 'b', ?, ?, ?)"
  ).run(id, id, NOW, JSON.stringify(pq));
}
function readPq(db: Database.Database, id: string) {
  const row = db.prepare("SELECT pending_question FROM orchestrator_messages WHERE id = ?").get(id) as { pending_question: string };
  return PendingQuestion.parse(JSON.parse(row.pending_question));
}
const ITEM = [{ question: "?", header: "h", multiSelect: false, options: [{ label: "a", description: "d" }] }];

describe("withdrawOrchestratorPromptsForStepRun", () => {
  it("withdraws an open orchestrator question but not the worker hard-block", () => {
    const { db, ctx } = setup();
    seedQuestion(db, "mo", { questionId: "qo", toolUseId: "to", questions: ITEM, source: "orchestrator", stepRunId: "sr1" });
    seedQuestion(db, "mw", { questionId: "qw", toolUseId: "tw", questions: ITEM, source: "worker", stepRunId: "sr1" });

    const n = withdrawOrchestratorPromptsForStepRun(ctx, { goalId: "goal-1", stepRunId: "sr1" });

    expect(n).toBe(1);
    expect(readPq(db, "mo").withdrawn).toBe(true);
    expect(readPq(db, "mw").withdrawn).toBeUndefined();
  });

  it("ignores already-answered and other step runs", () => {
    const { db, ctx } = setup();
    seedQuestion(db, "ma", { questionId: "qa", toolUseId: "ta", questions: ITEM, source: "orchestrator", stepRunId: "sr1", answer: { viaChat: true } });
    seedQuestion(db, "mb", { questionId: "qb", toolUseId: "tb", questions: ITEM, source: "orchestrator", stepRunId: "sr2" });
    const n = withdrawOrchestratorPromptsForStepRun(ctx, { goalId: "goal-1", stepRunId: "sr1" });
    expect(n).toBe(0);
    expect(readPq(db, "mb").withdrawn).toBeUndefined();
  });
});

describe("recordPromptSuppressed", () => {
  it("appends a queryable suppression event to the spine", () => {
    const { db, ctx } = setup();
    recordPromptSuppressed(ctx, {
      goalId: "goal-1", stepRunId: "sr1", questions: ITEM, openPrompt: "worker_question",
    });
    const row = db
      .prepare("SELECT type, goal_id, payload FROM events WHERE type = 'orchestrator.prompt.suppressed'")
      .get() as { type: string; goal_id: string; payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.stepRunId).toBe("sr1");
    expect(payload.openPrompt).toBe("worker_question");
    expect(Array.isArray(payload.questions)).toBe(true);
  });
});
