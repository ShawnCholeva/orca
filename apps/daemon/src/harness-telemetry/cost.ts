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
  // Clamp: token counts can arrive negative from a bad delta or malformed OTLP
  // row, and CostEntry requires non-negative — an unclamped value throws at
  // persistence (HarnessTransition.parse) or yields a nonsensical negative USD.
  const inTok = Math.max(0, tokensIn);
  const outTok = Math.max(0, tokensOut);
  const p = priceFor(model);
  const usd = p ? (inTok / 1000) * p.in + (outTok / 1000) * p.out : 0;
  // Price-map estimate does not price cache; leave the additive cache fields null.
  return {
    tokens_in: inTok,
    tokens_out: outTok,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    usd,
  };
}
