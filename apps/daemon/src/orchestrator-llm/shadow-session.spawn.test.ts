import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePtyManager } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function deps(root: string, ready = true) {
  return {
    ptyManager: new FakePtyManager(),
    shadowRoot: root,
    daemonPort: 8787,
    isReady: async () => ready,
    resolveSpawnCommand: (cwd: string) => ({ command: "claude", args: [], env: {}, cwd }),
  };
}

describe("ShadowSessionManager spawn integration", () => {
  it("writes .claude/settings.local.json with the hook URL into the goal dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const m = new ShadowSessionManager(deps(root));
    await m.spawn("G1");
    const p = join(root, "G1", ".claude", "settings.local.json");
    expect(existsSync(p)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.hooks.Stop[0].hooks[0].url).toContain("goalId=G1");
    expect(cfg.hooks.StopFailure[0].hooks[0].url).toContain("failure=1");
  });

  it("readiness gate: spawn rejects when not ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const m = new ShadowSessionManager(deps(root, false));
    await expect(m.spawn("G1")).rejects.toThrow(/not ready|sign in/i);
  });

  it("uses the current daemonPort after setDaemonPort", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const m = new ShadowSessionManager(deps(root));
    m.setDaemonPort(41234);
    await m.spawn("G2");
    const cfg = JSON.parse(readFileSync(join(root, "G2", ".claude", "settings.local.json"), "utf8"));
    expect(cfg.hooks.Stop[0].hooks[0].url).toContain(":41234/");
  });
});
