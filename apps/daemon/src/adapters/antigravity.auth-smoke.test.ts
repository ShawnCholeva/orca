import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "./antigravity.js";

const runReal = process.env.ORCA_RUN_REAL_SMOKE === "1";

describe.skipIf(!runReal)("Antigravity real auth smoke", () => {
  it("checks installed and auth status against the real agy CLI", async () => {
    const adapter = new AntigravityAdapter();
    const installed = await adapter.checkInstalled();
    expect(installed.ok).toBe(true);
    const auth = await adapter.checkAuth();
    expect(["ready", "needs_auth", "misconfigured"]).toContain(auth.authStatus);
  });
});
