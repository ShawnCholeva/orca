import type { CostEntry } from "@orca/contracts";

// Static USD-per-1K-token price map (updated by edit; see spec D4). Prefix match on model id.
// Values are illustrative current list prices; adjust as pricing changes.
const PRICE_PER_1K: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: "claude-opus", in: 0.015, out: 0.075 },
  { prefix: "claude-sonnet", in: 0.003, out: 0.015 },
  { prefix: "claude-haiku", in: 0.0008, out: 0.004 },
  { prefix: "gpt-5", in: 0.00125, out: 0.01 },
  { prefix: "o3", in: 0.002, out: 0.008 },
  { prefix: "gpt-4o", in: 0.0025, out: 0.01 },
];

function priceFor(model: string): { in: number; out: number } | undefined {
  return PRICE_PER_1K.find((p) => model.startsWith(p.prefix));
}

export function isPricedModel(model: string): boolean {
  return priceFor(model) !== undefined;
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): CostEntry {
  const p = priceFor(model);
  const usd = p ? (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out : 0;
  // Price-map estimate does not price cache; leave the additive cache fields null.
  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    usd,
  };
}
