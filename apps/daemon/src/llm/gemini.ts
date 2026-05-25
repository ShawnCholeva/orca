import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import type { ModelCompletionRequest, ModelCompletionResponse, ModelProvider } from "./types.js";
import { ProviderError } from "./types.js";

const MODELS = [
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    capabilities: ["reasoning", "long_context"]
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    capabilities: ["fast", "cheap"]
  }
] as const;

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;
const PROVIDER_VERSION = "0.1.0";
const MAX_ERROR_MESSAGE_CHARS = 256;

interface CreateGeminiProviderOptions {
  apiKeyEnvVar?: string;
  apiKeyResolver?: () => string | undefined;
  clientFactory?: () => GoogleGenerativeAI;
}

function normalizeModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed : DEFAULT_MODEL;
}

function truncateAndRedactMessage(err: unknown): string {
  const base = err instanceof Error ? err.message : "unknown error";
  const compact = base.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/sk-ant-[A-Za-z0-9_\-]{16,}/g, "<redacted>")
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, "<redacted>")
    .replace(/AIza[A-Za-z0-9_\-]{20,}/g, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer <redacted>");
  return redacted.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function mapProviderFailure(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const fallback = truncateAndRedactMessage(err);
  if (/rate.?limit/i.test(fallback)) return new ProviderError("rate_limited", fallback);
  if (/timeout/i.test(fallback)) return new ProviderError("timeout", fallback);
  return new ProviderError("provider_error", fallback);
}

export function createGeminiProvider(opts: CreateGeminiProviderOptions = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "GOOGLE_API_KEY";
  let client: GoogleGenerativeAI | null = null;

  const resolveKey = () => {
    const resolved = opts.apiKeyResolver?.();
    if (resolved?.trim()) return resolved.trim();
    const fromEnv = process.env[envVar];
    return fromEnv?.trim();
  };

  const ensureClient = () => {
    if (client) return client;
    const key = resolveKey();
    if (!key) throw new ProviderError("missing_api_key", `${envVar} not set`);
    client = opts.clientFactory ? opts.clientFactory() : new GoogleGenerativeAI(key);
    return client;
  };

  return {
    id: "orca/google-gemini",
    displayName: "Google Gemini",
    version: PROVIDER_VERSION,
    async isAvailable() {
      return resolveKey()
        ? { available: true }
        : { available: false, reason: `${envVar} not set` };
    },
    async listModels() {
      return MODELS.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: [...model.capabilities]
      }));
    },
    async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
      const c = ensureClient();
      const started = Date.now();

      try {
        const model = c.getGenerativeModel({
          model: normalizeModelId(req.model),
          generationConfig: {
            temperature: req.temperature ?? DEFAULT_TEMPERATURE,
            maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json"
          }
        });

        const result = await model.generateContent([
          {
            text: `${req.systemPrompt}\n\nReturn ONLY a JSON object matching schema \"${req.responseSchemaName}\".`
          },
          { text: req.userPrompt }
        ]);

        const text = result.response.text().trim();

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text);
        } catch {
          throw new ProviderError("invalid_output", "non-JSON response");
        }

        const schema = req.responseSchema as z.ZodTypeAny;
        const validation = schema.safeParse(parsedJson);
        if (!validation.success) {
          throw new ProviderError(
            "invalid_output",
            validation.error.issues[0]?.message ?? "schema mismatch"
          );
        }

        const usage = result.response.usageMetadata;
        return {
          parsed: validation.data as T,
          rawTextLength: text.length,
          usageTokensInput: usage?.promptTokenCount,
          usageTokensOutput: usage?.candidatesTokenCount,
          latencyMs: Date.now() - started,
          providerVersion: PROVIDER_VERSION
        };
      } catch (err) {
        throw mapProviderFailure(err);
      }
    }
  };
}
