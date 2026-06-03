import { describe, expect, it } from "vitest";
import { AntigravityShadowProvider } from "./antigravity.js";

describe("AntigravityShadowProvider", () => {
  it("launches agy or override", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.launch({}).bin).toBe("agy");
    expect(provider.launch({ binOverride: "/bin/agy" }).bin).toBe("/bin/agy");
  });

  it("uses hook capture", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.captureMode()).toEqual({ kind: "hook" });
  });

  it("writes hooks.json and relay script under .agents", () => {
    const provider = new AntigravityShadowProvider();
    const cfg = provider.hookConfig({ goalId: "g1", port: 17333, authToken: "tok" });
    expect(cfg.files.map((f) => f.relPath).sort()).toEqual([
      ".agents/hooks.json",
      ".agents/orca-stop-hook.cjs",
    ]);
    const hooks = JSON.parse(cfg.files.find((f) => f.relPath === ".agents/hooks.json")!.contents);
    expect(hooks["orca-shadow-stop"].Stop[0].command).toBe("node .agents/orca-stop-hook.cjs");
    expect(cfg.files.find((f) => f.relPath === ".agents/orca-stop-hook.cjs")!.contents).toContain("transcriptPath");
  });

  it("parses orca action blocks", () => {
    const provider = new AntigravityShadowProvider();
    const parsed = provider.turnParser().parseAction('done\n<orca:action>{"kind":"wait"}</orca:action>');
    expect(parsed).toBe('{"kind":"wait"}');
  });
});
