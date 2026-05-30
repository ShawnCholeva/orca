import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
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
    isReady: async () => ready,
    tmux,
    pollMs: 1,
    readyQuietMs: 1,
    startupTimeoutMs: 200,
  };
}

describe("ShadowSessionManager spawn", () => {
  it("spawns one tmux session per goal and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    const a = await m.spawn("G1");
    const b = await m.spawn("G1");
    expect(a).toBe(b);
    // new-session should only be called once (idempotent)
    const newSessions = tmux.calls.filter((c) => c.args[0] === "new-session");
    expect(newSessions.length).toBe(1);
  });

  it("has() reflects lifecycle; terminate kills the tmux session", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    expect(m.has("G1")).toBe(true);
    await m.terminate("G1");
    expect(m.has("G1")).toBe(false);
    const kills = tmux.calls.filter((c) => c.args[0] === "kill-session");
    // kill-session called during spawn (idempotent pre-kill) and during terminate
    expect(kills.length).toBeGreaterThanOrEqual(1);
  });
});
