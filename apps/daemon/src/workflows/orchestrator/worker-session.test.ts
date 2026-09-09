import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSessionManager, isPaneIdle } from "./worker-session.js";
import type { TmuxRunner } from "../../tmux/runner.js";
import { resolveAgentProvider } from "../../orchestrator-llm/providers/registry.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/providers/types.js";

// Wrap resolveAgentProvider to widen the parameter type from ShadowAdapterId to string,
// satisfying the WorkerSessionDeps.resolveProvider signature.
const resolveProvider = (adapterId: string) => resolveAgentProvider(adapterId as ShadowAdapterId);

function fakeTmux(paneByCall: string[] = []): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    run: vi.fn(async (args: string[]) => {
      calls.push(args);
      const stdout = args[0] === "capture-pane" ? (paneByCall[Math.min(i++, paneByCall.length - 1)] ?? "") : "";
      return { stdout, stderr: "", code: 0 };
    }),
  } as TmuxRunner & { calls: string[][] };
}

describe("WorkerSessionManager.isTmuxAlive", () => {
  it("reflects tmux has-session, not DB status", async () => {
    const base = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const deps = { privateRoot: base, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", captureSink: () => {}, resolveProvider };
    // tmux runner where has-session returns code 1 (dead) for one id, 0 (alive) otherwise.
    const aliveTmux: TmuxRunner = { run: async (args) => ({ stdout: "", stderr: "", code: args[0] === "has-session" ? 0 : 0 }) };
    const deadTmux: TmuxRunner = { run: async (args) => ({ stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0 }) };
    expect(await new WorkerSessionManager({ ...deps, tmux: aliveTmux }).isTmuxAlive("s1")).toBe(true);
    expect(await new WorkerSessionManager({ ...deps, tmux: deadTmux }).isTmuxAlive("s1")).toBe(false);
  });

  it("still reports alive when a session IN THE MAP has a live tmux session (spawn's own bookkeeping doesn't short-circuit the real check)", async () => {
    const tmux = fakeTmux(["auto mode on"]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.isTmuxAlive("sess-1")).toBe(true);
  });

  it("reports false — and evicts the stale map entry — when a session IN THE MAP has no live tmux session", async () => {
    // A worker the daemon spawned (so it's in the in-memory map) whose tmux
    // session died externally (crash / `tmux kill-session` / tmux server death)
    // while the daemon kept running. Before the fix, isTmuxAlive short-circuited
    // on `this.sessions.has()` and never asked tmux at all — this is the live
    // defect: the dead-worker reap could only ever fire for workers inherited
    // across a daemon restart (empty map).
    const calls: string[][] = [];
    const deadTmux: TmuxRunner & { calls: string[][] } = {
      calls,
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? "auto mode on" : "", stderr: "", code: args[0] === "has-session" ? 1 : 0 };
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux: deadTmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(deadTmux.calls.filter((c) => c[0] === "new-session")).toHaveLength(1);

    expect(await mgr.isTmuxAlive("sess-1")).toBe(false);

    // Proof of eviction: spawn() short-circuits on `this.sessions.has(sessionId)`
    // (unchanged). If the stale entry were NOT evicted, this second spawn would
    // be a silent no-op (no second new-session call) — respawning a worker whose
    // tmux session is dead would be impossible. It DOES respawn, so the entry
    // was evicted.
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(deadTmux.calls.filter((c) => c[0] === "new-session")).toHaveLength(2);
  });
});

describe("WorkerSessionManager.spawn", () => {
  it("writes hook settings to a private dir and starts tmux in the workspace with --settings", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: { HOME: "/home/u" } });
    // private settings written, NOT under /repo
    expect(existsSync(join(privateRoot, "sess-1", "settings.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(privateRoot, "sess-1", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("sessionId=sess-1");
    // new-session used the workspace cwd and layered hooks via --settings (NOT CLAUDE_CONFIG_DIR)
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    expect(newSess).toContain("/repo");
    expect(newSess.join(" ")).toContain("--settings");
    expect(newSess.join(" ")).toContain(join(privateRoot, "sess-1", "settings.json"));
    expect(newSess.join(" ")).not.toContain("CLAUDE_CONFIG_DIR");
    // output pipe established
    expect(tmux.calls.some((c) => c[0] === "pipe-pane")).toBe(true);
  });

  it("uses provider workerHookConfig to write files and form spawn args", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const fakeProvider = {
      workerHookConfig: (args: { goalId: string; sessionId: string; resolverCommand: string[]; configDir: string }) => ({
        files: [{ relPath: "settings.json", contents: '{"hooks":{}}' }],
        spawnArgs: ["--settings", join(args.configDir, "settings.json")],
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
      resolveProvider: (_adapterId) => fakeProvider,
    });
    await mgr.spawn({ sessionId: "s1", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", args: [], env: {} });
    // file written under privateRoot/s1/
    expect(existsSync(join(privateRoot, "s1", "settings.json"))).toBe(true);
    expect(readFileSync(join(privateRoot, "s1", "settings.json"), "utf8")).toBe('{"hooks":{}}');
    // tmux new-session command contains --settings and the scoped settings path
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    expect(newSess.join(" ")).toContain("--settings");
    expect(newSess.join(" ")).toContain(join(privateRoot, "s1", "settings.json"));
  });

  it("quotes spawnArgs tokens that contain whitespace in the tmux command", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const fakeProvider = {
      workerHookConfig: () => ({
        files: [{ relPath: "settings.json", contents: '{"hooks":{}}' }],
        spawnArgs: ["--settings", "/tmp/with space/settings.json"],
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
      resolveProvider: (_adapterId) => fakeProvider,
    });
    await mgr.spawn({ sessionId: "s-space", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", args: [], env: {} });
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    const cmd = newSess.join(" ");
    // The path with a space must appear single-quoted so sh -c doesn't word-split it
    // (and, unlike double quotes, single quotes also suppress $(...) / backtick expansion).
    expect(cmd).toContain("'/tmp/with space/settings.json'");
    // The bare unquoted form must NOT appear as a standalone word-split token
    expect(cmd).not.toMatch(/(?<!')\/tmp\/with space\/settings\.json(?!')/);
  });

  it("creates parent dirs for nested relPath files", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const fakeProvider = {
      workerHookConfig: () => ({
        files: [{ relPath: ".codex/hooks.json", contents: "{}" }],
        spawnArgs: [],
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
      resolveProvider: (_adapterId) => fakeProvider,
    });
    await mgr.spawn({ sessionId: "s-nested", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", args: [], env: {} });
    expect(existsSync(join(privateRoot, "s-nested", ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(join(privateRoot, "s-nested", ".codex", "hooks.json"), "utf8")).toBe("{}");
  });

  it("copies provider copyFiles into the config dir and skips missing sources", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const srcDir = mkdtempSync(join(tmpdir(), "orca-auth-"));
    const authSrc = join(srcDir, "auth.json");
    writeFileSync(authSrc, '{"token":"abc"}');
    const tmux = fakeTmux(["auto mode on"]);
    const fakeProvider = {
      workerHookConfig: () => ({
        files: [{ relPath: "config.toml", contents: "[features]\nhooks = true\n" }],
        copyFiles: [
          { relPath: "auth.json", sourcePath: authSrc },
          { relPath: "missing.json", sourcePath: join(srcDir, "does-not-exist.json") },
        ],
        spawnArgs: [],
        env: { CODEX_HOME: "x" },
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
      resolveProvider: (_adapterId) => fakeProvider,
    });
    await mgr.spawn({ sessionId: "s-copy", goalId: "g1", adapterId: "codex", workspacePath: "/ws", command: "codex", args: [], env: {} });
    // existing source copied into the private config dir
    expect(existsSync(join(privateRoot, "s-copy", "auth.json"))).toBe(true);
    expect(readFileSync(join(privateRoot, "s-copy", "auth.json"), "utf8")).toBe('{"token":"abc"}');
    // missing source skipped without throwing or creating a file
    expect(existsSync(join(privateRoot, "s-copy", "missing.json"))).toBe(false);
  });
});

describe("WorkerSessionManager.startTail", () => {
  it("tails appended pane bytes into the capture sink", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const chunks: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude",
      tmux: fakeTmux(["auto mode on"]),
      captureSink: (_sid, buf) => void chunks.push(buf.toString("utf8")),
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    const paneFile = join(privateRoot, "sess-1", "pane.out");
    appendFileSync(paneFile, "hello-pane");
    await vi.waitFor(
      () => expect(chunks.join("")).toContain("hello-pane"),
      { timeout: 2_000, interval: 10 },
    );
    await mgr.terminate("sess-1");
  });

  it("replaces a concurrent reattach tail and stops capture after terminate", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const chunks: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude",
      tmux: fakeTmux(),
      captureSink: (_sid, buf) => void chunks.push(buf.toString("utf8")),
      pollMs: 1,
      resolveProvider,
    });

    await Promise.all([
      mgr.reattach("sess-1", "/repo"),
      mgr.reattach("sess-1", "/repo"),
    ]);

    const paneFile = join(privateRoot, "sess-1", "pane.out");
    appendFileSync(paneFile, "hello-pane");
    await vi.waitFor(
      () => expect(chunks).toEqual(["hello-pane"]),
      { timeout: 2_000, interval: 10 },
    );

    await mgr.terminate("sess-1");
    appendFileSync(paneFile, "-after-terminate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks).toEqual(["hello-pane"]);
  });

  it("cleans up when capture fails during the initial pump", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const sessionDir = join(privateRoot, "sess-1");
    const paneFile = join(sessionDir, "pane.out");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(paneFile, "existing-pane");
    const captureSink = vi.fn(() => {
      throw new Error("capture failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude",
      tmux: fakeTmux(),
      captureSink,
      pollMs: 1,
      resolveProvider,
    });

    try {
      await expect(mgr.reattach("sess-1", "/repo")).resolves.toBe(true);
      appendFileSync(paneFile, "-later");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captureSink).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("tail capture failed"),
        expect.any(Error),
      );
      await expect(mgr.terminate("sess-1")).resolves.not.toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("cleans up when capture fails during a watch callback", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const captureSink = vi.fn(() => {
      throw new Error("capture failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude",
      tmux: fakeTmux(),
      captureSink,
      pollMs: 1,
      resolveProvider,
    });

    try {
      await expect(mgr.reattach("sess-1", "/repo")).resolves.toBe(true);
      const paneFile = join(privateRoot, "sess-1", "pane.out");
      appendFileSync(paneFile, "first");
      await vi.waitFor(
        () => expect(captureSink).toHaveBeenCalledTimes(1),
        { timeout: 2_000, interval: 10 },
      );

      appendFileSync(paneFile, "-later");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captureSink).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("tail capture failed"),
        expect.any(Error),
      );
      await expect(mgr.terminate("sess-1")).resolves.not.toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("WorkerSessionManager.deliver", () => {
  it("deliver waits for an idle prompt, then pastes + submits", async () => {
    // capture-pane: busy (spinner) twice, then idle prompt.
    const tmux = fakeTmux(["auto mode on", "esc to interrupt", "esc to interrupt", "❯ "]);
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux,
      captureSink: () => {}, startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    const result = await mgr.deliver("sess-1", "do the thing\nplease");
    expect(result).toBe("delivered");
    const order = tmux.calls.map((c) => c[0]);
    expect(order).toContain("load-buffer");
    expect(order).toContain("paste-buffer");
    const pasteIdx = order.indexOf("paste-buffer");
    expect(order.slice(pasteIdx).includes("send-keys")).toBe(true);
  });

  it("deliver detects the codex composer prompt (›) as idle, not just claude's ❯", async () => {
    // Codex pane: ready composer, then a busy "Working … esc to interrupt" frame,
    // then the idle composer again. deliver must recognise › (not ❯) as idle.
    const tmux = fakeTmux([
      "› hi",
      "• Working (1s • esc to interrupt)",
      "› Summarize recent commits\n  gpt-5.5 default · /repo",
    ]);
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const codexProvider = { workerHookConfig: () => ({ files: [], spawnArgs: [] }) };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux,
      captureSink: () => {}, startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider: (_adapterId) => codexProvider,
    });
    await mgr.spawn({ sessionId: "cx", goalId: "g1", adapterId: "codex", workspacePath: "/repo", command: "codex", args: [], env: {} });
    expect(await mgr.deliver("cx", "do the thing")).toBe("delivered");
  });

  it("deliver returns no_session for an unknown session", async () => {
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux: fakeTmux(), captureSink: () => {},
      resolveProvider,
    });
    expect(await mgr.deliver("nope", "x")).toBe("no_session");
  });

  it("deliver treats a completed-turn summary ('Churned for Ns') above an idle prompt as idle", async () => {
    // Claude Code prints a past-tense summary line AFTER a turn finishes while it
    // sits idle at the ❯ prompt. That summary is NOT a busy state, so deliver must
    // paste rather than time out waiting for idle.
    const idlePane = "✻ Churned for 36s\n\n❯ \n  ← for agents";
    const tmux = fakeTmux(["auto mode on", idlePane]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-churn", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-churn", "b")).toBe("delivered");
  });

  // The real welcome/home screen a promptless worker launches onto: a decorative
  // "What's new" release-notes panel pinned to the TOP of the pane, then ~tens of
  // blank rows, then the idle composer near the BOTTOM. Reproduced from a live
  // 220x50 worker capture. The release notes contain "thinking", "hook", and
  // "auto mode" — words a whole-pane busy/idle scan misreads as a live turn.
  const welcomeScreen = (releaseNote: string): string =>
    [
      "╭─── Claude Code v2.1.211 ───────────────────────────╮",
      "│                 Welcome back Shawn!                │ Tips for getting started",
      "│                       ▐▛███▜▌                      │ What's new",
      `│                      ▝▜█████▛▘                     │ ${releaseNote}`,
      "│              ~/projects/stock-trader               │ /release-notes for more",
      "╰────────────────────────────────────────────────────╯",
      "",
      " ⚠ 3 MCP servers need authentication · run /mcp",
      ...Array(30).fill(""),
      "                                          ● high · /effort",
      "──────────────────────────────────────────────────────────",
      "❯ ",
      "──────────────────────────────────────────────────────────",
      "  ⏸ manual mode on · ← for agents",
    ].join("\n");

  it("treats an idle welcome screen whose 'What's new' prose contains the word 'thinking' as idle", async () => {
    // Claude Code v2.1.211's panel: "…include subagent text and thinking in stream-json
    // output". A whole-pane /\bthinking\b/ scan wedged deliver() for the full 120s while
    // the ❯ prompt sat idle — the production bug this guards.
    const pane = welcomeScreen("Added --forward-subagent-text to include subagent text and thinking in stream-json output");
    const tmux = fakeTmux(["auto mode on", pane]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-welcome", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-welcome", "the objective")).toBe("delivered");
  });

  it("ignores a still-live busy token ('esc to interrupt') that appears in decorative upper-pane prose", async () => {
    // The general fragility fix: even a busy token we DO still match ("esc to interrupt")
    // must not count when it appears in a decorative release note far above the composer,
    // not in the live spinner directly above it. liveRegion() scopes the scan to the
    // composer's neighbourhood, so this idle worker is delivered, not timed out.
    const pane = welcomeScreen("Fixed the hint text — press esc to interrupt now shows during tool use");
    const tmux = fakeTmux(["auto mode on", pane]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-deco", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-deco", "the objective")).toBe("delivered");
  });

  it("still detects a genuine live spinner ('esc to interrupt') in the status line above the composer", async () => {
    // Guard the other direction: the busy spinner renders just above the composer, inside
    // liveRegion(). A worker mid-turn must NOT be treated as idle (pasting would corrupt
    // its input), so deliver() waits until the spinner clears before pasting.
    const working = welcomeScreen("nothing relevant here").replace("● high · /effort", "✳ Thinking… (3s · esc to interrupt)");
    const idle = welcomeScreen("nothing relevant here");
    const tmux = fakeTmux(["auto mode on", working, idle]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-spin", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-spin", "the objective")).toBe("delivered");
    // First capture (spinner) was busy → deliver waited and pasted only on the idle frame.
    const pastes = tmux.calls.filter((c) => c[0] === "paste-buffer").length;
    expect(pastes).toBe(1);
  });

  it("moves to end then re-submits when a short answer stays in the box", async () => {
    // Repro of the wedge: a one-line answer renders inline in the composer (not as a
    // "[Pasted text]" placeholder), so if the first submit doesn't land (cursor parked
    // mid-text after a re-render, or a dropped keystroke), the text sits in the box. A
    // non-empty ❯ box never matches the empty-prompt idle check, so every later
    // deliver() times out ("did not become idle in time"). deliver must move the cursor
    // to the end (Claude only submits on Enter at end-of-input) and re-send End+Enter
    // until the box actually clears.
    const tmux = fakeTmux([
      "auto mode on",                                  // spawn readiness
      "❯ ",                                            // deliver: idle, empty prompt → paste
      "❯ Under every workspace it's attached to",      // after 1st submit: text still in box
      "esc to interrupt",                              // after 2nd submit: submitted (busy)
    ]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-stuck", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-stuck", "Under every workspace it's attached to")).toBe("delivered");
    const ends = tmux.calls.filter((c) => c[0] === "send-keys" && c[3] === "End").length;
    const enters = tmux.calls.filter((c) => c[0] === "send-keys" && c[3] === "Enter").length;
    expect(enters).toBe(2);          // first submit didn't land → deliver retried
    expect(ends).toBe(2);            // each Enter is preceded by an End (cursor → end)
    // Every Enter must be immediately preceded by an End in the call stream.
    const keys = tmux.calls.filter((c) => c[0] === "send-keys").map((c) => c[3]);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === "Enter") expect(keys[i - 1]).toBe("End");
    }
  });

  it("delivers to an idle composer that shows a placeholder suggestion (empty, not busy)", async () => {
    // After a denied AskUserQuestion, Claude Code renders its suggested answer as
    // greyed PLACEHOLDER text in the (empty) composer: "❯ <suggested answer>".
    // The composer is idle and ready, but the strict empty-prompt check is fooled
    // by the placeholder text and deliver would time out. deliver must treat a
    // not-busy prompt line as idle, clear the line first (C-u), then paste+submit.
    const placeholder = "❯ Local web UI, free API with cached fallback, Python\n  ⏸ manual mode on";
    const tmux = fakeTmux(["auto mode on", placeholder, "esc to interrupt"]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      idleQuietMs: 0, postPasteMs: 0, idleTimeoutMs: 50,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-ph", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(await mgr.deliver("sess-ph", "my real answer")).toBe("delivered");
    // The composer is cleared (C-u) before the paste, so the answer can't append
    // to any leftover text.
    const order = tmux.calls.map((c) => c[0] + (c[0] === "send-keys" ? `:${c[3]}` : ""));
    const clearIdx = order.indexOf("send-keys:C-u");
    const pasteIdx = order.indexOf("paste-buffer");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeLessThan(pasteIdx);
  });
});

describe("WorkerSessionManager.terminate", () => {
  it("marks the session exited when it reaps the worker", async () => {
    // Live observation (2026-07-07 e2e): completed steps left their session
    // rows 'running' forever — terminate killed the tmux pane but nothing
    // owned the DB status flip. The manager reaps, so the manager reports.
    const tmux = fakeTmux(["auto mode on"]);
    const exited: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      markExited: (id) => void exited.push(id),
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await mgr.reattach("sess-1", "/repo");
    await mgr.terminate("sess-1");
    expect(exited).toEqual(["sess-1"]);
  });
});

describe("WorkerSessionManager.reattach", () => {
  it("adopts a surviving tmux session without respawning, and re-pipes output", async () => {
    // fakeTmux: has-session returns code 0 (the helper returns code 0 for all calls)
    const tmux = fakeTmux(["auto mode on"]);
    const marked: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      markRunning: (id) => void marked.push(id),
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    const adopted = await mgr.reattach("sess-1", "/repo");
    expect(adopted).toBe(true);
    expect(tmux.calls.some((c) => c[0] === "new-session")).toBe(false); // did NOT respawn
    expect(tmux.calls.some((c) => c[0] === "pipe-pane")).toBe(true);     // re-piped output
    expect(marked).toContain("sess-1");
    await mgr.terminate("sess-1");
  });

  it("registers and marks the session running before replaying existing output", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const sessionId = "sess-replay";
    mkdirSync(join(privateRoot, sessionId), { recursive: true });
    writeFileSync(join(privateRoot, sessionId, "pane.out"), "existing output");
    const events: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot,
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude",
      tmux: fakeTmux(["auto mode on"]),
      captureSink: () => void events.push("capture"),
      markRunning: () => void events.push("running"),
      resolveProvider,
    });

    await mgr.reattach(sessionId, "/repo");

    expect(events.slice(0, 2)).toEqual(["running", "capture"]);
    await mgr.terminate(sessionId);
  });

  it("returns false when the tmux session does not exist", async () => {
    // Override the fake to return code 1 for has-session
    const calls: string[][] = [];
    const tmux: TmuxRunner & { calls: string[][] } = {
      calls,
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        // has-session returns code 1 (session not found); everything else returns 0
        const code = args[0] === "has-session" ? 1 : 0;
        return { stdout: "", stderr: "", code };
      }),
    } as TmuxRunner & { calls: string[][] };

    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      resolveProvider,
    });
    const adopted = await mgr.reattach("sess-missing", "/repo");
    expect(adopted).toBe(false);
    expect(tmux.calls.some((c) => c[0] === "new-session")).toBe(false);
  });

  it("a second reattach on an already-attached session short-circuits without touching tmux (unchanged by isTmuxAlive)", async () => {
    const tmux = fakeTmux(["auto mode on"]);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    expect(await mgr.reattach("sess-1", "/repo")).toBe(true); // populates the map
    const callsBefore = tmux.calls.length;
    // reattach's `this.sessions.has(sessionId)` fast path means this second call
    // never asks tmux anything — untouched by isTmuxAlive's fix.
    expect(await mgr.reattach("sess-1", "/repo")).toBe(true);
    expect(tmux.calls.length).toBe(callsBefore);
    await mgr.terminate("sess-1");
  });

  it("spawn still works without markRunning (optional dep)", async () => {
    const tmux = fakeTmux(["auto mode on"]);
    // No markRunning provided — should not throw
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await expect(mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} })).resolves.not.toThrow();
    await mgr.terminate("sess-1");
  });

  it("spawn calls markRunning when provided", async () => {
    const tmux = fakeTmux(["auto mode on"]);
    const marked: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      markRunning: (id) => void marked.push(id),
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-2", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    expect(marked).toContain("sess-2");
    await mgr.terminate("sess-2");
  });
});

describe("WorkerSessionManager.waitForProviderReset", () => {
  it("invokes the provider's waitForLimitReset against the live tmux session", async () => {
    const tmux = fakeTmux(["auto mode on"]);
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux,
      captureSink: () => {}, startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
      resolveProvider,
    });
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    await mgr.waitForProviderReset("sess-1", "claude-code");
    expect(tmux.calls).toContainEqual([
      "send-keys",
      "-t",
      "orca-worker-sess-1",
      "Enter",
    ]);
    await mgr.terminate("sess-1");
  });

  it("controls a live but unregistered deterministic session after a daemon restart", async () => {
    const tmux = fakeTmux();
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux,
      captureSink: () => {}, pollMs: 1,
      resolveProvider,
    });
    // No spawn/reattach: the in-memory session map is empty (as after restart), but
    // the deterministic tmux name is derived from the session id.
    await mgr.waitForProviderReset("sess-restored", "claude-code");
    expect(tmux.calls).toContainEqual([
      "send-keys",
      "-t",
      "orca-worker-sess-restored",
      "Enter",
    ]);
  });

  it("throws when the provider cannot preserve a limited session", async () => {
    const tmux = fakeTmux();
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const noWaitProvider = {
      workerHookConfig: () => ({ files: [], spawnArgs: [] }),
      displayName: "Antigravity",
    };
    const mgr = new WorkerSessionManager({
      privateRoot, authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux,
      captureSink: () => {}, pollMs: 1,
      resolveProvider: (_adapterId) => noWaitProvider,
    });
    await expect(mgr.waitForProviderReset("sess-x", "antigravity")).rejects.toThrow(
      /Antigravity does not support/
    );
  });
});

describe("WorkerSessionManager.terminate", () => {
  it("kills a surviving tmux worker that is not registered in memory", async () => {
    const tmux = fakeTmux();
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
      authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude",
      tmux,
      captureSink: () => {},
      resolveProvider,
    });

    await mgr.terminate("sess-stale");

    expect(tmux.calls).toContainEqual([
      "kill-session",
      "-t",
      "orca-worker-sess-stale",
    ]);
  });
});

describe("WorkerSessionManager startup — trust prompt", () => {
  // Claude Code renders the affirmative row SECOND and highlights "No, exit".
  // A blind Enter therefore selects exit and quits the worker ~2s in; the run
  // then blocks as `worker_exited_no_signal` after three identical retries.
  const TRUST_NO_SELECTED = ["Do you trust the files in this folder?", "❯ No, exit", "  Yes, I trust this folder"].join("\n");
  const TRUST_YES_SELECTED = ["Do you trust the files in this folder?", "  No, exit", "❯ Yes, I trust this folder"].join("\n");
  const READY = "auto mode on";

  function mgrWith(panes: string[]) {
    const tmux = fakeTmux(panes);
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 200, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });
    return { tmux, mgr };
  }
  const keys = (tmux: { calls: string[][] }) =>
    tmux.calls.filter((c) => c[0] === "send-keys").map((c) => c[c.length - 1]);
  async function waitFor(fn: () => boolean, ms = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("condition never met");
  }

  it("moves the highlight onto the affirmative row and never confirms on 'No, exit'", async () => {
    const { tmux, mgr } = mgrWith([TRUST_NO_SELECTED, TRUST_YES_SELECTED, READY]);
    await mgr.spawn({ sessionId: "s1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    await waitFor(() => keys(tmux).includes("Enter"));
    const sent = keys(tmux);
    // The FIRST key must be the move, not the confirm — confirming first is the bug.
    expect(sent[0]).toBe("Down");
    expect(sent.indexOf("Down")).toBeLessThan(sent.indexOf("Enter"));
  });

  it("keeps polling instead of confirming blind while the menu has not painted its options", async () => {
    // Trust TEXT is on screen but no yes/no rows yet: the highlight position is
    // unknowable, and a guess costs the session.
    const { tmux, mgr } = mgrWith(["Do you trust the files in this folder?"]);
    await mgr.spawn({ sessionId: "s2", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    await waitFor(() => tmux.calls.filter((c) => c[0] === "capture-pane").length >= 3);
    expect(keys(tmux)).toHaveLength(0);
  });

  it("does not mistake the trust menu's own '❯' row for the ready prompt", async () => {
    // READY_DEFAULT's `\n\s*❯` branch matches "❯ No, exit". If ready were checked
    // first, startup would return with the menu still open and deliver() would
    // paste the step prompt into a modal dialog.
    const { tmux, mgr } = mgrWith([TRUST_NO_SELECTED, TRUST_YES_SELECTED, READY]);
    await mgr.spawn({ sessionId: "s3", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", args: [], env: {} });
    await waitFor(() => keys(tmux).includes("Enter"));
    expect(keys(tmux).filter((k) => k === "Enter")).toHaveLength(1);
  });
});

describe("WorkerSessionManager.spawn — model args", () => {
  function mgrWithSpawnArgs(spawnArgs: string[]) {
    const tmux = fakeTmux(["auto mode on"]);
    const fakeProvider = {
      workerHookConfig: () => ({ files: [], spawnArgs }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 1, pollMs: 1, readyQuietMs: 0,
      resolveProvider: (_adapterId) => fakeProvider,
    });
    return { tmux, mgr };
  }
  const newSessionCommand = (tmux: { calls: string[][] }) =>
    tmux.calls.find((c) => c[0] === "new-session")!.at(-1)!;

  it("puts the model args into the tmux command", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "m1", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws",
      command: "/bin/claude", env: {}, args: ["--model", "claude-opus-5", "--effort", "high"],
    });
    expect(newSessionCommand(tmux)).toContain("--model claude-opus-5 --effort high");
  });

  it("keeps the provider's own spawn args alongside the model args", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs(["--settings", "/cfg/settings.json"]);
    await mgr.spawn({
      sessionId: "m2", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws",
      command: "/bin/claude", env: {}, args: ["--model", "claude-opus-5"],
    });
    const cmd = newSessionCommand(tmux);
    expect(cmd).toContain("--settings /cfg/settings.json");
    expect(cmd).toContain("--model claude-opus-5");
  });

  it("spawns without model args when none were resolved", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "m3", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws",
      command: "/bin/claude", env: {}, args: [],
    });
    expect(newSessionCommand(tmux)).not.toContain("--model");
  });

  it("quotes a 1m model id so the shell cannot glob-expand its brackets", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "m4", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "claude-opus-5[1m]", "--effort", "high"],
    });
    expect(newSessionCommand(tmux)).toContain("'claude-opus-5[1m]'");
  });

  it("neutralises command substitution in a spawn arg", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "s5", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "$(touch /tmp/orca-pwned)"],
    });
    const cmd = newSessionCommand(tmux);
    expect(cmd).toContain(`'$(touch /tmp/orca-pwned)'`);
    expect(cmd).not.toContain(`"$(touch /tmp/orca-pwned)"`);
  });

  it("neutralises backtick substitution in a spawn arg", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "s6", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "`id`"],
    });
    expect(newSessionCommand(tmux)).toContain("'`id`'");
  });

  it("escapes an embedded single quote so the quoting cannot be broken out of", async () => {
    const { tmux, mgr } = mgrWithSpawnArgs([]);
    await mgr.spawn({
      sessionId: "s7", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "a'b"],
    });
    expect(newSessionCommand(tmux)).toContain(`'a'\\''b'`);
  });

  it("proves the quoting is safe: running the built command through sh -c has no side effect", async () => {
    const pocFile = join(tmpdir(), `orca-poc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const { tmux, mgr } = mgrWithSpawnArgs([]);
      await mgr.spawn({
        sessionId: "s8", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
        command: "/bin/echo", env: {}, args: ["--model", `$(touch ${pocFile})`],
      });
      const cmd = newSessionCommand(tmux);
      execFileSync("sh", ["-c", cmd]);
      expect(existsSync(pocFile)).toBe(false);
    } finally {
      if (existsSync(pocFile)) rmSync(pocFile);
    }
  });
});

describe("isPaneIdle", () => {
  const composer = "\n❯ \n";

  it("is idle at a rendered composer with no turn in flight", () => {
    expect(isPaneIdle(`✻ Crunched for 18s · done${composer}`)).toBe(true);
  });

  it("is busy while a turn is running", () => {
    expect(isPaneIdle(`✻ Thinking… (esc to interrupt)${composer}`)).toBe(false);
  });

  it("is busy while a hook runs", () => {
    expect(isPaneIdle(`running PreToolUse hook${composer}`)).toBe(false);
  });

  it("recognises codex's composer", () => {
    expect(isPaneIdle("\n› summarize recent commits\n")).toBe(true);
  });

  it("is not idle before any composer has rendered", () => {
    expect(isPaneIdle("Loading...\n")).toBe(false);
  });
});

describe("WorkerSessionManager.writeInput", () => {
  function manager(tmux: TmuxRunner) {
    return new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });
  }

  it("sends raw bytes as hex while the pane is idle", async () => {
    const tmux = fakeTmux(["✻ done\n❯ \n"]);
    const result = await manager(tmux).writeInput("sess-1", Buffer.from("hi\r"));

    expect(result).toBe("written");
    const sent = tmux.calls.find((c) => c[0] === "send-keys");
    // "hi\r" — Enter survives as 0d, which `send-keys -l` could not carry.
    expect(sent).toEqual(["send-keys", "-t", "orca-worker-sess-1", "-H", "68", "69", "0d"]);
  });

  it("refuses input while the agent is mid-turn, rather than queueing it", async () => {
    // The orchestrator's deliver() clears the composer with C-u before pasting,
    // so keys admitted here would be erased — or would corrupt its paste.
    const tmux = fakeTmux(["✻ Thinking… (esc to interrupt)\n❯ \n"]);
    const result = await manager(tmux).writeInput("sess-1", Buffer.from("hi"));

    expect(result).toBe("busy");
    expect(tmux.calls.some((c) => c[0] === "send-keys")).toBe(false);
  });

  it("reports no_session when the worker's tmux session is gone", async () => {
    const tmux: TmuxRunner = { run: async (args) => ({ stdout: "", stderr: "", code: args[0] === "has-session" ? 1 : 0 }) };
    expect(await manager(tmux).writeInput("sess-1", Buffer.from("hi"))).toBe("no_session");
  });

  it("reuses one idle check across a burst of keystrokes", async () => {
    // A capture-pane per character would spawn a tmux process per keypress.
    const tmux = fakeTmux(["✻ done\n❯ \n"]);
    const mgr = manager(tmux);
    for (const ch of "hello") await mgr.writeInput("sess-1", Buffer.from(ch));

    expect(tmux.calls.filter((c) => c[0] === "capture-pane")).toHaveLength(1);
    expect(tmux.calls.filter((c) => c[0] === "send-keys")).toHaveLength(5);
  });

  it("writes nothing for an empty payload", async () => {
    const tmux = fakeTmux(["✻ done\n❯ \n"]);
    expect(await manager(tmux).writeInput("sess-1", Buffer.alloc(0))).toBe("written");
    expect(tmux.calls.some((c) => c[0] === "send-keys")).toBe(false);
  });
});

describe("WorkerSessionManager.writeInput ordering", () => {
  it("delivers a burst of keystrokes in the order they were typed", async () => {
    // Each keystroke is its own send-keys process. Fired concurrently they
    // complete out of order and the agent's composer showed scrambled text.
    const calls: string[][] = [];
    let pending = 0;
    const tmux: TmuxRunner = {
      run: vi.fn(async (args: string[]) => {
        // Later calls finish sooner unless the writes are serialized.
        const delay = Math.max(0, 20 - pending++ * 5);
        await new Promise((r) => setTimeout(r, delay));
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? "✻ done\n❯ \n" : "", stderr: "", code: 0 };
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });

    const results = await Promise.all(
      [..."hello"].map((ch) => mgr.writeInput("sess-1", Buffer.from(ch)))
    );

    expect(results).toEqual(["written", "written", "written", "written", "written"]);
    const typed = calls
      .filter((c) => c[0] === "send-keys")
      .map((c) => c.slice(4).map((hex) => String.fromCharCode(parseInt(hex, 16))).join(""));
    expect(typed.join("")).toBe("hello");
  });
});

describe("WorkerSessionManager.writeInput batching", () => {
  it("sends a burst as one tmux call instead of one per character", async () => {
    // Every send is a subprocess. One per keystroke put typing behind the fingers.
    const calls: string[][] = [];
    const tmux: TmuxRunner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        await new Promise((r) => setTimeout(r, 5));
        return { stdout: args[0] === "capture-pane" ? "✻ done\n❯ \n" : "", stderr: "", code: 0 };
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });

    const results = await Promise.all([..."hello"].map((ch) => mgr.writeInput("sess-1", Buffer.from(ch))));

    expect(results).toEqual(Array(5).fill("written"));
    const sends = calls.filter((c) => c[0] === "send-keys");
    // The first character goes out at once; the other four ride one batch.
    expect(sends.length).toBeLessThanOrEqual(2);
    const typed = sends.map((c) => c.slice(4).map((h) => String.fromCharCode(parseInt(h, 16))).join("")).join("");
    expect(typed).toBe("hello");
  });

  it("does not spend a liveness check on the typing path", async () => {
    const calls: string[][] = [];
    const tmux: TmuxRunner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: args[0] === "capture-pane" ? "✻ done\n❯ \n" : "", stderr: "", code: 0 };
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });

    expect(await mgr.writeInput("sess-1", Buffer.from("x"))).toBe("written");
    // send-keys reports a missing session itself, so asking first was a wasted
    // subprocess on every keystroke.
    expect(calls.some((c) => c[0] === "has-session")).toBe(false);
  });

  it("reports no_session when the send is refused because the pane is gone", async () => {
    const tmux: TmuxRunner = {
      run: async (args) => ({
        stdout: args[0] === "capture-pane" ? "✻ done\n❯ \n" : "",
        stderr: "",
        code: args[0] === "send-keys" ? 1 : 0,
      }),
    };
    const mgr = new WorkerSessionManager({
      privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")), authToken: "tok",
      hookResolverCommand: ["node", "test-daemon.js"], claudeBin: "claude", tmux, captureSink: () => {},
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0, resolveProvider,
    });

    expect(await mgr.writeInput("sess-1", Buffer.from("x"))).toBe("no_session");
  });
});

describe("pane capture survives a daemon restart", () => {
  it("re-establishes the pipe without toggling the existing one off", async () => {
    // `pipe-pane -o` toggles: it opens a pipe when none is open and CLOSES the one
    // that is. The tmux server outlives the daemon, so a worker's pipe is still
    // open when reattach runs — and that call was switching capture off, blinding
    // the daemon to its agents' output on every other restart.
    const tmux = fakeTmux(["auto mode on\n❯ \n"]);
    const base = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const deps = {
      privateRoot: base, authToken: "tok", hookResolverCommand: ["node", "test-daemon.js"],
      claudeBin: "claude", tmux, captureSink: () => {}, resolveProvider,
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
    };
    const wsDir = mkdtempSync(join(tmpdir(), "orca-worker-ws-"));

    await new WorkerSessionManager(deps).spawn({
      sessionId: "sess-1", goalId: "g1", adapterId: "claude-code",
      workspacePath: wsDir, command: "claude", args: [], env: {},
    });
    // A fresh manager, as a restarted daemon builds, adopting the live session.
    await new WorkerSessionManager(deps).reattach("sess-1", wsDir);

    const pipes = tmux.calls.filter((c) => c[0] === "pipe-pane");
    expect(pipes).toHaveLength(2);
    for (const pipe of pipes) expect(pipe).not.toContain("-o");
  });
});
