import { describe, expect, it } from "vitest";
import type { ModelProviderInfo } from "@orca/contracts";

import { defaultModelForProvider } from "./orchestratorDefaults";

function provider(id: ModelProviderInfo["id"], models: Array<{ id: string; displayName?: string }>): ModelProviderInfo {
  return {
    id,
    displayName: id,
    available: true,
    models: models.map((model) => ({
      id: model.id,
      displayName: model.displayName ?? model.id,
      capabilities: [],
    })),
  };
}

describe("orchestrator defaults", () => {
  it("defaults Claude to Haiku when available", () => {
    expect(
      defaultModelForProvider(
        provider("orca/anthropic", [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" },
          { id: "claude-haiku-4-5" },
        ]),
      )?.id,
    ).toBe("claude-haiku-4-5");
  });

  it("defaults Codex/OpenAI to GPT-5.4 mini when available", () => {
    expect(
      defaultModelForProvider(
        provider("orca/openai", [
          { id: "gpt-5.5" },
          { id: "gpt-5.4" },
          { id: "gpt-5.4-mini" },
          { id: "gpt-5.3-codex" },
          { id: "gpt-5.2" },
        ]),
      )?.id,
    ).toBe("gpt-5.4-mini");
  });

  it("falls back to the first model when the preferred default is unavailable", () => {
    expect(
      defaultModelForProvider(
        provider("orca/anthropic", [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" },
        ]),
      )?.id,
    ).toBe("claude-opus-4-7");
  });
});
