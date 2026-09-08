import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../adapters/claude-code.js";
import { SEED_PROFILES } from "../../adapters/model-catalog/profiles.js";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";
import { dispatchModelString } from "./dispatch-engine.js";
import { resolveStepDispatch } from "./step-dispatch.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
];

/**
 * The function that produces the value written to `selected_model_id`
 * (`dispatchModelString`, called from dispatch-engine.ts's persistence paths)
 * and the function that builds the launched CLI's spawn args
 * (`ClaudeCodeAdapter.resolveSpawn` / `modelSpawnArgs`) must agree when fed the
 * same resolved choice. Before this existed, dispatch resolved a model, wrote
 * it to the database, and spawned a CLI that read ~/.claude/settings.json
 * instead — so every model-attributed measurement described a model that
 * never ran.
 */
describe("recorded model == launched model", () => {
  it("agrees for a pinned 1m choice at an explicit effort", async () => {
    const dispatch = await resolveStepDispatch({
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "1m", effort: "xhigh" }],
      isAdapterReady: async () => true,
      resolveMode: () => ({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] }),
      catalogFor: async () => CATALOG,
      profiles: SEED_PROFILES,
    });

    const recorded = dispatchModelString(dispatch.model);

    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: dispatch.model,
    });

    expect(spawn.args[spawn.args.indexOf("--model") + 1]).toBe(recorded);
    expect(spawn.args[spawn.args.indexOf("--effort") + 1]).toBe(dispatch.model.effort);
  });

  it("passes an effort even when the node authored none, so ambient settings cannot govern", async () => {
    const dispatch = await resolveStepDispatch({
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null }],
      isAdapterReady: async () => true,
      resolveMode: () => ({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] }),
      catalogFor: async () => CATALOG,
      profiles: SEED_PROFILES,
    });

    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: dispatch.model,
    });

    expect(spawn.args).toContain("--effort");
    expect(spawn.args[spawn.args.indexOf("--effort") + 1]).toBe("high");
  });
});
