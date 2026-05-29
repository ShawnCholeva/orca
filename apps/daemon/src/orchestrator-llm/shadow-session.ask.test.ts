import { describe, it, expect } from "vitest";
import { FakePtyManager, controlFakePty } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function mgr() {
  const pty = new FakePtyManager();
  const m = new ShadowSessionManager({
    ptyManager: pty,
    resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
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
});
