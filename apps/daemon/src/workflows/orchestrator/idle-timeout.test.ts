import { describe, expect, it, vi } from "vitest";
import { startIdleTimeoutWatcher } from "./idle-timeout.js";

describe("idle timeout watcher", () => {
  it("fires onIdle after idleMs of no activity", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watcher = startIdleTimeoutWatcher({ sessionId: "s1", onIdle, idleMs: 90_000 });
    vi.advanceTimersByTime(89_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.stop();
    vi.useRealTimers();
  });

  it("ping resets the timer", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watcher = startIdleTimeoutWatcher({ sessionId: "s1", onIdle, idleMs: 90_000 });
    vi.advanceTimersByTime(80_000);
    watcher.ping();
    vi.advanceTimersByTime(80_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.stop();
    vi.useRealTimers();
  });

  it("stop prevents onIdle from firing", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watcher = startIdleTimeoutWatcher({ sessionId: "s1", onIdle, idleMs: 90_000 });
    watcher.stop();
    vi.advanceTimersByTime(200_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
