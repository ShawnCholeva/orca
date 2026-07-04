import { describe, it, expect } from "vitest";
import { resolveStartupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS } from "./shadow-session.js";

describe("resolveStartupTimeoutMs (deps > env > default)", () => {
  it("prefers an explicit, positive deps value", () => {
    expect(resolveStartupTimeoutMs(12345, {})).toBe(12345);
    // env is ignored when deps is set
    expect(resolveStartupTimeoutMs(12345, { ORCA_SHADOW_STARTUP_TIMEOUT_MS: "99999" })).toBe(12345);
  });

  it("honors ORCA_SHADOW_STARTUP_TIMEOUT_MS when deps is unset", () => {
    expect(resolveStartupTimeoutMs(undefined, { ORCA_SHADOW_STARTUP_TIMEOUT_MS: "60000" })).toBe(60000);
  });

  it("falls back to a 45000ms default (raised from 20000) when neither is usable", () => {
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBe(45_000);
    expect(resolveStartupTimeoutMs(undefined, {})).toBe(45_000);
    expect(resolveStartupTimeoutMs(undefined, { ORCA_SHADOW_STARTUP_TIMEOUT_MS: "notanumber" })).toBe(45_000);
    expect(resolveStartupTimeoutMs(0, {})).toBe(45_000); // non-positive deps ignored
  });
});
