import { describe, expect, it, vi } from "vitest";
import { capturePane, listSessions, paste, sendEnter, sendKey, type TmuxRunner } from "./runner.js";

function fakeRunner(stdout = ""): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: vi.fn(async (args: string[]) => { calls.push(args); return { stdout, stderr: "", code: 0 }; }),
  } as TmuxRunner & { calls: string[][] };
}

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
});
