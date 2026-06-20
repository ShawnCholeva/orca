import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowSessionManager } from "./shadow-session.js";

function fakeTmux(paneScript: string[] = ["❯ \n auto mode on"]) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let paneIdx = 0;
  const runner = {
    calls,
    run: async (args: string[], input?: string) => {
      calls.push({ args, input });
      if (args[0] === "capture-pane") {
        const out = paneScript[Math.min(paneIdx, paneScript.length - 1)];
        paneIdx++;
        return { stdout: out ?? "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  return runner;
}

function deps(root: string, tmux: ReturnType<typeof fakeTmux>, ready = true) {
  return {
    shadowRoot: root,
    daemonPort: 8787,
    authToken: "test-token",
    hookResolverCommand: ["node", "test-daemon.js"],
    isReady: async () => ready,
    tmux,
    pollMs: 1,
    readyQuietMs: 1,
    startupTimeoutMs: 200,
  };
}

describe("ShadowSessionManager spawn integration", () => {
  it("writes .claude/settings.local.json with the hook command into the goal dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p = join(root, "G1", ".claude", "settings.local.json");
    expect(existsSync(p)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.hooks.Stop[0].hooks[0].command).toContain("goalId=G1");
    expect(cfg.hooks.StopFailure[0].hooks[0].command).toContain("failure=1");
  });

  it("writes Codex project-local hook config when spawning a codex shadow session", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1", "codex");
    const configPath = join(root, "G1", ".codex", "config.toml");
    const hooksPath = join(root, "G1", ".codex", "hooks.json");
    expect(readFileSync(configPath, "utf8")).toContain("hooks = true");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain("goalId=G1");
    expect(hooks.hooks.StopFailure[0].hooks[0].command).toContain("failure=1");
    // Stop/StopFailure now use the resolver command (not curl), so no /dev/null.
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain("test-daemon.js");
    expect(hooks.hooks.StopFailure[0].hooks[0].command).toContain("test-daemon.js");
  });

  it("uses the codex binary when spawning a codex shadow session", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager({ ...deps(root, tmux), codexBin: "/bin/codex-test" });
    await m.spawn("G3", "codex");
    const newSession = tmux.calls.find((c) => c.args[0] === "new-session");
    // The command is the last new-session arg: the bin plus the hook-trust bypass flag
    // (so the daemon-authored hooks fire without the interactive trust menu).
    const command = newSession!.args[newSession!.args.length - 1];
    expect(command).toContain("/bin/codex-test");
    expect(command).toContain("--dangerously-bypass-hook-trust");
  });

  it("readiness gate: spawn rejects when not ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux, false));
    await expect(m.spawn("G1")).rejects.toThrow(/not ready|sign in/i);
  });

  it("uses the current daemonPort after setDaemonPort (hook commands use resolver, not port)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    m.setDaemonPort(41234);
    await m.spawn("G2");
    const cfg = JSON.parse(readFileSync(join(root, "G2", ".claude", "settings.local.json"), "utf8"));
    // Hook commands now use the resolver command, not an HTTP URL with port.
    expect(cfg.hooks.Stop[0].hooks[0].command).toContain("goalId=G2");
  });

  it("issues a new-session tmux call with the goal dir as cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G3");
    const newSession = tmux.calls.find((c) => c.args[0] === "new-session");
    expect(newSession).toBeDefined();
    // The goal dir should appear in the new-session args
    const goalDir = join(root, "G3");
    expect(newSession!.args.join(" ")).toContain(goalDir);
  });

  it("startup answers the trust prompt with Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // First capture-pane returns trust prompt; subsequent ones return ready state
    const tmux = fakeTmux(["trust this folder", "❯ \n auto mode on"]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G4");
    // Wait for startup to complete (readyQuietMs=1)
    await new Promise((r) => setTimeout(r, 20));
    const sendKeys = tmux.calls.filter((c) => c.args[0] === "send-keys" && c.args.includes("Enter"));
    // Should have sent Enter to answer the trust prompt
    expect(sendKeys.length).toBeGreaterThanOrEqual(1);
  });

  it("startup trusts Codex project hooks with t before reporting ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux(["1 hook needs review before it can run. Press t to trust", "codex ready\n>"]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G5", "codex");
    await new Promise((r) => setTimeout(r, 300));
    const trust = tmux.calls.find((c) => c.args[0] === "send-keys" && c.args.includes("t"));
    expect(trust).toBeDefined();
    const escapes = tmux.calls.filter((c) => c.args[0] === "send-keys" && c.args.includes("Escape"));
    expect(escapes.length).toBeGreaterThanOrEqual(2);
  });
});
