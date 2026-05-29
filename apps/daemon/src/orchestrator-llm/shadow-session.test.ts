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

describe("ShadowSessionManager spawn", () => {
  it("spawns one PTY per goal and is idempotent", async () => {
    const { pty, m } = mgr();
    const a = await m.spawn("G1");
    const b = await m.spawn("G1");
    expect(a).toBe(b);
    expect(pty.handles.length).toBe(1);
  });

  it("has() reflects lifecycle; terminate kills the handle", async () => {
    const { pty, m } = mgr();
    await m.spawn("G1");
    expect(m.has("G1")).toBe(true);
    await m.terminate("G1");
    expect(m.has("G1")).toBe(false);
    expect(controlFakePty(pty.handles[0]).isDead).toBe(true);
  });
});
