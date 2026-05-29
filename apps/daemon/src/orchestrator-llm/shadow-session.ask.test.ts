import { describe, it, expect } from "vitest";
import { FakePtyManager, controlFakePty } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

function writesOf(pty: FakePtyManager, i = 0): string {
  return controlFakePty(pty.handles[i]).writtenChunks.map((b) => b.toString("utf8")).join("");
}

describe("ShadowSessionManager.ask", () => {
  it("writes the prompt and resolves with the captured action JSON", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");

    const p = m.ask("G1", { systemPrompt: "SYS", userPrompt: "hello", timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    controlFakePty(pty.handles[0]).emitData(
      Buffer.from('```orca:action\n{"kind":"answer_user_directly","body":"hi"}\n```\n')
    );

    const res = await p;
    expect(res.text).toBe('{"kind":"answer_user_directly","body":"hi"}');
    expect(writesOf(pty)).toContain("hello");
    expect(writesOf(pty)).toContain("SYS"); // system sent on first ask
  });

  it("does not re-return a previous turn's block", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");

    controlFakePty(pty.handles[0]).emitData(
      Buffer.from('```orca:action\n{"kind":"answer_user_directly","body":"one"}\n```\n')
    );
    const r1 = await m.ask("G1", { systemPrompt: "S", userPrompt: "q1", timeoutMs: 1000 });
    expect(r1.text).toContain("one");

    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "q2", timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    controlFakePty(pty.handles[0]).emitData(
      Buffer.from('```orca:action\n{"kind":"answer_user_directly","body":"two"}\n```\n')
    );
    const r2 = await p2;
    expect(r2.text).toContain("two");
  });

  it("rejects on timeout", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    await expect(
      m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
  });

  it("auto-spawns a session if ask is called before spawn", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    // NOTE: no explicit m.spawn("G1") here.
    const p = m.ask("G1", { systemPrompt: "S", userPrompt: "q", timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    controlFakePty(pty.handles[0]).emitData(
      Buffer.from('```orca:action\n{"ok":1}\n```\n')
    );
    expect((await p).text).toBe('{"ok":1}');
    expect(m.has("G1")).toBe(true);
  });
});
