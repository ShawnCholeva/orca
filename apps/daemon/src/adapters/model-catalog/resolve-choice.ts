import type { AdapterId, EffortLevel, NodeModelSelection, ResolvedModelChoice } from "@orca/contracts";
import type { ModelProfile } from "./profiles.js";
import { pricingRank, type CatalogModel } from "./types.js";

/**
 * The effort a model will actually run at. An authored level the model does not
 * support falls back to its default rather than being passed through — the CLI
 * would reject it and the step would die at spawn.
 *
 * Never returns null when `supportedEfforts` is non-empty: a model can declare
 * effort capabilities with no `default_effort` (e.g. claude-sonnet-4-6), and
 * omitting `--effort` there lets the user's ambient CLI settings silently
 * govern the run — exactly the defect this resolver exists to remove. Fallback
 * order: requested (if supported) -> catalog default (if set) -> "high" (if
 * supported) -> the last supported effort.
 */
function settleEffort(model: CatalogModel, wanted: EffortLevel | null): EffortLevel | null {
  if (model.supportedEfforts.length === 0) return null;
  if (wanted && model.supportedEfforts.includes(wanted)) return wanted;
  if (model.defaultEffort) return model.defaultEffort;
  if (model.supportedEfforts.includes("high")) return "high";
  return model.supportedEfforts[model.supportedEfforts.length - 1];
}

function meets(model: CatalogModel, profile: ModelProfile): boolean {
  const r = profile.requires;
  if (r.minStrength !== undefined && (model.advisorRank ?? -1) < r.minStrength) return false;
  if (r.minContextWindow !== undefined && model.contextWindow < r.minContextWindow) return false;
  if (r.maxPricingTier !== undefined && pricingRank(model.pricingTier) > pricingRank(r.maxPricingTier)) return false;
  if (r.needsEffortLevel !== undefined && !model.supportedEfforts.includes(r.needsEffortLevel)) return false;
  return true;
}

export function resolveChoice(
  selection: NodeModelSelection,
  catalog: CatalogModel[],
  adapterId: AdapterId,
  profiles: ModelProfile[],
): ResolvedModelChoice | null {
  if (selection.kind === "pinned") {
    const model = catalog.find((m) => m.id === selection.modelId);
    if (!model) return null;
    return {
      adapterId: selection.adapterId,
      modelId: model.id,
      contextVariant: selection.contextVariant === "1m" && model.supports1mSuffix ? "1m" : "default",
      effort: settleEffort(model, selection.effort),
    };
  }

  const profile = profiles.find((p) => p.id === selection.ref);
  if (!profile) return null;
  // Legacy models (no advisorRank) are not part of the CLI's advised lineup —
  // they remain pinnable but are never chosen for a profile.
  const eligible = catalog.filter((m) => m.advisorRank !== null && meets(m, profile));
  if (eligible.length === 0) return null;

  // advisorRank leads; pricingRank only tiebreaks. A model's price string can
  // be unparseable (e.g. "haiku_45") without that making it any less the
  // cheapest model in the advised lineup — pricingRank alone would sort it
  // last via its UNPARSEABLE sentinel.
  const sorted = [...eligible].sort((a, b) =>
    profile.rank === "cheapest"
      ? (a.advisorRank as number) - (b.advisorRank as number) || pricingRank(a.pricingTier) - pricingRank(b.pricingTier)
      : (b.advisorRank as number) - (a.advisorRank as number) || pricingRank(a.pricingTier) - pricingRank(b.pricingTier),
  );
  const model = sorted[0];
  return {
    adapterId,
    modelId: model.id,
    contextVariant: "default",
    effort: settleEffort(model, profile.preferredEffort ?? null),
  };
}
