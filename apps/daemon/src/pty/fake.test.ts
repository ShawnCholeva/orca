import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePtyManager, controlFakePty } from "./fake.js";
import type { PtyHandle } from "./types.js";

const OPTS = {
  command: "/bin/sh",
  args: [],
  cwd: "/tmp",
  env: {},
  cols: 80,
  rows: 24,
};

describe("FakePtyManager", () => {
  let manager: FakePtyManager;

  beforeEach(() => {
    manager = new FakePtyManager();
  });

  afterEach(() => {
    manager.reset();
  });

  it("assigns a numeric pid", () => {
    const { handle } = manager.start(OPTS);
    expect(typeof handle.pid).toBe("number");
    expect(handle.pid).toBeGreaterThan(0);
  });

  it("onData: handler receives injected bytes", () => {
    const { handle: h, events } = manager.start(OPTS);
    const ctrl = controlFakePty(h);
    const received: Buffer[] = [];
    events.onData((chunk) => received.push(chunk));
    const expected = Buffer.from("hello");
    ctrl.emitData(expected);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expected);
  });

  it("onData disposer stops further delivery", () => {
    const { handle: h, events } = manager.start(OPTS);
    const ctrl = controlFakePty(h);
    const received: Buffer[] = [];
    const dispose = events.onData((chunk) => received.push(chunk));
    ctrl.emitData(Buffer.from("a"));
    dispose();
    ctrl.emitData(Buffer.from("b"));
    expect(received).toHaveLength(1);
  });

  it("onExit: handler fires once on emitExit", () => {
    const { handle: h, events } = manager.start(OPTS);
    const ctrl = controlFakePty(h);
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    events.onExit((e) => exits.push(e));
    ctrl.emitExit({ exitCode: 0, signal: null });
    ctrl.emitExit({ exitCode: 1, signal: null }); // second call is no-op
    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ exitCode: 0, signal: null });
  });

  it("kill('SIGKILL') triggers immediate exit with signal SIGKILL", () => {
    const { handle: h, events } = manager.start(OPTS);
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    events.onExit((e) => exits.push(e));
    h.kill("SIGKILL");
    expect(exits).toHaveLength(1);
    expect(exits[0]?.signal).toBe("SIGKILL");
    expect(exits[0]?.exitCode).toBeNull();
  });

  it("write after exit is a no-op (does not throw)", () => {
    const { handle: h } = manager.start(OPTS);
    const ctrl = controlFakePty(h);
    ctrl.emitExit({ exitCode: 0, signal: null });
    expect(() => h.write(Buffer.from("data"))).not.toThrow();
  });

  it("isDead reflects exit state", () => {
    const { handle: h } = manager.start(OPTS);
    const ctrl = controlFakePty(h);
    expect(ctrl.isDead).toBe(false);
    ctrl.emitExit({ exitCode: 0, signal: null });
    expect(ctrl.isDead).toBe(true);
  });

  it("controlFakePty throws for non-fake handles", () => {
    const fakeHandle = { pid: 99, write: () => {}, resize: () => {}, kill: () => {} } as PtyHandle;
    expect(() => controlFakePty(fakeHandle)).toThrow("not a FakePtyManager handle");
  });
});
