import type { EffortLevel } from "@orca/contracts";

/**
 * A requirement set a node can reference instead of pinning a model.
 *
 * Constrains ONLY axes the catalog supplies first-party. The bundle's own
 * `capabilities` array holds internal feature flags (lean_prompt,
 * refusal_fallback) and not task ability, so there is deliberately no semantic
 * tag here: hand-authoring one would recreate the staleness this replaces.
 */
export interface ModelProfile {
  id: string;
  displayName: string;
  requires: {
    minStrength?: number;
    maxPricingTier?: string;
    minContextWindow?: number;
    needsEffortLevel?: EffortLevel;
  };
  preferredEffort?: EffortLevel;
  rank: "cheapest" | "strongest";
}

/** Mirrors the LIGHT / EXECUTION / REASONING tiers the built-in templates use. */
export const SEED_PROFILES: ModelProfile[] = [
  { id: "light", displayName: "Light", requires: {}, rank: "cheapest" },
  { id: "execution", displayName: "Execution", requires: { minStrength: 3 }, rank: "cheapest" },
  { id: "reasoning", displayName: "Reasoning", requires: { minStrength: 4 }, rank: "strongest" },
];
