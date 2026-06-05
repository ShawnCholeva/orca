import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowSessionManager } from "./shadow-session.js";

/**
 * Fake TmuxRunner whose capture-pane immediately returns a "ready" pane
 * (no trust prompt), so startup() resolves quickly.
 * Each call is recorded as { args, input? } so tests can inspect stdin-injected text.
 */
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

/** Wait enough time for startup to resolve (pollMs=1, readyQuietMs=1, plus slack). */
const waitReady = () => new Promise<void>((r) => setTimeout(r, 20));

describe("ShadowSessionManager.ask (hook-resolved)", () => {
  it("injects prompt via load-buffer/paste-buffer/send-keys and resolves when resolvePending delivers text", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "SYS", userPrompt: "hello", timeoutMs: 1000 });
    await waitReady();
    // Verify the load-buffer call was made with text passed as stdin input
    const loadBuf = tmux.calls.find((c) => c.args[0] === "load-buffer");
    expect(loadBuf).toBeDefined();
    expect(loadBuf!.args.join(" ")).toContain("orca-G1");
    // Text is passed via the `input` parameter (stdin), not as an arg
    expect(loadBuf!.input).toContain("SYS");
    expect(loadBuf!.input).toContain("hello");
    const pasteBuf = tmux.calls.find((c) => c.args[0] === "paste-buffer");
    expect(pasteBuf).toBeDefined();
    m.resolvePending("G1", { text: '```orca:action\n{"kind":"answer_user_directly","body":"hi"}\n```' });
    expect((await p).text).toBe('{"kind":"answer_user_directly","body":"hi"}');
  });

  it("FIFO serializes: second ask waits for first to settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p1 = m.ask("G1", { systemPrompt: "S", userPrompt: "q1", timeoutMs: 1000 });
    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "q2", timeoutMs: 1000 });
    await waitReady(); // let startup resolve so p1's askOnce runs and sets pending
    m.resolvePending("G1", { text: '```orca:action\n{"n":1}\n```' });
    expect((await p1).text).toBe('{"n":1}');
    // After p1 resolves, p2's askOnce is scheduled via queue.then() — it must
    // await pre.ready + 3 async tmux calls before setting pending. Give it time.
    await waitReady();
    m.resolvePending("G1", { text: '```orca:action\n{"n":2}\n```' });
    expect((await p2).text).toBe('{"n":2}');
  });

  it("rejects on timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    await expect(m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 10 })).rejects.toThrow(/timeout/i);
  });

  it("codex resolves via the Stop hook's last_assistant_message action block", async () => {
    // Codex now uses hook capture: the Stop hook POSTs last_assistant_message
    // (carrying the ```orca:action fence) to /v1/shadow-hooks/stop -> resolvePending.
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux(["codex ready\n>"]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1", "codex");
    const p = m.ask("G1", { adapterId: "codex", systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await waitReady();
    m.resolvePending("G1", {
      text: '```orca:action\n{"kind":"forward_to_agent","translated":"hello"}\n```',
    });
    expect((await p).text).toBe('{"kind":"forward_to_agent","translated":"hello"}');
  });

  it("codex StopFailure (failure=true) rejects the pending ask", async () => {
    // Usage-limit / auth-loss surfaces as a StopFailure hook (failure=1) on the
    // hook capture path, rejecting the ask without waiting for the timeout.
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux(["codex ready\n>"]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1", "codex");
    const p = m.ask("G1", { adapterId: "codex", systemPrompt: "S", userPrompt: "q", timeoutMs: 5000 });
    await waitReady();
    m.resolvePending("G1", { failure: true, text: "codex usage limit reached" });
    await expect(p).rejects.toThrow(/usage limit/i);
  });

  it("codex ask dismisses the non-fatal model-switch modal before pasting the next prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux([
      "codex ready\n>",
      [
        "Approaching rate limits",
        "Switch to gpt-5.4-mini for lower credit usage?",
        "",
        "› 1. Switch to gpt-5.4-mini",
        "  2. Keep current model",
      ].join("\n"),
    ]);
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1", "codex");
    const p = m.ask("G1", {
      adapterId: "codex",
      systemPrompt: "S",
      userPrompt: "q",
      timeoutMs: 5000,
    });
    // beforeSubmit (modal dismissal) runs before the prompt is pasted and pending
    // is registered; wait until paste-buffer fires so resolvePending isn't dropped.
    await vi.waitFor(() => expect(tmux.calls.some((c) => c.args[0] === "paste-buffer")).toBe(true));
    m.resolvePending("G1", {
      text: '```orca:action\n{"kind":"answer_user_directly","body":"ok"}\n```',
    });
    await p;
    const dismissIndex = tmux.calls.findIndex((c) => c.args[0] === "send-keys" && c.args.includes("2"));
    const pasteIndex = tmux.calls.findIndex((c) => c.args[0] === "paste-buffer");
    expect(dismissIndex).toBeGreaterThanOrEqual(0);
    expect(pasteIndex).toBeGreaterThan(dismissIndex);
  });

  it("StopFailure (failure=true) rejects the pending ask", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await waitReady();
    m.resolvePending("G1", { failure: true });
    await expect(p).rejects.toThrow(/failure|stopfailure/i);
  });

  it("no parseable action block rejects", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await waitReady();
    m.resolvePending("G1", { text: "sorry, no json here" });
    await expect(p).rejects.toThrow(/no .*action|unparse/i);
  });

  it("terminate rejects an in-flight ask immediately (no timeout wait)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 60_000 });
    await waitReady();
    await m.terminate("G1");
    await expect(p).rejects.toThrow(/exited|terminated/i);
    expect(m.has("G1")).toBe(false);
  });

  it("rejects the ask when startup never reaches a ready prompt (timeout throws, not silent resolve)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // Pane never matches a ready input prompt.
    const tmux = fakeTmux(["loading...\nplease wait"]);
    const m = new ShadowSessionManager({ ...deps(root, tmux), startupTimeoutMs: 20 });
    await m.spawn("G1");
    await expect(
      m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 }),
    ).rejects.toThrow(/startup timed out.*never reached a ready input prompt/i);
  });

  it("does not false-ready on a codex update-available interstitial (then times out)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    // Pane contains the codex update nag plus a `›` glyph — must NOT count as ready.
    const tmux = fakeTmux([
      ["Update available!", "› 1. Update now", "  2. Skip"].join("\n"),
    ]);
    const m = new ShadowSessionManager({ ...deps(root, tmux), startupTimeoutMs: 20 });
    await m.spawn("G1", "codex");
    await expect(
      m.ask("G1", { adapterId: "codex", systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 }),
    ).rejects.toThrow(/startup timed out.*never reached a ready input prompt/i);
  });

  it("ask auto-spawns when no session exists yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const m = new ShadowSessionManager(deps(root, tmux));
    // NOTE: no m.spawn("G1") first
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    // spawn is async; drain microtasks until the session exists
    while (!m.has("G1")) await Promise.resolve();
    await waitReady();
    expect(m.has("G1")).toBe(true);
    m.resolvePending("G1", { text: '```orca:action\n{"ok":1}\n```' });
    expect((await p).text).toBe('{"ok":1}');
  });
});
