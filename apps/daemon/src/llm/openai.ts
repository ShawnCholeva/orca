import OpenAI from "openai";
import { z } from "zod";
import type { ModelCompletionRequest, ModelCompletionResponse, ModelProvider } from "./types.js";
import { ProviderError } from "./types.js";
import { MODELS_BY_AGENT_ID } from "../adapters/model-catalog.js";

const MODELS = [
  ...(MODELS_BY_AGENT_ID.codex ?? []),
  {
    id: "gpt-5",
    displayName: "GPT-5",
    capabilities: ["reasoning", "long_context"]
  },
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    capabilities: ["reasoning", "tool_use"]
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    capabilities: ["fast", "cheap"]
  }
];

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;
const PROVIDER_VERSION = "0.1.0";
const MAX_ERROR_MESSAGE_CHARS = 256;

interface CreateOpenAIProviderOptions {
  apiKeyEnvVar?: string;
  apiKeyResolver?: () => string | undefined;
  clientFactory?: () => OpenAI;
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

function extractResponseText(resp: {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
    };
  }>;
}): string {
  const content = resp.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && part.type === "text" ? (part.text ?? "") : ""))
      .join("")
      .trim();
  }
  return "";
}

export function createOpenAIProvider(opts: CreateOpenAIProviderOptions = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "OPENAI_API_KEY";

  let client: OpenAI | null = null;

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
    client = opts.clientFactory ? opts.clientFactory() : new OpenAI({ apiKey: key });
    return client;
  };

  return {
    id: "orca/openai",
    displayName: "OpenAI",
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
        const resp = await c.chat.completions.create({
          model: normalizeModelId(req.model),
          temperature: req.temperature ?? DEFAULT_TEMPERATURE,
          max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${req.systemPrompt}\n\nReturn ONLY a JSON object matching schema \"${req.responseSchemaName}\".`
            },
            { role: "user", content: req.userPrompt }
          ]
        });

        const text = extractResponseText(resp as unknown as Parameters<typeof extractResponseText>[0]);

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

        return {
          parsed: validation.data as T,
          rawTextLength: text.length,
          usageTokensInput: resp.usage?.prompt_tokens,
          usageTokensOutput: resp.usage?.completion_tokens,
          latencyMs: Date.now() - started,
          providerVersion: PROVIDER_VERSION
        };
      } catch (err) {
        throw mapProviderFailure(err);
      }
    }
  };
}
