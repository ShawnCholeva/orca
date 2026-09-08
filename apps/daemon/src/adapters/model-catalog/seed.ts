import type { AdapterId } from "@orca/contracts";
import type { CatalogModel } from "./types.js";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Last-resort fallback when extraction fails and no cache exists. Deliberately
 * small: this is a floor that keeps dispatch working, not a catalog to maintain.
 * The extractor (Task 4) supersedes it whenever the CLI is readable.
 */
export const SEED_CATALOG: Record<AdapterId, CatalogModel[]> = {
  "claude-code": [
    { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
      supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
      supportedEfforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
    { id: "claude-sonnet-5", family: "sonnet", displayName: "Sonnet 5", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: "tier_2_10", advisorRank: 3,
      supportedEfforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
    { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
      supports1mSuffix: true, pricingTier: "haiku_45", advisorRank: 1,
      supportedEfforts: [], defaultEffort: null },
  ],
  codex: [
    { id: "gpt-5.5", family: "gpt-5", displayName: "GPT-5.5", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gpt-5.3-codex", family: "gpt-5-codex", displayName: "GPT-5.3 Codex", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gpt-5.4-mini", family: "gpt-5-mini", displayName: "GPT-5.4 mini", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
  ],
  antigravity: [
    { id: "gemini-3.5-flash", family: "gemini", displayName: "Gemini 3.5 Flash", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gemini-3.1-pro-high", family: "gemini", displayName: "Gemini 3.1 Pro (high)", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
  ],
};
