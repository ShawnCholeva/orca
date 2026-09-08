import type { AdapterId, ModelProviderInfo, ModelProviderId } from "@orca/contracts";
import type { ModelProviderRegistry } from "../../llm/registry.js";
import { PROVIDER_BY_AGENT_ID, SEED_CATALOG } from "../../adapters/model-catalog/seed.js";

type AdapterModelInfo = ModelProviderInfo["models"][number];

const MAX_REASON_CHARS = 256;

const PRODUCT_DISPLAY_NAMES: Record<ModelProviderId, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
  "orca/google": "Google",
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
    const models = SEED_CATALOG[agent.id as AdapterId];
    if (providerId && models) {
      overrides.set(
        providerId,
        models.map((model) => ({ id: model.id, displayName: model.displayName, capabilities: [] as string[] }))
      );
    }
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

  const direct: OrchestrationProviderCatalogEntry[] = providers
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

  const directIds = new Set(direct.map((provider) => provider.id));
  const virtual: OrchestrationProviderCatalogEntry[] = [...(modelOverrides?.entries() ?? [])]
    .filter(([providerId]) => !directIds.has(providerId))
    .filter(([providerId]) => !allowedProviderIds || allowedProviderIds.has(providerId))
    .map(([providerId, models]) => ({
      id: providerId,
      displayName: PRODUCT_DISPLAY_NAMES[providerId],
      selectable: true as const,
      automatedAvailable: true,
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: [...model.capabilities],
      })),
    }));

  return [...direct, ...virtual];
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
