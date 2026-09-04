import { describe, expect, it } from "vitest";
import { incrementCrashRetry, isSubstrateRelaunch, CRASH_RETRY_CAP } from "./crash-retry.js";

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

describe("isSubstrateRelaunch", () => {
  const BOOT = "2026-09-03T05:09:59.000Z";

  it("is true for a session that started under a previous daemon process", () => {
    // The founder's run 7: triage spawned at 05:07:09, the daemon reloaded at
    // 05:09:59 (a teammate's commit triggering tsx watch), and the worker was
    // reaped shortly after. The agent never failed — the substrate went away.
    expect(isSubstrateRelaunch("2026-09-03T05:07:09.000Z", BOOT)).toBe(true);
  });

  it("is false for a session that both started and died under this process", () => {
    // A genuine crash still pays from the budget: that IS evidence about the agent.
    expect(isSubstrateRelaunch("2026-09-03T05:11:09.000Z", BOOT)).toBe(false);
  });

  it("is false when the session never recorded a start", () => {
    // markRunning writes started_at, so a null means the worker never got that far.
    // Guessing "substrate" there would hand out unlimited retries to a worker that
    // cannot start at all — the failure the budget exists to stop.
    expect(isSubstrateRelaunch(null, BOOT)).toBe(false);
    expect(isSubstrateRelaunch(undefined, BOOT)).toBe(false);
  });
});
