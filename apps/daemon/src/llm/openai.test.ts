import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAIProvider } from "./openai.js";

const RESPONSE_SCHEMA = z.object({
  answer: z.string().min(1)
});

function makeRequest() {
  return {
    model: "gpt-4o-mini",
    systemPrompt: "You are a strict JSON generator.",
    userPrompt: "Respond with answer=ok",
    responseSchemaName: "AnswerSchema",
    responseSchema: RESPONSE_SCHEMA,
    callMetadata: {}
  };
}

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("createOpenAIProvider", () => {
  it("returns missing_api_key when the configured key is absent", async () => {
    const provider = createOpenAIProvider({ apiKeyEnvVar: "OPENAI_API_KEY" });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "missing_api_key"
    });
  });

  it("returns invalid_output when the model responds with non-JSON text", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "plain text response" } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 }
    });

    const provider = createOpenAIProvider({
      clientFactory: () =>
        ({
          chat: { completions: { create } }
        }) as unknown as OpenAI
    });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "invalid_output"
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_output when JSON does not satisfy the response schema", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ wrong: true }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 }
    });

    const provider = createOpenAIProvider({
      clientFactory: () =>
        ({
          chat: { completions: { create } }
        }) as unknown as OpenAI
    });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "invalid_output"
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns parsed output and metadata on happy path", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
      usage: { prompt_tokens: 21, completion_tokens: 5 }
    });

    const provider = createOpenAIProvider({
      clientFactory: () =>
        ({
          chat: { completions: { create } }
        }) as unknown as OpenAI
    });

    const result = await provider.complete({
      ...makeRequest(),
      model: "   "
    });

    expect(result.parsed).toEqual({ answer: "ok" });
    expect(result.rawTextLength).toBe(JSON.stringify({ answer: "ok" }).length);
    expect(result.usageTokensInput).toBe(21);
    expect(result.usageTokensOutput).toBe(5);
    expect(result.providerVersion).toBe("0.1.0");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        max_tokens: 1024,
        temperature: 0,
        response_format: { type: "json_object" }
      })
    );
  });
});
