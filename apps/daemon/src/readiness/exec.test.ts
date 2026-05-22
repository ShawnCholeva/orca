import { describe, expect, it } from "vitest";
import { runCheckCommand } from "./exec.js";

describe("runCheckCommand", () => {
  it("returns exit 0 and stdout for a trivial command", async () => {
    const res = await runCheckCommand("node", ["-e", "process.stdout.write('hi')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
    expect(res.timedOut).toBe(false);
  });

  it("captures stderr and a non-zero exit code without throwing", async () => {
    const res = await runCheckCommand("node", [
      "-e",
      "process.stderr.write('boom'); process.exit(7)",
    ]);
    expect(res.exitCode).toBe(7);
    expect(res.stderr.trim()).toBe("boom");
  });

  it("returns timedOut: true when the child exceeds the timeout", async () => {
    const res = await runCheckCommand("node", ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
  });

  it("returns ENOENT-style failure for a missing binary", async () => {
    const res = await runCheckCommand("definitely-not-a-real-binary-orca-xyz", ["--version"]);
    expect(res.exitCode).toBeUndefined();
    expect(res.failureKind).toBe("spawn");
    expect(res.spawnError?.code).toBe("ENOENT");
  });

  it("classifies maxBuffer overflows distinctly", async () => {
    const res = await runCheckCommand("node", [
      "-e",
      "process.stdout.write('x'.repeat(1024*1024))",
    ]);
    expect(res.failureKind).toBe("max_buffer");
  });

  it("honors an env allowlist (does not leak HOME by default)", async () => {
    const res = await runCheckCommand("node", ["-e", "process.stdout.write(String(!!process.env.HOME))"]);
    expect(res.stdout.trim()).toBe("false");
  });

  it("can pass through specific env vars when asked", async () => {
    const res = await runCheckCommand(
      "node",
      ["-e", "process.stdout.write(String(process.env.ORCA_TEST))"],
      { env: { ORCA_TEST: "1" } },
    );
    expect(res.stdout.trim()).toBe("1");
  });
});
