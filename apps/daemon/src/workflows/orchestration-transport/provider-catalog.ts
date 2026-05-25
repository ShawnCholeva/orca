import type { ModelProviderInfo, ModelProviderId } from "@orca/contracts";
import type { ModelProviderRegistry } from "../../llm/registry.js";

const MAX_REASON_CHARS = 256;

const PRODUCT_DISPLAY_NAMES: Record<ModelProviderId, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
  "orca/google-gemini": "Gemini"
};

export interface OrchestrationProviderCatalogEntry {
  id: ModelProviderId;
  displayName: string;
  selectable: true;
  automatedAvailable: boolean;
  readinessReason?: string;
  models: ModelProviderInfo["models"];
}

function capReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_REASON_CHARS);
}

export async function buildOrchestrationProviderCatalog(
  registry: ModelProviderRegistry
): Promise<OrchestrationProviderCatalogEntry[]> {
  const providers = await registry.describe();

  return providers.map((provider) => ({
    id: provider.id,
    displayName: PRODUCT_DISPLAY_NAMES[provider.id],
    selectable: true,
    automatedAvailable: provider.available,
    readinessReason: capReason(provider.reason),
    models: provider.models
  }));
}

export function toModelProvidersResponse(
  catalog: OrchestrationProviderCatalogEntry[]
): ModelProviderInfo[] {
  return catalog.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    // Legacy wire shape compatibility for M1-M8 clients:
    // "available" remains true because provider selection can always fall back to human review.
    available: provider.selectable,
    reason: provider.readinessReason,
    models: provider.models
  }));
}
