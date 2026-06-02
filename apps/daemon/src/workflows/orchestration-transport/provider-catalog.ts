import type { ModelProviderInfo, ModelProviderId } from "@orca/contracts";
import type { ModelProviderRegistry } from "../../llm/registry.js";
import {
  MODELS_BY_AGENT_ID,
  PROVIDER_BY_AGENT_ID,
  type AdapterModelInfo,
} from "../../adapters/model-catalog.js";

const MAX_REASON_CHARS = 256;

const PRODUCT_DISPLAY_NAMES: Record<ModelProviderId, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude"
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

export function providerIdsForConnectedAgents(
  agents: Array<{ id: string; connected: boolean }>
): Set<ModelProviderId> {
  const ids = new Set<ModelProviderId>();
  for (const agent of agents) {
    if (!agent.connected) continue;
    const providerId = PROVIDER_BY_AGENT_ID[agent.id];
    if (providerId) ids.add(providerId);
  }
  return ids;
}

export function modelOverridesForConnectedAgents(
  agents: Array<{ id: string; connected: boolean }>
): Map<ModelProviderId, AdapterModelInfo[]> {
  const overrides = new Map<ModelProviderId, AdapterModelInfo[]>();
  for (const agent of agents) {
    if (!agent.connected) continue;
    const providerId = PROVIDER_BY_AGENT_ID[agent.id];
    const models = MODELS_BY_AGENT_ID[agent.id];
    if (providerId && models) overrides.set(providerId, models);
  }
  return overrides;
}

export async function buildOrchestrationProviderCatalog(
  registry: ModelProviderRegistry,
  opts: {
    allowedProviderIds?: ReadonlySet<ModelProviderId>;
    modelOverrides?: ReadonlyMap<ModelProviderId, AdapterModelInfo[]>;
  } = {}
): Promise<OrchestrationProviderCatalogEntry[]> {
  const providers = await registry.describe();
  const allowedProviderIds = opts.allowedProviderIds;
  const modelOverrides = opts.modelOverrides;

  return providers
    .filter((provider) => !allowedProviderIds || allowedProviderIds.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      displayName: PRODUCT_DISPLAY_NAMES[provider.id],
      selectable: true,
      automatedAvailable: provider.available,
      readinessReason: capReason(provider.reason),
      models: (modelOverrides?.get(provider.id) ?? provider.models).map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: [...model.capabilities],
      }))
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
