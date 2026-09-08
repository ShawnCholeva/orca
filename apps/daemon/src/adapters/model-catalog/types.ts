export type { CatalogModel } from "@orca/contracts";

const UNPARSEABLE = Number.MAX_SAFE_INTEGER;

/**
 * Rank a pricing tier for comparison. "tier_5_25" is $5/$25 per Mtok, so the
 * input price leads and the output price breaks ties. This is a PREFIX match
 * (no trailing `$`): real bundle strings like "tier_10_50_cache_read_0_25"
 * carry a suffix and must still rank by their base rates. An unparseable tier
 * (no leading "tier_<n>_<n>" at all, e.g. "haiku_45") sorts LAST: excluded
 * from a budget-bounded profile rather than assumed cheap.
 */
export function pricingRank(tier: string | null): number {
  if (!tier) return UNPARSEABLE;
  const m = /^tier_(\d+)_(\d+)/.exec(tier);
  if (!m) return UNPARSEABLE;
  return Number(m[1]) * 1000 + Number(m[2]);
}
