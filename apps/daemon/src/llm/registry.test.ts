import { describe, expect, it } from "vitest";
import { ModelProviderRegistry } from "./registry.js";
import type { ModelProvider } from "./types.js";

function makeProvider(
  id: ModelProvider["id"],
  opts?: {
    displayName?: string;
    available?: boolean;
    reason?: string;
    models?: Array<{ id: string; displayName: string; capabilities: string[] }>;
  }
): ModelProvider {
  return {
    id,
    displayName: opts?.displayName ?? id,
    version: "0.1.0",
    async isAvailable() {
      return { available: opts?.available ?? true, reason: opts?.reason };
    },
    async listModels() {
      return opts?.models ?? [
        { id: `${id}-model`, displayName: `${id} Model`, capabilities: ["test"] },
      ];
    },
    async complete() {
      throw new Error("unused in this test");
    },
  };
}

describe("ModelProviderRegistry", () => {
  it("register/get/list round-trip providers", () => {
    const registry = new ModelProviderRegistry();
    const anthropic = makeProvider("orca/anthropic");
    const openai = makeProvider("orca/openai");

    registry.register(anthropic);
    registry.register(openai);

    expect(registry.get("orca/anthropic")).toBe(anthropic);
    expect(registry.list().map((p) => p.id)).toEqual([
      "orca/anthropic",
      "orca/openai",
    ]);
  });

  it("throws on duplicate provider id", () => {
    const registry = new ModelProviderRegistry();
    registry.register(makeProvider("orca/openai"));

    expect(() => registry.register(makeProvider("orca/openai"))).toThrow(
      "duplicate provider orca/openai"
    );
  });

  it("describe returns provider availability and models", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(
      makeProvider("orca/openai", {
        displayName: "OpenAI",
        available: false,
        reason: "OPENAI_API_KEY not set",
        models: [
          {
            id: "gpt-5",
            displayName: "GPT-5",
            capabilities: ["fast", "cheap"],
          },
        ],
      })
    );

    await expect(registry.describe()).resolves.toEqual([
      {
        id: "orca/openai",
        displayName: "OpenAI",
        available: false,
        reason: "OPENAI_API_KEY not set",
        models: [
          {
            id: "gpt-5",
            displayName: "GPT-5",
            capabilities: ["fast", "cheap"],
          },
        ],
      },
    ]);
  });
});
