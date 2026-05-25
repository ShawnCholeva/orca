import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ModelProviderId, OperatorDescriptor } from "@orca/contracts";

import type { Config } from "../../config.js";
import { createDaemonContext, type DaemonContext } from "../../daemon-context.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { eventBus } from "../../events.js";
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelProvider,
} from "../../llm/types.js";
import { ModelProviderRegistry } from "../../llm/registry.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { FakePtyManager } from "../../pty/fake.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";
import { createSessionOutputStore } from "../../sessions/output-store.js";
import { SessionRuntime } from "../../sessions/runtime.js";
import { seedAgents } from "../../agents.js";
import { seedEngineeringTemplate } from "../../workflows/templates/seed-engineering.js";
import { reconcileWorkflowsOnBoot } from "../../workflows/reconcile.js";
import { OperatorSelector } from "../../workflows/operators/selector.js";
import { OrchestrationTransportBroker } from "../../workflows/orchestration-transport/broker.js";

const PROVIDER_MODELS: Record<
  ModelProviderId,
  Array<{ id: string; displayName: string; capabilities: string[] }>
> = {
  "orca/anthropic": [
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      capabilities: ["reasoning", "planning"],
    },
    {
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      capabilities: ["review", "architecture"],
    },
  ],
  "orca/openai": [
    {
      id: "gpt-5",
      displayName: "GPT-5",
      capabilities: ["implementation", "code_editing"],
    },
    {
      id: "gpt-4o",
      displayName: "GPT-4o",
      capabilities: ["task_decomposition"],
    },
  ],
  "orca/google-gemini": [
    {
      id: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      capabilities: ["qa", "large_context_review"],
    },
  ],
};

const READY_OPERATORS: OperatorDescriptor[] = [
  {
    id: "agent:claude-code",
    kind: "agent",
    displayName: "Claude Code",
    capabilities: ["codebase_analysis", "risk_assessment", "architecture_review", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
  {
    id: "agent:codex",
    kind: "agent",
    displayName: "Codex",
    capabilities: ["implementation", "code_editing", "validation"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
  {
    id: "agent:opencode",
    kind: "agent",
    displayName: "OpenCode",
    capabilities: ["implementation", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
  {
    id: "human",
    kind: "human",
    displayName: "Human",
    capabilities: ["judgment", "qa", "approval"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  },
];

let registriesBootstrapped = false;

function bootstrapRegistriesOnce(): void {
  if (registriesBootstrapped) return;
  bootstrapRegistries();
  registriesBootstrapped = true;
}

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

function selectOperatorForStep(input: {
  stepName?: string;
  recommendedOperatorIds?: string[];
  readyOperators?: Array<{ id: string; kind: OperatorDescriptor["kind"] }>;
}): { id: string; kind: OperatorDescriptor["kind"] } {
  const ready = input.readyOperators ?? [];
  const recommended = input.recommendedOperatorIds ?? [];
  for (const operatorId of recommended) {
    const match = ready.find((operator) => operator.id === operatorId);
    if (match) return match;
  }

  const fallbackByStep: Record<string, string> = {
    research: "agent:claude-code",
    prd: "human",
    issue_breakdown: "human",
    execution: "agent:codex",
    review: "agent:claude-code",
    done: "human",
  };
  const preferredId = input.stepName ? fallbackByStep[input.stepName] : undefined;
  if (preferredId) {
    const preferred = ready.find((operator) => operator.id === preferredId);
    if (preferred) return preferred;
  }

  return ready[0] ?? { id: "human", kind: "human" };
}

function createFakeProvider(
  id: ModelProviderId,
  displayName: string
): ModelProvider {
  return {
    id,
    displayName,
    version: "test-provider-1",
    async isAvailable() {
      return { available: true };
    },
    async listModels() {
      return PROVIDER_MODELS[id];
    },
    async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
      const prompt = JSON.parse(req.userPrompt) as {
        stepName?: string;
        recommendedCapabilities?: string[];
        recommendedOperatorIds?: string[];
        readyOperators?: Array<{ id: string; kind: OperatorDescriptor["kind"] }>;
      };
      const chosen = selectOperatorForStep(prompt);
      const selection = {
        operatorId: chosen.id,
        operatorKind: chosen.kind,
        reason: `Selected ${chosen.id} for ${prompt.stepName ?? "workflow step"}`,
        requiredCapabilities: (prompt.recommendedCapabilities ?? []).slice(0, 20),
        alternativesConsidered: (prompt.readyOperators ?? [])
          .map((operator) => operator.id)
          .filter((operatorId) => operatorId !== chosen.id)
          .slice(0, 8),
        confidence: 0.92,
        requiresUserApproval: chosen.kind !== "human",
      };
      return {
        parsed: selection as T,
        rawTextLength: JSON.stringify(selection).length,
        usageTokensInput: 33,
        usageTokensOutput: 19,
        latencyMs: 4,
        providerVersion: "test-provider-1",
      };
    },
  };
}

function createModelProviderRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  registry.register(createFakeProvider("orca/anthropic", "Anthropic"));
  registry.register(createFakeProvider("orca/openai", "OpenAI"));
  registry.register(createFakeProvider("orca/google-gemini", "Google Gemini"));
  return registry;
}

function buildDaemonContext(
  db: Database.Database,
  now: () => string,
  idFactory: () => string
): DaemonContext {
  const base = createDaemonContext(db, eventBus);
  const modelProviderRegistry = createModelProviderRegistry();
  const operatorRegistry = {
    async list() {
      return READY_OPERATORS;
    },
  } as unknown as DaemonContext["operatorRegistry"];

  const orchestrationTransportBroker = new OrchestrationTransportBroker({
    db,
    bus: eventBus,
    now,
    idFactory,
  });

  return {
    ...base,
    modelProviderRegistry,
    operatorRegistry,
    orchestrationTransportBroker,
    operatorSelector: new OperatorSelector(
      modelProviderRegistry,
      operatorRegistry,
      orchestrationTransportBroker
    ),
    now,
    idFactory,
  };
}

export interface BootedDaemonForTest {
  dataDir: string;
  config: Config;
  db: Database.Database;
  server: FastifyInstance;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

export async function bootDaemonForTest(opts?: {
  dataDir?: string;
  now?: () => string;
  idFactory?: () => string;
}): Promise<BootedDaemonForTest> {
  bootstrapRegistriesOnce();

  const dataDir =
    opts?.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "orca-m8-workflow-loop-"));
  const config = createConfig(dataDir);
  const now = opts?.now ?? (() => new Date().toISOString());
  const idFactory = opts?.idFactory ?? randomUUID;

  let db = openDatabase(config);
  let server = createServerForTest(db, config, now, idFactory);

  async function restart(): Promise<void> {
    await server.close();
    closeDatabase();
    db = openDatabase(config);
    server = createServerForTest(db, config, now, idFactory);
    handles.db = db;
    handles.server = server;
  }

  async function close(): Promise<void> {
    await server.close();
    closeDatabase();
  }

  const handles: BootedDaemonForTest = {
    dataDir,
    config,
    db,
    server,
    restart,
    close,
  };

  return handles;
}

function createServerForTest(
  db: Database.Database,
  config: Config,
  now: () => string,
  idFactory: () => string
): FastifyInstance {
  runMigrations(db, defaultMigrationsDir());
  seedAgents(db, now());
  seedEngineeringTemplate(db, now);
  reconcileWorkflowsOnBoot(db, now);

  return createServer(config, {
    daemonContext: buildDaemonContext(db, now, idFactory),
    sessionRuntime: new SessionRuntime(new FakePtyManager()),
    sessionOutputStore: createSessionOutputStore(db, {
      tailBytes: config.sessionOutputTailBytes,
    }),
  });
}
