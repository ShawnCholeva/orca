import { GoogleGenerativeAI } from "@google/generative-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGeminiProvider } from "./gemini.js";

const RESPONSE_SCHEMA = z.object({
  answer: z.string().min(1)
});

function makeRequest() {
  return {
    model: "gemini-2.5-flash",
    systemPrompt: "You are a strict JSON generator.",
    userPrompt: "Respond with answer=ok",
    responseSchemaName: "AnswerSchema",
    responseSchema: RESPONSE_SCHEMA,
    callMetadata: {}
  };
}

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
});

describe("createGeminiProvider", () => {
  it("returns missing_api_key when the configured key is absent", async () => {
    const provider = createGeminiProvider({ apiKeyEnvVar: "GOOGLE_API_KEY" });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "missing_api_key"
    });
  });

  it("returns invalid_output when the model responds with non-JSON text", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => "plain text response",
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 }
      }
    });
    const getGenerativeModel = vi.fn().mockReturnValue({ generateContent });

    const provider = createGeminiProvider({
      clientFactory: () =>
        ({
          getGenerativeModel
        }) as unknown as GoogleGenerativeAI
    });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "invalid_output"
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_output when JSON does not satisfy the response schema", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({ wrong: true }),
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 }
      }
    });
    const getGenerativeModel = vi.fn().mockReturnValue({ generateContent });

    const provider = createGeminiProvider({
      clientFactory: () =>
        ({
          getGenerativeModel
        }) as unknown as GoogleGenerativeAI
    });

    await expect(provider.complete(makeRequest())).rejects.toMatchObject({
      code: "invalid_output"
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns parsed output and metadata on happy path", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify({ answer: "ok" }),
        usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 5 }
      }
    });
    const getGenerativeModel = vi.fn().mockReturnValue({ generateContent });

    const provider = createGeminiProvider({
      clientFactory: () =>
        ({
          getGenerativeModel
        }) as unknown as GoogleGenerativeAI
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

    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
    expect(getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.5-flash",
        generationConfig: expect.objectContaining({
          temperature: 0,
          maxOutputTokens: 1024,
          responseMimeType: "application/json"
        })
      })
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
