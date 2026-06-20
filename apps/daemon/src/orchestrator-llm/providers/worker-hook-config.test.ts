import { describe, it, expect } from "vitest";
import { resolveShadowProvider } from "./registry.js";

const RESOLVER = ["node", "test-daemon.js"];

describe("workerHookConfig", () => {
  it("Claude returns a settings.json file (with PermissionRequest) and a --settings spawn arg", () => {
    const provider = resolveShadowProvider("claude-code");
    const cfg = provider.workerHookConfig({ goalId: "g1", sessionId: "s1", resolverCommand: RESOLVER, configDir: "/tmp/cfg" });
    const settings = cfg.files.find((f) => f.relPath === "settings.json");
    expect(settings).toBeDefined();
    expect(settings!.contents).toContain("PermissionRequest");
    expect(cfg.spawnArgs).toEqual(["--settings", "/tmp/cfg/settings.json"]);
  });

  it("Codex returns config.toml + hooks.json (Stop/StopFailure + PermissionRequest) and CODEX_HOME env", () => {
    const provider = resolveShadowProvider("codex");
    const cfg = provider.workerHookConfig({ goalId: "g1", sessionId: "s1", resolverCommand: RESOLVER, configDir: "/tmp/cfg" });

    // CODEX_HOME discovery: files live at the root of the config dir (CODEX_HOME).
    const relPaths = cfg.files.map((f) => f.relPath).sort();
    expect(relPaths).toEqual(["config.toml", "hooks.json"]);

    const configToml = cfg.files.find((f) => f.relPath === "config.toml");
    expect(configToml!.contents).toContain("[features]");
    expect(configToml!.contents).toContain("hooks = true");

    const hooks = cfg.files.find((f) => f.relPath === "hooks.json");
    const parsed = JSON.parse(hooks!.contents) as {
      hooks: {
        Stop: Array<{ hooks: Array<{ command: string }> }>;
        StopFailure: Array<{ hooks: Array<{ command: string }> }>;
        PermissionRequest: Array<{ hooks: Array<{ command: string; timeout?: number }> }>;
      };
    };
    expect(parsed.hooks.Stop).toBeDefined();
    expect(parsed.hooks.StopFailure).toBeDefined();

    // Stop/StopFailure use the resolver command (not curl).
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toContain("test-daemon.js");
    expect(parsed.hooks.StopFailure[0]!.hooks[0]!.command).toContain("test-daemon.js");

    const permCommand = parsed.hooks.PermissionRequest[0]!.hooks[0]!.command;
    // PermissionRequest must contain the permission route scoped to this session.
    expect(permCommand).toContain("permission?sessionId=s1");
    // Codex omits tool_use_id; the hook must inject a real correlation id.
    expect(permCommand).toContain("tool_use_id");
    expect(permCommand).toContain("session_id");
    expect(permCommand).toContain("turn_id");
    // The id also digests tool_name + tool_input.
    expect(permCommand).toContain("createHash");
    expect(permCommand).toContain("tool_name");
    expect(permCommand).toContain("tool_input");
    // Parity with Claude's PermissionRequest hook.
    expect(parsed.hooks.PermissionRequest[0]!.hooks[0]!.timeout).toBe(1800);

    // CODEX_HOME points discovery at the private config dir.
    expect(cfg.env).toEqual({ CODEX_HOME: "/tmp/cfg" });

    // Redirecting CODEX_HOME relocates Codex's credentials lookup.
    const auth = cfg.copyFiles?.find((f) => f.relPath === "auth.json");
    expect(auth).toBeDefined();
    expect(auth!.sourcePath).toMatch(/[/\\]\.codex[/\\]auth\.json$/);

    // The unattended worker must bypass interactive hook-trust review.
    expect(cfg.spawnArgs).toContain("--dangerously-bypass-hook-trust");
  });

  it("Antigravity returns an empty worker config (no permission flow yet)", () => {
    const cfg = resolveShadowProvider("antigravity").workerHookConfig({ goalId: "g", sessionId: "s", resolverCommand: RESOLVER, configDir: "/tmp" });
    expect(cfg.files).toEqual([]);
    expect(cfg.spawnArgs).toEqual([]);
  });
});
