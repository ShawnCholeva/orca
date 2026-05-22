import { describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "./opencode.js";
import { sanitizeOutput } from "../readiness/sanitize.js";

const runGated = process.env["ORCA_RUN_REAL_SMOKE"] === "1" ? describe : describe.skip;

runGated("opencode auth status (real)", () => {
  it("classifies into ready | needs_auth | misconfigured within budget", async () => {
    const adapter = new OpenCodeAdapter();
    const start = Date.now();
    const step = await adapter.checkAuth();
    expect(Date.now() - start).toBeLessThan(6000);
    expect(["ready", "needs_auth", "misconfigured"]).toContain(step.authStatus);
    if (step.errorOutput) {
      expect(step.errorOutput).toBe(sanitizeOutput(step.errorOutput));
    }
  });
});
