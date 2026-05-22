import { describe, expect, it } from "vitest";
import { ShellManualAdapter } from "./shell-manual.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["/bin/sh"] });

describe("ShellManualAdapter readiness", () => {
  it("checkInstalled reports ok when a shell resolves", async () => {
    const step = await new ShellManualAdapter(ok("/bin/bash")).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.detail).toBe("/bin/bash");
  });

  it("checkInstalled reports failure when no shell is found", async () => {
    const step = await new ShellManualAdapter(missing).checkInstalled();
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/no shell/i);
  });

  it("checkAuth reports misconfigured when no shell is found", async () => {
    const step = await new ShellManualAdapter(missing).checkAuth();
    expect(step.ok).toBe(false);
    expect(step.authStatus).toBe("misconfigured");
  });

  it("checkAuth reports ready when a shell resolves", async () => {
    const step = await new ShellManualAdapter(ok("/bin/sh")).checkAuth();
    expect(step.ok).toBe(true);
    expect(step.authStatus).toBe("ready");
  });
});
