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

  // Verbatim pane from `claude` in a fresh shadow dir. The highlight (❯) sits on
  // "No, exit" — a bare Enter here QUITS the agent.
  const TRUST_PANE = [
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    " own code, a well-known open source project, or work from your team).",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  // Same menu after the highlight has moved onto the affirmative row.
  const TRUST_PANE_ON_YES = TRUST_PANE.replace(" ❯ No, exit", "   No, exit").replace(
    "   Yes, I trust this folder",
    " ❯ Yes, I trust this folder",
  );

  it("startup moves the highlight onto 'Yes, I trust' before pressing Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux([TRUST_PANE, TRUST_PANE_ON_YES, "❯ \n auto mode on"]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G4");
    await new Promise((r) => setTimeout(r, 40));

    const keys = tmux.calls.filter((c) => c.args[0] === "send-keys");
    const down = keys.findIndex((c) => c.args.includes("Down"));
    const enter = keys.findIndex((c) => c.args.includes("Enter"));
    // It must step onto the affirmative row FIRST — confirming the default
    // selects "No, exit" and kills the shadow orchestrator.
    expect(down).toBeGreaterThanOrEqual(0);
    expect(enter).toBeGreaterThan(down);
  });

  it("never presses Enter while the highlight is still on the exit option", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // The TUI has not attached its input handler yet, so the first Down presses
    // are swallowed and the highlight stays put. This is the real failure mode:
    // an Enter here quits the agent.
    const tmux = fakeTmux([TRUST_PANE]);
    const m = new ShadowSessionManager({ ...deps(root, tmux), startupTimeoutMs: 60 });
    await m.spawn("G4d");
    await new Promise((r) => setTimeout(r, 120));

    const keys = tmux.calls.filter((c) => c.args[0] === "send-keys");
    // It keeps retrying the move (self-correcting for the dropped keys)…
    expect(keys.filter((c) => c.args.includes("Down")).length).toBeGreaterThan(1);
    // …and never confirms, because the highlight never landed on "Yes".
    expect(keys.filter((c) => c.args.includes("Enter"))).toHaveLength(0);
  });

  it("does not confirm the trust prompt before its options have painted", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // The question text is on screen but the menu rows are not rendered yet.
    // Guessing here is what kills the session, so it must keep polling instead.
    const tmux = fakeTmux(["Is this a project you created or one you trust?"]);
    const m = new ShadowSessionManager({ ...deps(root, tmux), startupTimeoutMs: 40 });
    await m.spawn("G4b");
    await new Promise((r) => setTimeout(r, 80));
    expect(tmux.calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("fails fast with an accurate reason when the agent exits during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // A dead tmux session: capture-pane yields nothing and has-session is nonzero.
    const tmux = {
      calls: [] as Array<{ args: string[]; input?: string }>,
      run: async (args: string[]) => {
        if (args[0] === "capture-pane") return { stdout: "", stderr: "", code: 1 };
        if (args[0] === "has-session") return { stdout: "", stderr: "", code: 1 };
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const m = new ShadowSessionManager({ ...deps(root, tmux), startupTimeoutMs: 5000 });
    await m.spawn("G4c");
    const started = Date.now();
    await expect(
      m.ask("G4c", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 }),
    ).rejects.toThrow(/exited during startup/i);
    // Diagnosis must not cost the full startup budget.
    expect(Date.now() - started).toBeLessThan(2000);
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
