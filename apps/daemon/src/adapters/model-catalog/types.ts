export type { CatalogModel } from "@orca/contracts";

const UNPARSEABLE = Number.MAX_SAFE_INTEGER;

/**
 * Rank a pricing tier for comparison. "tier_5_25" is $5/$25 per Mtok, so the
 * input price leads and the output price breaks ties. An unparseable tier sorts
 * LAST: excluded from a budget-bounded profile rather than assumed cheap.
 */
export function pricingRank(tier: string | null): number {
  if (!tier) return UNPARSEABLE;
  const m = /^tier_(\d+)_(\d+)$/.exec(tier);
  if (!m) return UNPARSEABLE;
  return Number(m[1]) * 1000 + Number(m[2]);
}
