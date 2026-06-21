import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSessionManager } from "./worker-session.js";
import type { TmuxRunner } from "../../tmux/runner.js";
import { resolveShadowProvider } from "../../orchestrator-llm/providers/registry.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/providers/types.js";

// Wrap resolveShadowProvider to widen the parameter type from ShadowAdapterId to string,
// satisfying the WorkerSessionDeps.resolveProvider signature.
const resolveProvider = (adapterId: string) => resolveShadowProvider(adapterId as ShadowAdapterId);

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
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: { HOME: "/home/u" } });
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
    await mgr.spawn({ sessionId: "s1", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", env: {} });
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
    await mgr.spawn({ sessionId: "s-space", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", env: {} });
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    const cmd = newSess.join(" ");
    // The path with a space must appear JSON-quoted (double-quoted) so sh -c doesn't word-split it
    expect(cmd).toContain('"/tmp/with space/settings.json"');
    // The bare unquoted form must NOT appear as a standalone word-split token
    expect(cmd).not.toMatch(/(?<!")\/tmp\/with space\/settings\.json(?!")/);
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
    await mgr.spawn({ sessionId: "s-nested", goalId: "g1", adapterId: "claude-code", workspacePath: "/ws", command: "claude", env: {} });
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
    await mgr.spawn({ sessionId: "s-copy", goalId: "g1", adapterId: "codex", workspacePath: "/ws", command: "codex", env: {} });
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
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
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
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
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
    await mgr.spawn({ sessionId: "cx", goalId: "g1", adapterId: "codex", workspacePath: "/repo", command: "codex", env: {} });
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
    await mgr.spawn({ sessionId: "sess-churn", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
    expect(await mgr.deliver("sess-churn", "b")).toBe("delivered");
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
    await mgr.spawn({ sessionId: "sess-stuck", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
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
    await expect(mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} })).resolves.not.toThrow();
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
    await mgr.spawn({ sessionId: "sess-2", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
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
    await mgr.spawn({ sessionId: "sess-1", goalId: "g1", adapterId: "claude-code", workspacePath: "/repo", command: "claude", env: {} });
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
