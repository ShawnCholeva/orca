import { describe, expect, it } from "vitest";
import type {
  AdapterId,
  AgentReadinessReport,
  AgentReadinessStatus,
  CheckStep,
  RepairAction,
} from "@orca/contracts";
import { AdapterRegistry } from "../../adapters/registry.js";
import type {
  AdapterAvailability,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AgentAdapter,
} from "../../adapters/types.js";
import { ModelProviderRegistry } from "../../llm/registry.js";
import type { ModelProvider } from "../../llm/types.js";
import { OperatorRegistry } from "./registry.js";

const NOW = "2026-01-01T00:00:00.000Z";

class FakeAdapter implements AgentAdapter {
  readonly contextDelivery = { mode: "initial_input" as const, maxBytes: 1024 };
  readonly supportedExecutionModes = ["shadow_session" as const];

  constructor(
    readonly id: AdapterId,
    readonly title: string,
    readonly supportsRepoEditing?: boolean,
    readonly supportsTerminal?: boolean
  ) {}

  async resolveSpawn(_input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    return { command: "fake", args: [], env: {}, cwd: "/tmp" };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    return { name: "installed", ok: true, command: "fake", version: "1.0.0" };
  }

  async checkAuth(): Promise<CheckStep> {
    return { name: "authenticated", ok: true, authStatus: "ready", command: "fake" };
  }

  repairFor(_status: AgentReadinessStatus): RepairAction | undefined {
    return undefined;
  }

  supportsModel(_modelId: string): boolean {
    return false;
  }
}

class FakeReadiness {
  constructor(private readonly statuses: Record<string, AgentReadinessStatus>) {}

  async checkAgent(agentId: string): Promise<AgentReadinessReport> {
    const status = this.statuses[agentId] ?? "ready";
    return {
      agentId,
      status,
      steps: [{ name: "installed", ok: status === "ready", command: "fake" }],
      checkedAt: NOW,
    };
  }
}

function fakeProvider(
  id: ModelProvider["id"],
  opts: {
    displayName: string;
    available: boolean;
    reason?: string;
    models: Array<{ id: string; displayName: string; capabilities: string[] }>;
  }
): ModelProvider {
  return {
    id,
    displayName: opts.displayName,
    version: "0.1.0",
    async isAvailable() {
      return { available: opts.available, reason: opts.reason };
    },
    async listModels() {
      return opts.models;
    },
    async complete() {
      throw new Error("unused");
    },
  };
}

function makeRegistry(statuses: Record<string, AgentReadinessStatus> = {}): OperatorRegistry {
  const adapters = new AdapterRegistry();
  adapters.register(new FakeAdapter("claude-code", "Claude Code"));
  adapters.register(new FakeAdapter("codex", "Codex", false, false));
  adapters.register(new FakeAdapter("antigravity", "Antigravity"));

  const models = new ModelProviderRegistry();
  models.register(
    fakeProvider("orca/openai", {
      displayName: "OpenAI",
      available: true,
      models: [
        { id: "gpt-5.1", displayName: "GPT 5.1", capabilities: ["planning"] },
        { id: "gpt-5.1-mini", displayName: "GPT 5.1 Mini", capabilities: ["fast"] },
      ],
    })
  );

  return new OperatorRegistry(adapters, models, new FakeReadiness(statuses));
}

describe("OperatorRegistry", () => {
  it("lists agents, model choices, and human in stable order", async () => {
    const operators = await makeRegistry().list("goal-1");

    expect(operators.map((operator) => operator.id)).toEqual([
      "agent:claude-code",
      "agent:codex",
      "agent:antigravity",
      "orca/openai:gpt-5.1",
      "orca/openai:gpt-5.1-mini",
      "human",
    ]);
  });

  it("tags agents with readiness, capabilities, and support flags", async () => {
    const operators = await makeRegistry({ codex: "needs_auth" }).list("goal-1");

    expect(operators.find((operator) => operator.id === "agent:claude-code")).toMatchObject({
      kind: "agent",
      displayName: "Claude Code",
      capabilities: ["repo_navigation", "architecture", "refactoring", "planning", "code_editing"],
      ready: true,
      supportsRepoEditing: true,
      supportsTerminal: true,
    });
    expect(operators.find((operator) => operator.id === "agent:codex")).toMatchObject({
      ready: false,
      notReadyReason: "needs_auth",
      supportsRepoEditing: false,
      supportsTerminal: false,
    });
    expect(operators.find((operator) => operator.id === "agent:antigravity")).toMatchObject({
      kind: "agent",
      displayName: "Antigravity",
      capabilities: ["repo_navigation", "planning", "implementation", "test_fixing", "code_editing"],
      ready: true,
      supportsRepoEditing: true,
      supportsTerminal: true,
    });
  });

  it("expands each model to a provider:model operator", async () => {
    const operators = await makeRegistry().list("goal-1");

    expect(operators.find((operator) => operator.id === "orca/openai:gpt-5.1")).toMatchObject({
      kind: "model",
      displayName: "OpenAI GPT 5.1",
      capabilities: ["planning"],
      ready: true,
      supportsRepoEditing: false,
      supportsTerminal: false,
    });
  });

  it("always includes a ready human operator", async () => {
    const operators = await makeRegistry().list("goal-1");

    expect(operators.at(-1)).toEqual({
      id: "human",
      kind: "human",
      displayName: "Human (you)",
      capabilities: ["judgment", "qa", "approval"],
      ready: true,
      supportsRepoEditing: true,
      supportsTerminal: true,
    });
  });

  it("filters to requested agentIds without probing others", async () => {
    const probed: string[] = [];

    class SpyReadiness {
      async checkAgent(agentId: string): Promise<AgentReadinessReport> {
        probed.push(agentId);
        return {
          agentId,
          status: "ready" satisfies AgentReadinessStatus,
          steps: [{ name: "installed", ok: true, command: "fake" }],
          checkedAt: NOW,
        };
      }
    }

    const adapters = new AdapterRegistry();
    adapters.register(new FakeAdapter("claude-code", "Claude Code"));
    adapters.register(new FakeAdapter("codex", "Codex", false, false));
    adapters.register(new FakeAdapter("antigravity", "Antigravity"));

    const models = new ModelProviderRegistry();
    const registry = new OperatorRegistry(adapters, models, new SpyReadiness());

    const operators = await registry.list("goal-1", {
      agentIds: ["codex"],
      includeNonAgents: false,
    });

    expect(probed).toEqual(["codex"]);
    expect(operators.map((op) => op.id)).toEqual(["agent:codex"]);
    // No model or human descriptors
    expect(operators.every((op) => op.kind === "agent")).toBe(true);
  });
});
