import { describe, expect, it } from "vitest";
import { SEED_PROFILES } from "./profiles.js";
import { resolveChoice } from "./resolve-choice.js";
import type { CatalogModel } from "./types.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-fable-5-1", family: "fable", displayName: "Fable 5.1", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_10_50", advisorRank: 5,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

describe("resolveChoice — pinned", () => {
  it("fills a null effort from the model's catalog default", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got).toEqual({
      adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high",
    });
  });

  it("keeps an explicitly authored effort", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "max" },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.effort).toBe("max");
  });

  it("downgrades an effort the model does not support to its default", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "default", effort: "max" },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.effort).toBe("medium");
  });

  it("drops a 1m variant the model does not accept, rather than emitting an illegal id", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "1m", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.contextVariant).toBe("default");
  });

  it("returns null for a model absent from the catalog", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got).toBeNull();
  });

  it("never leaves effort unset for a model that supports efforts but declares no default", () => {
    const noDefault: CatalogModel = {
      id: "claude-sonnet-4-6", family: "sonnet", displayName: "Sonnet 4.6",
      contextWindow: 200_000, supports1mSuffix: true, pricingTier: "tier_3_15", advisorRank: 2,
      supportedEfforts: ["low", "medium", "high", "xhigh"], defaultEffort: null,
    };
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-sonnet-4-6", contextVariant: "default", effort: null },
      [noDefault], "claude-code", SEED_PROFILES,
    );
    expect(got?.effort).toBe("high");
  });
});

describe("resolveChoice — profile", () => {
  it("picks the cheapest model meeting a light profile", () => {
    const got = resolveChoice({ kind: "profile", ref: "light" }, CATALOG, "claude-code", SEED_PROFILES);
    expect(got?.modelId).toBe("claude-haiku-4-5");
  });

  it("picks the strongest model for a deep-reasoning profile", () => {
    const got = resolveChoice({ kind: "profile", ref: "reasoning" }, CATALOG, "claude-code", SEED_PROFILES);
    expect(got?.modelId).toBe("claude-fable-5-1");
  });

  it("honours a profile's minimum context window", () => {
    const profiles = [{ id: "long", displayName: "Long", requires: { minContextWindow: 1_000_000 }, rank: "cheapest" as const }];
    const got = resolveChoice({ kind: "profile", ref: "long" }, CATALOG, "claude-code", profiles);
    expect(got?.modelId).toBe("claude-opus-5");
  });

  it("excludes a model whose pricing tier is unparseable from a budget-bounded profile", () => {
    const catalog = [{ ...CATALOG[2], id: "mystery", pricingTier: null }];
    const profiles = [{ id: "cheap", displayName: "Cheap", requires: { maxPricingTier: "tier_5_25" }, rank: "cheapest" as const }];
    expect(resolveChoice({ kind: "profile", ref: "cheap" }, catalog, "claude-code", profiles)).toBeNull();
  });

  it("returns null for an unknown profile rather than guessing a model", () => {
    expect(resolveChoice({ kind: "profile", ref: "nope" }, CATALOG, "claude-code", SEED_PROFILES)).toBeNull();
  });

  it("takes the profile's preferred effort when the model supports it", () => {
    const profiles = [{ id: "hard", displayName: "Hard", requires: {}, preferredEffort: "xhigh" as const, rank: "strongest" as const }];
    const got = resolveChoice({ kind: "profile", ref: "hard" }, CATALOG, "claude-code", profiles);
    expect(got?.effort).toBe("xhigh");
  });
});

describe("resolveChoice — an adapter with no effort axis", () => {
  it("leaves effort null when the model declares no supported efforts", () => {
    const catalog: CatalogModel[] = [{
      id: "gemini-3.5-flash", family: "gemini", displayName: "Gemini 3.5 Flash", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null, supportedEfforts: [], defaultEffort: null,
    }];
    const got = resolveChoice(
      { kind: "pinned", adapterId: "antigravity", modelId: "gemini-3.5-flash", contextVariant: "default", effort: null },
      catalog, "antigravity", SEED_PROFILES,
    );
    expect(got?.effort).toBeNull();
  });
});
