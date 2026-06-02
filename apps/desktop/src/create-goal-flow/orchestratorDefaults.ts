import type { ModelProviderInfo } from "@orca/contracts";

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  "orca/anthropic": "claude-haiku-4-5",
  "orca/openai": "gpt-5.4-mini",
  "orca/google": "gemini-3.5-flash",
};

export function defaultModelForProvider(provider: ModelProviderInfo): ModelProviderInfo["models"][number] | null {
  const preferredId = DEFAULT_MODEL_BY_PROVIDER[provider.id];
  if (preferredId) {
    const preferred = provider.models.find((model) => model.id === preferredId);
    if (preferred) return preferred;
  }
  return provider.models[0] ?? null;
}
