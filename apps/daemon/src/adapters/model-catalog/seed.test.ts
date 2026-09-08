import { describe, expect, it } from "vitest";
import { SEED_CATALOG } from "./seed.js";
import { pricingRank } from "./types.js";

describe("pricingRank", () => {
  it("orders a cheaper tier below a dearer one", () => {
    expect(pricingRank("tier_5_25")).toBeLessThan(pricingRank("tier_10_50"));
  });

  it("breaks a tie on input price using the output price", () => {
    expect(pricingRank("tier_5_25")).toBeLessThan(pricingRank("tier_5_40"));
  });

  it("sorts an unparseable tier last rather than assuming it is cheap", () => {
    expect(pricingRank("mystery")).toBeGreaterThan(pricingRank("tier_10_50"));
  });

  it("ranks a suffixed tier by its base rates", () => {
    expect(pricingRank("tier_10_50_cache_read_0_25")).toBe(pricingRank("tier_10_50"));
  });
});

describe("SEED_CATALOG", () => {
  it("carries every adapter", () => {
    expect(Object.keys(SEED_CATALOG).sort()).toEqual(["antigravity", "claude-code", "codex"]);
  });

  it("marks a claude model that accepts the 1m suffix", () => {
    const opus = SEED_CATALOG["claude-code"].find((m) => m.id === "claude-opus-5");
    expect(opus?.supports1mSuffix).toBe(true);
    expect(opus?.contextWindow).toBe(1_000_000);
  });

  it("gives a model with an effort capability a default effort", () => {
    const opus = SEED_CATALOG["claude-code"].find((m) => m.id === "claude-opus-5");
    expect(opus?.defaultEffort).toBe("high");
    expect(opus?.supportedEfforts).toHaveLength(5);
  });

  it("gives a model without an effort capability no efforts and no default", () => {
    const haiku = SEED_CATALOG["claude-code"].find((m) => m.id === "claude-haiku-4-5");
    expect(haiku?.supportedEfforts).toEqual([]);
    expect(haiku?.defaultEffort).toBeNull();
  });

  it("gives codex and antigravity models no supported efforts in v1", () => {
    for (const model of [...SEED_CATALOG.codex, ...SEED_CATALOG.antigravity]) {
      expect(model.supportedEfforts).toEqual([]);
    }
  });
});
