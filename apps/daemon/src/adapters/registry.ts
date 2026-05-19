import type { AdapterId, AdapterSummary } from "@orca/contracts";
import type { AgentAdapter, AdapterAvailability } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly availabilityCache = new Map<string, AdapterAvailability>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Probe and cache availability lazily; cached for the process lifetime. */
  async list(): Promise<AdapterSummary[]> {
    const results: AdapterSummary[] = [];
    for (const adapter of this.adapters.values()) {
      let availability = this.availabilityCache.get(adapter.id);
      if (!availability) {
        try {
          availability = await adapter.probeAvailability();
        } catch {
          availability = { status: "unknown" };
        }
        this.availabilityCache.set(adapter.id, availability);
      }
      results.push({
        id: adapter.id as AdapterId,
        title: adapter.title,
        availability: availability.status,
        detail: "detail" in availability ? availability.detail : undefined,
      });
    }
    return results;
  }

  /** Clear the availability cache (useful in tests). */
  clearCache(): void {
    this.availabilityCache.clear();
  }
}

export const adapterRegistry = new AdapterRegistry();
