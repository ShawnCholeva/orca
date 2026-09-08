import { describe, expect, it } from "vitest";
import { SEED_PROFILES } from "../../adapters/model-catalog/profiles.js";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";
import { resolveStepDispatch } from "./step-dispatch.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

const base = {
  isAdapterReady: async () => true,
  resolveMode: () => ({ adapterId: "claude-code", mode: "shadow_session" as const, fallbacks: [] }),
  catalogFor: async () => CATALOG,
  profiles: SEED_PROFILES,
};

describe("resolveStepDispatch", () => {
  it("returns a resolved choice with the effort filled from the catalog default", async () => {
    const got = await resolveStepDispatch({
      ...base,
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null }],
    });
    expect(got.adapterId).toBe("claude-code");
    expect(got.modelId).toBe("claude-opus-5");
    expect(got.executionMode).toBe("shadow_session");
    expect(got.model).toEqual({
      adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high",
    });
  });

  it("resolves a profile preference against the catalog", async () => {
    const got = await resolveStepDispatch({
      ...base,
      adapterOrder: ["claude-code"],
      preferences: [{ kind: "profile", ref: "light" }],
    });
    expect(got.model.modelId).toBe("claude-haiku-4-5");
  });

  it("skips a preference whose model is absent from the catalog and takes the next", async () => {
    const got = await resolveStepDispatch({
      ...base,
      preferences: [
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null },
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "default", effort: null },
      ],
    });
    expect(got.model.modelId).toBe("claude-haiku-4-5");
  });

  it("throws rather than falling through to the ambient default when nothing resolves", async () => {
    await expect(resolveStepDispatch({
      ...base,
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null }],
    })).rejects.toThrow(/no ready agent/);
  });

  it("skips an adapter that is not ready", async () => {
    const got = await resolveStepDispatch({
      ...base,
      isAdapterReady: async (id: string) => id !== "codex",
      preferences: [
        { kind: "pinned", adapterId: "codex", modelId: "claude-opus-5", contextVariant: "default", effort: null },
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null },
      ],
    });
    expect(got.adapterId).toBe("claude-code");
  });
});
