import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  capturePane, defaultTmuxRunner, killSession, listSessions, newSession, paste, sendEnter, sendKey, sessionOwner,
  tmuxSocketPath, type TmuxRunner,
} from "./runner.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_bin: string, _args: string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    cb(null, "", "");
    return { stdin: { end: () => undefined } };
  }),
}));

function fakeRunner(stdout = ""): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: vi.fn(async (args: string[]) => { calls.push(args); return { stdout, stderr: "", code: 0 }; }),
  } as TmuxRunner & { calls: string[][] };
}

describe("tmux socket isolation", () => {
  it("each data dir owns a socket beside its database", () => {
    expect(tmuxSocketPath("/Users/dev/.orca")).toBe("/Users/dev/.orca/tmux.sock");
  });

  it("the default runner addresses every command at the daemon's own socket, never the shared server", async () => {
    const r = defaultTmuxRunner("/Users/dev/.orca/tmux.sock");
    await r.run(["list-sessions", "-F", "#{session_name}"]);
    await r.run(["kill-session", "-t", "orca-worker-1"]);
    const calls = vi.mocked(execFile).mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toEqual([
      ["tmux", ["-S", "/Users/dev/.orca/tmux.sock", "list-sessions", "-F", "#{session_name}"]],
      ["tmux", ["-S", "/Users/dev/.orca/tmux.sock", "kill-session", "-t", "orca-worker-1"]],
    ]);
  });
});

describe("tmux runner helpers", () => {
  it("capturePane returns pane stdout", async () => {
    const r = fakeRunner("❯ idle");
    expect(await capturePane(r, "sess")).toBe("❯ idle");
    expect(r.calls[0]).toEqual(["capture-pane", "-t", "sess", "-p"]);
  });

  it("paste loads a buffer then bracketed-pastes it", async () => {
    const r = fakeRunner();
    await paste(r, "sess", "buf", "multi\nline");
    expect(r.calls[0]).toEqual(["load-buffer", "-b", "buf", "-"]);
    expect(r.calls[1]).toEqual(["paste-buffer", "-b", "buf", "-t", "sess", "-d", "-p"]);
  });

  it("sendEnter sends an Enter key", async () => {
    const r = fakeRunner();
    await sendEnter(r, "sess");
    expect(r.calls[0]).toEqual(["send-keys", "-t", "sess", "Enter"]);
  });

  it("sendKey sends an arbitrary key", async () => {
    const r = fakeRunner();
    await sendKey(r, "sess", "Down");
    expect(r.calls[0]).toEqual(["send-keys", "-t", "sess", "Down"]);
  });

  it("listSessions returns one session name per line, ignoring blanks", async () => {
    const r = fakeRunner("orca-worker-a\norca-shadow-g1\n\n");
    expect(await listSessions(r)).toEqual(["orca-worker-a", "orca-shadow-g1"]);
    expect(r.calls[0]).toEqual(["list-sessions", "-F", "#{session_name}"]);
  });

  it("listSessions returns [] when tmux has no server/sessions (nonzero exit)", async () => {
    const r: TmuxRunner = { run: async () => ({ stdout: "", stderr: "no server running", code: 1 }) };
    expect(await listSessions(r)).toEqual([]);
  });

  it("killSession names its caller when it actually removed a live session, and stays quiet otherwise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const live: TmuxRunner = { run: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) };
    await killSession(live, "orca-worker-1", "boot reap");
    expect(log).toHaveBeenCalledWith("[tmux] killed orca-worker-1 (boot reap)");
    const gone: TmuxRunner = { run: vi.fn(async () => ({ stdout: "", stderr: "no server", code: 1 })) };
    log.mockClear();
    await killSession(gone, "orca-worker-2", "boot reap");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("newSession warns when its idempotent pre-kill replaced a live session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r: TmuxRunner = { run: vi.fn(async (args: string[]) => ({ stdout: "", stderr: "", code: args[0] === "kill-session" ? 0 : 0 })) };
    await newSession(r, "orca-worker-3", "/tmp", "claude");
    expect(warn).toHaveBeenCalledWith("[tmux] new-session replaced a live session orca-worker-3");
    warn.mockRestore();
  });

  it("sessionOwner reads the tag from the session environment and is null when absent or gone", async () => {
    const tagged: TmuxRunner = { run: vi.fn(async () => ({ stdout: "ORCA_OWNER=/Users/dev/.orca\n", stderr: "", code: 0 })) };
    expect(await sessionOwner(tagged, "orca-worker-1")).toBe("/Users/dev/.orca");
    const untagged: TmuxRunner = { run: vi.fn(async () => ({ stdout: "-ORCA_OWNER\n", stderr: "", code: 0 })) };
    expect(await sessionOwner(untagged, "orca-worker-1")).toBeNull();
    const gone: TmuxRunner = { run: vi.fn(async () => ({ stdout: "", stderr: "can't find session", code: 1 })) };
    expect(await sessionOwner(gone, "orca-worker-1")).toBeNull();
  });
});
