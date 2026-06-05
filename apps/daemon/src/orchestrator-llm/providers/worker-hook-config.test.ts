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

  it("Codex returns config.toml + hooks.json (Stop/StopFailure + PermissionRequest) and CODEX_HOME env", () => {
    const provider = resolveShadowProvider("codex");
    const cfg = provider.workerHookConfig({ goalId: "g1", sessionId: "s1", port: 1234, authToken: "tok", configDir: "/tmp/cfg" });

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

    // Stop/StopFailure discard the daemon response (Codex errors on non-empty
    // stop-hook stdout); capture still happens from the POSTed body.
    expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toContain("/dev/null");
    expect(parsed.hooks.StopFailure[0]!.hooks[0]!.command).toContain("/dev/null");

    const permCommand = parsed.hooks.PermissionRequest[0]!.hooks[0]!.command;
    // PermissionRequest must NOT discard stdout — it emits the allow/deny decision.
    expect(permCommand).not.toContain("/dev/null");
    // Targets the shared permission route, scoped to this session, with the bearer token.
    expect(permCommand).toContain("permission?sessionId=s1");
    expect(permCommand).toContain("tok");
    // Codex omits tool_use_id; the hook must inject a real correlation id so the
    // per-toolUseId dedup store does not collide across concurrent Codex sessions.
    expect(permCommand).toContain("tool_use_id");
    expect(permCommand).toContain("session_id");
    expect(permCommand).toContain("turn_id");
    // The id also digests tool_name + tool_input so two distinct tool calls in the
    // same turn get distinct ids (safe-by-default), while a genuine retry still dedups.
    expect(permCommand).toContain("createHash");
    expect(permCommand).toContain("tool_name");
    expect(permCommand).toContain("tool_input");
    // Parity with Claude's PermissionRequest hook: an explicit timeout so the turn
    // doesn't fall back to Codex's default while it blocks awaiting the daemon decision.
    expect(parsed.hooks.PermissionRequest[0]!.hooks[0]!.timeout).toBe(1800);

    // CODEX_HOME points discovery at the private config dir.
    expect(cfg.env).toEqual({ CODEX_HOME: "/tmp/cfg" });

    // Redirecting CODEX_HOME relocates Codex's credentials lookup, so the real
    // auth.json must be copied in or the worker stalls on the sign-in screen.
    const auth = cfg.copyFiles?.find((f) => f.relPath === "auth.json");
    expect(auth).toBeDefined();
    expect(auth!.sourcePath).toMatch(/[/\\]\.codex[/\\]auth\.json$/);

    // The unattended worker must bypass interactive hook-trust review or the
    // daemon-authored hooks never fire.
    expect(cfg.spawnArgs).toContain("--dangerously-bypass-hook-trust");
  });

  it("Antigravity returns an empty worker config (no permission flow yet)", () => {
    const cfg = resolveShadowProvider("antigravity").workerHookConfig({ goalId: "g", sessionId: "s", port: 1, authToken: "t", configDir: "/tmp" });
    expect(cfg.files).toEqual([]);
    expect(cfg.spawnArgs).toEqual([]);
  });
});
