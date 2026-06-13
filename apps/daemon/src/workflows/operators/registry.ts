import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type OperatorDescriptor,
} from "@orca/contracts";
import type { AdapterRegistry } from "../../adapters/registry.js";
import type { ModelProviderRegistry } from "../../llm/registry.js";
import type { ReadinessService } from "../../readiness/service.js";

type ReadinessChecker = Pick<ReadinessService, "checkAgent">;

const AGENT_CAPABILITIES: Record<string, string[]> = {
  "claude-code": ["repo_navigation", "architecture", "refactoring", "planning", "code_editing"],
  codex: ["implementation", "patching", "test_fixing", "code_editing"],
  antigravity: ["repo_navigation", "planning", "implementation", "test_fixing", "code_editing"],
};

function boundedReason(value: string | undefined, fallback: string): string {
  return (value ?? fallback).slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
}

export class OperatorRegistry {
  constructor(
    private readonly adapters: AdapterRegistry,
    private readonly models: ModelProviderRegistry,
    private readonly readiness: ReadinessChecker
  ) {}

  async list(
    goalId: string,
    options: {
      agentIds?: string[];
      includeNonAgents?: boolean;
    } = {}
  ): Promise<OperatorDescriptor[]> {
    void goalId;

    const out: OperatorDescriptor[] = [];

    const allowedAgents = options.agentIds ? new Set(options.agentIds) : null;
    const agentAdapters = this.adapters
      .listAgentAdapters()
      .filter((adapter) => allowedAgents?.has(adapter.id) ?? true);

    for (const adapter of agentAdapters) {
      const readiness = await this.readiness.checkAgent(adapter.id);
      const ready = readiness.status === "ready";
      out.push({
        id: `agent:${adapter.id}`,
        kind: "agent",
        displayName: adapter.title,
        capabilities: AGENT_CAPABILITIES[adapter.id] ?? [],
        ready,
        notReadyReason: ready ? undefined : boundedReason(undefined, readiness.status),
        supportsRepoEditing: adapter.supportsRepoEditing ?? true,
        supportsTerminal: adapter.supportsTerminal ?? true,
      });
    }

    if (options.includeNonAgents !== false) {
      for (const provider of this.models.list()) {
        const availability = await provider.isAvailable();
        const models = await provider.listModels();
        for (const model of models) {
          out.push({
            id: `${provider.id}:${model.id}`,
            kind: "model",
            displayName: `${provider.displayName} ${model.displayName}`,
            capabilities: model.capabilities,
            ready: availability.available,
            notReadyReason: availability.available
              ? undefined
              : boundedReason(availability.reason, "unavailable"),
            supportsRepoEditing: false,
            supportsTerminal: false,
            providerId: provider.id,
            modelId: model.id,
          });
        }
      }

      out.push({
        id: "human",
        kind: "human",
        displayName: "Human (you)",
        capabilities: ["judgment", "qa", "approval"],
        ready: true,
        supportsRepoEditing: true,
        supportsTerminal: true,
      });
    }

    return out;
  }
}
