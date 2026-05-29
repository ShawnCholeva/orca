import { describe, expect, it } from "vitest";
import { incrementCrashRetry, CRASH_RETRY_CAP } from "./crash-retry.js";

describe("crash retry counter", () => {
  it("cap is 3", () => {
    expect(CRASH_RETRY_CAP).toBe(3);
  });
  it("first retry: nextAttempt 1, not capped", () => {
    const r = incrementCrashRetry(0);
    expect(r.nextAttempt).toBe(1);
    expect(r.capReached).toBe(false);
  });
  it("third retry reaches cap", () => {
    expect(incrementCrashRetry(2).capReached).toBe(true);
  });
});
