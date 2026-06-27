import { describe, expect, it } from "vitest";
import { computeCost, isPricedModel } from "./cost.js";

describe("computeCost", () => {
  it("prices a known model from the static map", () => {
    const c = computeCost("claude-opus-4-8", 1_000_000, 1_000_000);
    expect(c.tokens_in).toBe(1_000_000);
    expect(c.tokens_out).toBe(1_000_000);
    expect(c.usd).toBeGreaterThan(0);
  });
  it("preserves tokens but yields usd 0 for an unknown model", () => {
    const c = computeCost("totally-unknown-model", 500, 500);
    expect(c.usd).toBe(0);
    expect(c.tokens_in).toBe(500);
    expect(isPricedModel("totally-unknown-model")).toBe(false);
  });
  it("is linear in tokens", () => {
    const a = computeCost("claude-opus-4-8", 100, 0);
    const b = computeCost("claude-opus-4-8", 200, 0);
    expect(b.usd).toBeCloseTo(a.usd * 2, 9);
  });

  it("clamps negative token counts to zero (CostEntry requires non-negative)", () => {
    const c = computeCost("claude-opus-4-8", -100, -50);
    expect(c.tokens_in).toBe(0);
    expect(c.tokens_out).toBe(0);
    expect(c.usd).toBe(0);
  });

  it("prices via the first matching prefix (array order wins on overlap)", () => {
    // gpt-5-codex has no entry of its own; it must price through the gpt-5 prefix,
    // not fall through to gpt-4o (which is registered later and is more expensive).
    const c = computeCost("gpt-5-codex", 1000, 0);
    expect(c.usd).toBeCloseTo(0.00125, 9);
  });
});
