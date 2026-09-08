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

  it("gives every claude model a default effort, since the adapter has an effort axis", () => {
    for (const model of SEED_CATALOG["claude-code"]) {
      expect(model.defaultEffort).not.toBeNull();
    }
  });

  it("gives codex and antigravity models no supported efforts in v1", () => {
    for (const model of [...SEED_CATALOG.codex, ...SEED_CATALOG.antigravity]) {
      expect(model.supportedEfforts).toEqual([]);
    }
  });
});
