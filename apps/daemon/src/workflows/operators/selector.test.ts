import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type {
  OperatorDescriptor,
  OperatorSelection,
  WorkflowGuardrailConfig,
} from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelProvider,
} from "../../llm/types.js";
import { ModelProviderRegistry } from "../../llm/registry.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { OperatorRegistry } from "./registry.js";
import { OperatorSelector, type SelectorInput } from "./selector.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

const READY_OPERATORS: OperatorDescriptor[] = [
  {
    id: "agent:codex",
    kind: "agent",
    displayName: "Codex",
    capabilities: ["implementation", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
  {
    id: "orca/openai:gpt-5.1-mini",
    kind: "model",
    displayName: "OpenAI GPT 5.1 Mini",
    capabilities: ["fast"],
    ready: true,
    supportsRepoEditing: false,
    supportsTerminal: false,
  },
  {
    id: "human",
    kind: "human",
    displayName: "Human",
    capabilities: ["judgment", "qa"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
];

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-selector-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedWorkflow(db);
  return db;
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
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 4, 1, 'active', '[]', '[\"implemented\"]', NULL, ?, NULL, 'fp-1')"
  ).run(NOW);
}

function baseInput(patch: Partial<SelectorInput> = {}): SelectorInput {
  return {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepName: "execution",
    stepPurpose: "Implement approved tasks",
    recommendedCapabilities: ["implementation", "code_editing"],
    recommendedOperatorIds: ["agent:codex"],
    guardrails: [],
    orchestratorProvider: "orca/openai",
    orchestratorModel: "gpt-5.1-mini",
    ...patch,
  };
}

function selection(operatorId: string, operatorKind: OperatorSelection["operatorKind"]): OperatorSelection {
  return {
    operatorId,
    operatorKind,
    reason: "best match",
    requiredCapabilities: ["implementation"],
    alternativesConsidered: ["human"],
    confidence: 0.8,
    requiresUserApproval: true,
  };
}

function allowedOperators(allowed: string[]): WorkflowGuardrailConfig {
  return {
    id: "allowed-operators",
    kind: "allowed_operators",
    label: "Allowed operators",
    configJson: { allowed },
  };
}

function makeProvider(responses: unknown[]): { provider: ModelProvider; seenPrompts: string[] } {
  const seenPrompts: string[] = [];
  return {
    seenPrompts,
    provider: {
      id: "orca/openai",
      displayName: "OpenAI",
      version: "0.1.0",
      async isAvailable() {
        return { available: true };
      },
      async listModels() {
        return [
          {
            id: "gpt-5.1-mini",
            displayName: "GPT 5.1 Mini",
            capabilities: ["fast"],
          },
        ];
      },
      async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
        seenPrompts.push(req.userPrompt);
        const parsed = responses.shift();
        return {
          parsed: parsed as T,
          rawTextLength: JSON.stringify(parsed).length,
          usageTokensInput: 12,
          usageTokensOutput: 8,
          latencyMs: 7,
          providerVersion: "0.1.1",
        };
      },
    },
  };
}

function makeSelector(
  db: Database.Database,
  operators: OperatorDescriptor[],
  responses: unknown[] = [],
  resolveMode?: ConstructorParameters<typeof OperatorSelector>[3]
): { selector: OperatorSelector; seenPrompts: string[] } {
  const providers = new ModelProviderRegistry();
  const { provider, seenPrompts } = makeProvider(responses);
  providers.register(provider);
  const registry = {
    async list() {
      return operators;
    },
  } as unknown as OperatorRegistry;
  const broker = new OrchestrationTransportBroker({
    db,
    bus: new EventBus(),
    now: () => NOW,
    idFactory: (() => {
      let seq = 0;
      return () => `broker-id-${++seq}`;
    })(),
  });
  return {
    selector: new OperatorSelector(providers, registry, broker, resolveMode),
    seenPrompts,
  };
}

function llmRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT provider_id, provider_version, model, status, usage_tokens_input, usage_tokens_output, latency_ms, failure_code, failure_message FROM workflow_llm_calls ORDER BY created_at ASC"
    )
    .all() as Array<Record<string, unknown>>;
}

function attemptRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT provider_id, model, transport, status, failure_reason, raw_text_length, latency_ms FROM orchestration_transport_attempts ORDER BY rowid ASC"
    )
    .all() as Array<Record<string, unknown>>;
}

function decisionCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM workflow_decisions").get() as {
      count: number;
    }
  ).count;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OperatorSelector", () => {
  it("returns an LLM selection and records metadata-only call state", async () => {
    const db = setupDb();
    const { selector: operatorSelector } = makeSelector(db, READY_OPERATORS, [
      selection("agent:codex", "agent"),
    ]);

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ recommendedOperatorIds: [] })
    );

    expect(result.source).toBe("llm");
    expect(result.selection.operatorId).toBe("agent:codex");
    expect(result.llmCallId).toBeTruthy();
    expect(llmRows(db)).toEqual([
      {
        provider_id: "orca/openai",
        provider_version: "0.1.1",
        model: "gpt-5.1-mini",
        status: "succeeded",
        usage_tokens_input: 12,
        usage_tokens_output: 8,
        latency_ms: 7,
        failure_code: null,
        failure_message: null,
      },
    ]);
    expect(attemptRows(db)).toMatchObject([
      {
        provider_id: "orca/openai",
        model: "gpt-5.1-mini",
        transport: "one_shot",
        status: "succeeded",
        failure_reason: null,
        raw_text_length: expect.any(Number),
        latency_ms: 7,
      },
    ]);
  });

  it("retries once for an invalid operator id, then falls back deterministically", async () => {
    const db = setupDb();
    const { selector: operatorSelector, seenPrompts } = makeSelector(db, READY_OPERATORS, [
      selection("agent:missing", "agent"),
      selection("agent:still-missing", "agent"),
    ]);

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ recommendedOperatorIds: [] })
    );

    expect(result.source).toBe("fallback");
    expect(result.selection.operatorId).toBe("agent:codex");
    expect(seenPrompts).toHaveLength(2);
    expect(JSON.parse(seenPrompts[1] ?? "{}")).toMatchObject({
      excludedOperatorIds: ["agent:missing"],
    });
    expect(llmRows(db).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    expect(decisionCount(db)).toBe(0);
  });

  it("goes straight to fallback when no orchestrator model is configured", async () => {
    const db = setupDb();
    const { selector: operatorSelector } = makeSelector(db, READY_OPERATORS, [
      selection("agent:codex", "agent"),
    ]);

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ orchestratorProvider: null, orchestratorModel: null })
    );

    expect(result).toMatchObject({
      source: "fallback",
      selection: { operatorId: "agent:codex", operatorKind: "agent" },
    });
    expect(llmRows(db)).toEqual([]);
  });

  it("does not use SDK selection or choose a model operator for a shadow-only adapter", async () => {
    const db = setupDb();
    const { selector: operatorSelector, seenPrompts } = makeSelector(
      db,
      READY_OPERATORS,
      [selection("orca/openai:gpt-5.1-mini", "model")],
      (adapterId) => ({ adapterId, mode: "shadow_session", fallbacks: [] })
    );

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ recommendedOperatorIds: ["orca/openai:gpt-5.1-mini"] })
    );

    expect(result.source).toBe("fallback");
    expect(result.selection.operatorKind).not.toBe("model");
    expect(seenPrompts).toEqual([]);
    expect(llmRows(db)).toEqual([]);
  });

  it("records invalid_output when provider output fails schema validation", async () => {
    const db = setupDb();
    const { selector: operatorSelector } = makeSelector(db, READY_OPERATORS, [
      { operatorId: "agent:codex" },
    ]);

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ recommendedOperatorIds: [] })
    );

    expect(result.source).toBe("fallback");
    expect(result.selection.operatorId).toBe("agent:codex");
    expect(llmRows(db)).toMatchObject([
      {
        status: "failed",
        failure_code: "invalid_output",
      },
    ]);
    expect(attemptRows(db)[0]).toMatchObject({
      transport: "one_shot",
      status: "failed",
      failure_reason: "one_shot_parse_failed",
    });
  });

  it("throws when no operators are ready", async () => {
    const db = setupDb();
    const { selector: operatorSelector } = makeSelector(db, []);

    await expect(operatorSelector.select(db, () => NOW, baseInput())).rejects.toThrow(
      "no_ready_operators"
    );
  });

  it("excludes guardrail-denied operators from LLM and fallback selections", async () => {
    const db = setupDb();
    const { selector: operatorSelector, seenPrompts } = makeSelector(db, READY_OPERATORS, [
      selection("agent:codex", "agent"),
      selection("agent:codex", "agent"),
    ]);

    const result = await operatorSelector.select(
      db,
      () => NOW,
      baseInput({ guardrails: [allowedOperators(["human"])] })
    );

    expect(result.source).toBe("fallback");
    expect(result.selection.operatorId).toBe("human");
    expect(result.selection.alternativesConsidered).not.toContain("agent:codex");
    expect(seenPrompts).toHaveLength(0);
    expect(llmRows(db)).toEqual([]);
  });

  it("uses deterministic exact-match selection before broker transport", async () => {
    const db = setupDb();
    const { selector: operatorSelector, seenPrompts } = makeSelector(db, READY_OPERATORS, [
      selection("human", "human"),
    ]);

    const result = await operatorSelector.select(db, () => NOW, baseInput());

    expect(result.source).toBe("fallback");
    expect(result.selection.operatorId).toBe("agent:codex");
    expect(result.selection.reason).toContain("known exact recommended operator match");
    expect(seenPrompts).toHaveLength(0);
    expect(llmRows(db)).toEqual([]);
    expect(attemptRows(db)).toEqual([]);
  });
});
