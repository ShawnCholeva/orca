import {
  OrchestratorAction,
  type ModelProviderId,
} from "@orca/contracts";
import type { ModelProviderRegistry } from "../llm/registry.js";
import type { OrchestratorLlmClient } from "./mediator.js";

const PROVIDER_BY_ADAPTER_ID: Record<string, ModelProviderId | undefined> = {
  "claude-code": "orca/anthropic",
  codex: "orca/openai",
};

export class ModelProviderOrchestratorLlmClient implements OrchestratorLlmClient {
  constructor(private readonly registry: ModelProviderRegistry) {}

  async request(input: {
    goalId: string;
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }> {
    const providerId = PROVIDER_BY_ADAPTER_ID[input.adapterId];
    if (!providerId) {
      throw new Error(`No model provider mapped for adapter ${input.adapterId}`);
    }
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`Model provider unavailable: ${providerId}`);
    }
    const completion = await provider.complete({
      model: input.modelId,
      systemPrompt: [
        input.systemPrompt,
        "",
        `Runtime identity: this orchestrator invocation is configured for provider ${providerId}, adapter ${input.adapterId}, model ${input.modelId}.`,
        "If the user asks what model or provider is being used, report that configured runtime identity and do not claim a different model.",
      ].join("\n"),
      userPrompt: input.userPrompt,
      responseSchemaName: "OrchestratorAction",
      responseSchema: OrchestratorAction,
      maxOutputTokens: 1200,
      temperature: 0,
      callMetadata: { goalId: input.goalId },
    });
    return { text: JSON.stringify(completion.parsed) };
  }
}

export class RoutedOrchestratorLlmClient implements OrchestratorLlmClient {
  constructor(
    private readonly shadowClient: OrchestratorLlmClient,
    private readonly providerClient: OrchestratorLlmClient
  ) {}

  async request(input: {
    goalId: string;
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }> {
    if (input.adapterId === "claude-code" || input.adapterId === "codex") {
      return this.shadowClient.request(input);
    }
    return this.providerClient.request(input);
  }
}

export function adapterIdForProvider(providerId: ModelProviderId): string {
  switch (providerId) {
    case "orca/anthropic":
      return "claude-code";
    case "orca/openai":
      return "codex";
  }
}
