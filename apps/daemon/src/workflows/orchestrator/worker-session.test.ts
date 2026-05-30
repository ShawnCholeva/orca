import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSessionManager } from "./worker-session.js";
import type { TmuxRunner } from "../../tmux/runner.js";

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

describe("WorkerSessionManager.spawn", () => {
  it("writes hook settings to a private dir and starts tmux in the workspace with --settings", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const tmux = fakeTmux(["auto mode on"]);
    const mgr = new WorkerSessionManager({
      privateRoot, daemonPort: 8787, authToken: "tok",
      claudeBin: "claude", tmux, captureSink: () => {}, startupTimeoutMs: 50, pollMs: 1, readyQuietMs: 0,
    });
    await mgr.spawn({ sessionId: "sess-1", workspacePath: "/repo", command: "claude", env: { HOME: "/home/u" } });
    // private settings written, NOT under /repo
    expect(existsSync(join(privateRoot, "sess-1", "settings.json"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(privateRoot, "sess-1", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].url).toContain("sessionId=sess-1");
    // new-session used the workspace cwd and layered hooks via --settings (NOT CLAUDE_CONFIG_DIR)
    const newSess = tmux.calls.find((c) => c[0] === "new-session")!;
    expect(newSess).toContain("/repo");
    expect(newSess.join(" ")).toContain("--settings");
    expect(newSess.join(" ")).toContain(join(privateRoot, "sess-1", "settings.json"));
    expect(newSess.join(" ")).not.toContain("CLAUDE_CONFIG_DIR");
    // output pipe established
    expect(tmux.calls.some((c) => c[0] === "pipe-pane")).toBe(true);
  });
});

describe("WorkerSessionManager.startTail", () => {
  it("tails appended pane bytes into the capture sink", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "orca-worker-"));
    const chunks: string[] = [];
    const mgr = new WorkerSessionManager({
      privateRoot, daemonPort: 8787, authToken: "tok", claudeBin: "claude",
      tmux: fakeTmux(["auto mode on"]),
      captureSink: (_sid, buf) => void chunks.push(buf.toString("utf8")),
      startupTimeoutMs: 20, pollMs: 1, readyQuietMs: 0,
    });
    await mgr.spawn({ sessionId: "sess-1", workspacePath: "/repo", command: "claude", env: {} });
    const paneFile = join(privateRoot, "sess-1", "pane.out");
    appendFileSync(paneFile, "hello-pane");
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks.join("")).toContain("hello-pane");
    await mgr.terminate("sess-1");
  });
});
