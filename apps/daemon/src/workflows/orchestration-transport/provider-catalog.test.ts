import { describe, expect, it } from "vitest";
import { ModelProviderRegistry } from "../../llm/registry.js";
import type { ModelProvider } from "../../llm/types.js";
import {
  buildOrchestrationProviderCatalog,
  modelOverridesForConnectedAgents,
  providerIdsForConnectedAgents,
  toModelProvidersResponse
} from "./provider-catalog.js";

function provider(
  id: ModelProvider["id"],
  displayName: string,
  available: boolean,
  reason?: string
): ModelProvider {
  return {
    id,
    displayName,
    version: "test",
    async isAvailable() {
      return available ? { available: true } : { available: false, reason };
    },
    async listModels() {
      return [{ id: "model-1", displayName: "Model 1", capabilities: ["reasoning"] }];
    },
    async complete() {
      throw new Error("not implemented");
    }
  };
}

describe("orchestration transport provider catalog", () => {
  it("returns product-facing names and automation readiness", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(provider("orca/openai", "OpenAI", true));
    registry.register(provider("orca/anthropic", "Anthropic", false, "ANTHROPIC_API_KEY not set"));

    const catalog = await buildOrchestrationProviderCatalog(registry);
    expect(catalog).toHaveLength(2);

    expect(catalog.find((p) => p.id === "orca/openai")).toMatchObject({
      displayName: "OpenAI",
      selectable: true,
      automatedAvailable: true
    });
    expect(catalog.find((p) => p.id === "orca/anthropic")).toMatchObject({
      displayName: "Claude",
      selectable: true,
      automatedAvailable: false,
      readinessReason: "ANTHROPIC_API_KEY not set"
    });

    const responseProviders = toModelProvidersResponse(catalog);
    expect(responseProviders.every((provider) => provider.available)).toBe(true);
  });

  it("caps readiness reason at 256 chars", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(provider("orca/openai", "OpenAI", false, "x".repeat(300)));

    const catalog = await buildOrchestrationProviderCatalog(registry);
    expect(catalog[0]?.readinessReason).toHaveLength(256);
  });

  it("can filter providers to connected onboarding agents", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(provider("orca/openai", "OpenAI", true));
    registry.register(provider("orca/anthropic", "Anthropic", true));

    const allowedProviderIds = providerIdsForConnectedAgents([
      { id: "claude-code", connected: false },
      { id: "codex", connected: true },
    ]);
    const modelOverrides = modelOverridesForConnectedAgents([
      { id: "claude-code", connected: false },
      { id: "codex", connected: true },
    ]);
    const catalog = await buildOrchestrationProviderCatalog(registry, {
      allowedProviderIds,
      modelOverrides,
    });

    expect(catalog.map((provider) => provider.id)).toEqual(["orca/openai"]);
    expect(catalog[0]?.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });
});
