import { describe, it, expect } from "vitest";
import { buildShadowHookSettings, shadowHookUrl } from "./shadow-hook-settings.js";

describe("shadow hook settings", () => {
  it("builds a Stop + StopFailure http hook config with goalId and port in the URL", () => {
    const cfg = buildShadowHookSettings({ goalId: "G1", port: 8787 });
    const stopUrl = cfg.hooks.Stop[0].hooks[0].url as string;
    const failUrl = cfg.hooks.StopFailure[0].hooks[0].url as string;
    expect(cfg.hooks.Stop[0].hooks[0].type).toBe("http");
    expect(stopUrl).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=G1");
    expect(failUrl).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=G1&failure=1");
  });

  it("shadowHookUrl encodes the goalId", () => {
    expect(shadowHookUrl(8787, "a/b")).toBe("http://127.0.0.1:8787/v1/orchestrator-hooks/stop?goalId=a%2Fb");
  });
});
