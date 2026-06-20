import { describe, it, expect } from "vitest";
import { buildShadowHookSettings } from "./shadow-hook-settings.js";

describe("buildShadowHookSettings", () => {
  const settings = buildShadowHookSettings({
    goalId: "g1",
    resolverCommand: ["/abs/orca-daemon"],
  });

  it("emits command hooks (no http url, no token)", () => {
    const json = JSON.stringify(settings);
    expect(json).not.toContain("http://");
    expect(json).not.toContain("Bearer");
    expect(settings.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  it("stop hook targets the shadow-hooks stop relUrl and is spoolable", () => {
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("hook");
    expect(cmd).toContain("/v1/shadow-hooks/stop?goalId=g1");
    expect(cmd).toContain("--spool");
  });

  it("StopFailure hook appends failure=1 and is spoolable", () => {
    const cmd = settings.hooks.StopFailure[0].hooks[0].command;
    expect(cmd).toContain("/v1/shadow-hooks/stop?goalId=g1&failure=1");
    expect(cmd).toContain("--spool");
  });

  it("shell-quotes resolver args with spaces", () => {
    const s = buildShadowHookSettings({ goalId: "g1", resolverCommand: ["/abs path/orca-daemon"] });
    expect(s.hooks.Stop[0].hooks[0].command).toContain("'/abs path/orca-daemon'");
  });
});
