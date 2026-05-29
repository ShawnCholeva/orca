import { describe, it, expect } from "vitest";
import { FakePtyManager, controlFakePty } from "../pty/fake.js";
import { ShadowSessionManager } from "./shadow-session.js";

describe("ShadowSessionManager serialization", () => {
  it("two overlapping asks resolve in FIFO order with distinct blocks", async () => {
    const pty = new FakePtyManager();
    const m = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
      pollIntervalMs: 1,
    });
    await m.spawn("G1");
    const ctl = controlFakePty(pty.handles[0]);

    const p1 = m.ask("G1", { systemPrompt: "S", userPrompt: "first", timeoutMs: 1000 });
    const p2 = m.ask("G1", { systemPrompt: "S", userPrompt: "second", timeoutMs: 1000 });

    await new Promise((r) => setTimeout(r, 5));
    ctl.emitData(Buffer.from('```orca:action\n{"n":1}\n```\n'));
    expect((await p1).text).toBe('{"n":1}');

    await new Promise((r) => setTimeout(r, 5));
    ctl.emitData(Buffer.from('```orca:action\n{"n":2}\n```\n'));
    expect((await p2).text).toBe('{"n":2}');
  });
});
