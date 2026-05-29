import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePtyManager, controlFakePty } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function mgr() {
  const pty = new FakePtyManager();
  const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
  const m = new ShadowSessionManager({
    ptyManager: pty,
    shadowRoot: root,
    daemonPort: 8787,
    isReady: async () => true,
    resolveSpawnCommand: (cwd) => ({ command: "claude", args: [], env: {}, cwd }),
  });
  return { pty, m };
}

/** Drain microtask queue so that queued .then() callbacks (e.g. askOnce) run. */
const tick = () => Promise.resolve();

describe("ShadowSessionManager.ask (hook-resolved)", () => {
  it("writes prompt+CR and resolves when resolvePending delivers text", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "SYS", userPrompt: "hello", timeoutMs: 1000 });
    await tick(); // let askOnce run (it's queued via session.queue.then())
    const written = controlFakePty(pty.handles[0]).writtenChunks.map((b) => b.toString()).join("");
    expect(written).toContain("hello");
    expect(written).toContain("SYS");
    expect(written).toContain("\r");
    m.resolvePending("G1", { text: '```orca:action\n{"kind":"answer_user_directly","body":"hi"}\n```' });
    expect((await p).text).toBe('{"kind":"answer_user_directly","body":"hi"}');
  });

  it("FIFO serializes: second ask waits for first to settle", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p1 = m.ask("G1", { systemPrompt: "S", userPrompt: "q1", timeoutMs: 1000 });
    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "q2", timeoutMs: 1000 });
    await tick(); // let p1's askOnce run and set pending
    m.resolvePending("G1", { text: '```orca:action\n{"n":1}\n```' });
    expect((await p1).text).toBe('{"n":1}');
    await tick(); // let p2's askOnce run now that p1 settled
    m.resolvePending("G1", { text: '```orca:action\n{"n":2}\n```' });
    expect((await p2).text).toBe('{"n":2}');
  });

  it("rejects on timeout", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    await expect(m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 10 })).rejects.toThrow(/timeout/i);
  });

  it("StopFailure (failure=true) rejects the pending ask", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await tick(); // let askOnce run and set pending
    m.resolvePending("G1", { failure: true });
    await expect(p).rejects.toThrow(/failure|stopfailure/i);
  });

  it("no parseable action block rejects", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await tick(); // let askOnce run and set pending
    m.resolvePending("G1", { text: "sorry, no json here" });
    await expect(p).rejects.toThrow(/no .*action|unparse/i);
  });

  it("rejects an outstanding ask when the session exits", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 5000 });
    await Promise.resolve(); // let askOnce run and register pending
    controlFakePty(pty.handles[0]).emitExit({ exitCode: 1, signal: null });
    await expect(p).rejects.toThrow(/exited/i);
    expect(m.has("G1")).toBe(false);
  });

  it("terminate rejects an in-flight ask immediately (no timeout wait)", async () => {
    const { m } = mgr();
    await m.spawn("G1");
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 60_000 });
    await Promise.resolve(); // let askOnce register pending
    await m.terminate("G1");
    await expect(p).rejects.toThrow(/terminated/i);
    expect(m.has("G1")).toBe(false);
  });

  it("ask auto-spawns when no session exists yet", async () => {
    const { pty, m } = mgr();
    // NOTE: no m.spawn("G1") first
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    // spawn is async (await isReady() + sync start); drain microtasks until the session exists,
    // then two more ticks: one for ask() to resume past "await spawn" and schedule
    // session.queue.then(askOnce), and one for that .then callback to actually run askOnce.
    while (!m.has("G1")) await tick();
    await tick(); // ask() resumes, executes session.queue.then(() => askOnce(...))
    await tick(); // .then callback fires — askOnce runs and registers pending
    expect(m.has("G1")).toBe(true);
    m.resolvePending("G1", { text: '```orca:action\n{"ok":1}\n```' });
    expect((await p).text).toBe('{"ok":1}');
  });
});
