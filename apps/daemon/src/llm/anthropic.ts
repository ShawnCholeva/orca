import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  RateLimitError
} from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ModelCompletionRequest, ModelCompletionResponse, ModelProvider } from "./types.js";
import { ProviderError } from "./types.js";
import { MODELS_BY_AGENT_ID } from "../adapters/model-catalog.js";

const MODELS = MODELS_BY_AGENT_ID["claude-code"] ?? [];

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 150;
const PROMPT_CACHING_BETA_HEADER = "prompt-caching-2024-07-31";
const PROVIDER_VERSION = "0.1.0";
const MAX_ERROR_MESSAGE_CHARS = 256;

interface CreateAnthropicProviderOptions {
  apiKeyEnvVar?: string;
  apiKeyResolver?: () => string | undefined;
  clientFactory?: () => Anthropic;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function normalizeModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed : DEFAULT_MODEL;
}

function extractText(contentBlocks: Array<{ type: string; text?: string }>): string {
  return contentBlocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .trim();
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
  if (err instanceof RateLimitError) {
    return new ProviderError("rate_limited", truncateAndRedactMessage(err));
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError("timeout", truncateAndRedactMessage(err));
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError("provider_error", truncateAndRedactMessage(err));
  }
  if (err instanceof APIError) {
    return new ProviderError(
      err.status === 429 ? "rate_limited" : "provider_error",
      truncateAndRedactMessage(err)
    );
  }

  const fallback = truncateAndRedactMessage(err);
  if (/rate.?limit/i.test(fallback)) return new ProviderError("rate_limited", fallback);
  if (/timeout/i.test(fallback)) return new ProviderError("timeout", fallback);
  return new ProviderError("provider_error", fallback);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAnthropicProvider(opts: CreateAnthropicProviderOptions = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
  const timeoutMs = Math.max(1, opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

  let client: Anthropic | null = null;

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
    client = opts.clientFactory
      ? opts.clientFactory()
      : new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs });
    return client;
  };

  return {
    id: "orca/anthropic",
    displayName: "Anthropic",
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
      let attempt = 0;

      while (true) {
        attempt += 1;
        try {
          const msg = await c.messages.create(
            {
              model: normalizeModelId(req.model),
              max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              temperature: req.temperature ?? DEFAULT_TEMPERATURE,
              system: `${req.systemPrompt}\n\nReturn ONLY a JSON object matching the schema "${req.responseSchemaName}". No prose.`,
              messages: [{ role: "user", content: req.userPrompt }]
            },
            {
              timeout: timeoutMs,
              headers: {
                "anthropic-beta": PROMPT_CACHING_BETA_HEADER
              }
            }
          );

          const text = extractText(msg.content as Array<{ type: string; text?: string }>);

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
            usageTokensInput: msg.usage?.input_tokens,
            usageTokensOutput: msg.usage?.output_tokens,
            latencyMs: Date.now() - started,
            providerVersion: PROVIDER_VERSION
          };
        } catch (err) {
          const mapped = mapProviderFailure(err);
          const retriable =
            mapped.code === "timeout" ||
            mapped.code === "rate_limited" ||
            mapped.code === "provider_error";
          if (!retriable || attempt >= maxAttempts) throw mapped;
          if (retryDelayMs > 0) await sleep(retryDelayMs);
        }
      }
    }
  };
}
