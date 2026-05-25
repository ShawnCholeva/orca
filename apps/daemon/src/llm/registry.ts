import type { ModelProviderId, ModelProviderInfo } from "@orca/contracts";
import type { ModelProvider } from "./types.js";

export class ModelProviderRegistry {
  private readonly providers = new Map<ModelProviderId, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate provider ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: ModelProviderId): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  async describe(): Promise<ModelProviderInfo[]> {
    const out: ModelProviderInfo[] = [];
    for (const provider of this.providers.values()) {
      const availability = await provider.isAvailable();
      const models = await provider.listModels();
      out.push({
        id: provider.id,
        displayName: provider.displayName,
        available: availability.available,
        reason: availability.reason,
        models,
      });
    }
    return out;
  }
}
