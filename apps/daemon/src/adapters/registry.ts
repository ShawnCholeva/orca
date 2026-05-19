import type { AdapterSummary } from "@orca/contracts";
import type { AgentAdapter, AdapterAvailability } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly availabilityCache = new Map<string, AdapterAvailability>();
  private frozen = false;

  register(adapter: AgentAdapter): void {
    if (this.frozen) {
      throw new Error('AdapterRegistry is frozen');
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Duplicate adapter id: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  freeze(): void {
    this.frozen = true;
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Probe and cache availability lazily; probes are parallelized on a cold cache. */
  async list(): Promise<AdapterSummary[]> {
    const adapterList = [...this.adapters.values()];
    const uncached = adapterList.filter(a => !this.availabilityCache.has(a.id));

    if (uncached.length > 0) {
      const outcomes = await Promise.allSettled(uncached.map(a => a.probeAvailability()));
      uncached.forEach((a, i) => {
        const outcome = outcomes[i]!;
        const availability: AdapterAvailability =
          outcome.status === "fulfilled" ? outcome.value : { status: "unknown" };
        this.availabilityCache.set(a.id, availability);
      });
    }

    return adapterList.map(adapter => {
      const availability = this.availabilityCache.get(adapter.id) ?? { status: "unknown" as const };
      return {
        id: adapter.id,
        title: adapter.title,
        availability: availability.status,
        detail: "detail" in availability ? availability.detail : undefined,
      };
    });
  }

  /** Clear the availability cache (useful in tests). */
  clearCache(): void {
    this.availabilityCache.clear();
  }
}

export const adapterRegistry = new AdapterRegistry();
