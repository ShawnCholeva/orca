import { describe, expect, it, vi } from "vitest";
import { ModelProviderRegistry } from "../llm/registry.js";
import type { ModelProvider } from "../llm/types.js";
import {
  ModelProviderOrchestratorLlmClient,
  RoutedOrchestratorLlmClient,
  adapterIdForProvider,
} from "./model-provider-llm-client.js";

function provider(): ModelProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => ({
    parsed: { kind: "answer_user_directly", body: "hi" },
    rawTextLength: 12,
    latencyMs: 1,
    providerVersion: "test",
  }));
  return {
    id: "orca/openai",
    displayName: "OpenAI",
    version: "test",
    async isAvailable() {
      return { available: true };
    },
    async listModels() {
      return [{ id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", capabilities: [] }];
    },
    complete: complete as unknown as ModelProvider["complete"] & ReturnType<typeof vi.fn>,
  };
}

describe("ModelProviderOrchestratorLlmClient", () => {
  it("maps codex mediator requests to the OpenAI provider and selected model", async () => {
    const registry = new ModelProviderRegistry();
    const openai = provider();
    registry.register(openai);
    const client = new ModelProviderOrchestratorLlmClient(registry);

    const result = await client.request({
      goalId: "goal-1",
      adapterId: "codex",
      modelId: "gpt-5.4-mini",
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(JSON.parse(result.text)).toEqual({ kind: "answer_user_directly", body: "hi" });
    expect(openai.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.4-mini",
      responseSchemaName: "OrchestratorAction",
      callMetadata: { goalId: "goal-1" },
    }));
  });

  it("routes claude-code and codex to shadow sessions", async () => {
    const shadow = { request: vi.fn(async () => ({ text: '{"kind":"approve_step_complete"}' })) };
    const providerClient = { request: vi.fn(async () => ({ text: '{"kind":"answer_user_directly","body":"hi"}' })) };
    const routed = new RoutedOrchestratorLlmClient(shadow, providerClient);

    await routed.request({ goalId: "g", adapterId: "claude-code", modelId: "claude-haiku-4-5", systemPrompt: "s", userPrompt: "u" });
    await routed.request({ goalId: "g", adapterId: "codex", modelId: "gpt-5.4-mini", systemPrompt: "s", userPrompt: "u" });
    await routed.request({ goalId: "g", adapterId: "antigravity", modelId: "gemini-3.5-flash", systemPrompt: "s", userPrompt: "u" });

    expect(shadow.request).toHaveBeenCalledTimes(3);
    expect(shadow.request.mock.calls.map(([input]) => input.adapterId)).toContain("antigravity");
    expect(providerClient.request).not.toHaveBeenCalled();
  });

  it("maps providers to backing adapters", () => {
    expect(adapterIdForProvider("orca/anthropic")).toBe("claude-code");
    expect(adapterIdForProvider("orca/openai")).toBe("codex");
    expect(adapterIdForProvider("orca/google")).toBe("antigravity");
  });
});
