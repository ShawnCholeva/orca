import { describe, expect, it } from "vitest";
import type { StepAgentChoice } from "@orca/contracts";
import { PROVIDER_BY_AGENT_ID, SEED_CATALOG } from "./seed.js";
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

describe("PROVIDER_BY_AGENT_ID", () => {
  it("maps Antigravity to Google provider metadata", () => {
    expect(PROVIDER_BY_AGENT_ID.antigravity).toBe("orca/google");
  });
});

describe("SEED_CATALOG", () => {
  it("carries every adapter", () => {
    expect(Object.keys(SEED_CATALOG).sort()).toEqual(["antigravity", "claude-code", "codex"]);
  });

  it("gives antigravity at least one model", () => {
    expect(SEED_CATALOG.antigravity.length).toBeGreaterThan(0);
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

  /**
   * The seed is the floor that keeps dispatch working when extraction fails.
   * Membership in the catalog is what makes a preference dispatchable, so a
   * built-in template pinning a model the seed omits reroutes every one of its
   * steps to another adapter — or blocks the run — the moment extraction fails.
   * The tier constants and the seed must be edited together; this is the
   * falsifier for that.
   */
  it("seeds every claude-code model the built-in templates pin", async () => {
    const { BUILTIN_TEMPLATE_CATALOG } = await import("../../workflows/templates/catalog.js");
    const seeded = new Set(SEED_CATALOG["claude-code"].map((m) => m.id));
    const pinned = new Set<string>();
    const collect = (prefs: readonly StepAgentChoice[] | undefined) => {
      for (const pref of prefs ?? []) {
        if (pref.kind === "pinned" && pref.adapterId === "claude-code") pinned.add(pref.modelId);
      }
    };
    for (const tpl of BUILTIN_TEMPLATE_CATALOG) {
      for (const step of tpl.steps) collect(step.agentPreference);
      // Gates carry their own agentPreference (the strong-critic lever).
      for (const node of tpl.graph?.nodes ?? []) {
        collect((node as { agentPreference?: StepAgentChoice[] }).agentPreference);
      }
    }
    expect(pinned.size).toBeGreaterThan(0);
    expect([...pinned].filter((id) => !seeded.has(id))).toEqual([]);
  });

  it("gives codex and antigravity models no supported efforts in v1", () => {
    for (const model of [...SEED_CATALOG.codex, ...SEED_CATALOG.antigravity]) {
      expect(model.supportedEfforts).toEqual([]);
    }
  });
});
