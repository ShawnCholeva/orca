import { describe, it, expect } from "vitest";
import { resolveShadowProvider } from "./registry.js";

describe("workerHookConfig", () => {
  it("Claude returns a settings.json file (with PermissionRequest) and a --settings spawn arg", () => {
    const provider = resolveShadowProvider("claude-code");
    const cfg = provider.workerHookConfig({ goalId: "g1", sessionId: "s1", port: 1234, authToken: "tok", configDir: "/tmp/cfg" });
    const settings = cfg.files.find((f) => f.relPath === "settings.json");
    expect(settings).toBeDefined();
    expect(settings!.contents).toContain("PermissionRequest");
    expect(cfg.spawnArgs).toEqual(["--settings", "/tmp/cfg/settings.json"]);
  });

  it("Codex and Antigravity return an empty worker config (no permission flow yet)", () => {
    for (const id of ["codex", "antigravity"] as const) {
      const cfg = resolveShadowProvider(id).workerHookConfig({ goalId: "g", sessionId: "s", port: 1, authToken: "t", configDir: "/tmp" });
      expect(cfg.files).toEqual([]);
      expect(cfg.spawnArgs).toEqual([]);
    }
  });
});
