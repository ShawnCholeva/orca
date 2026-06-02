import { afterEach, describe, expect, it } from "vitest";
import { runCheckCommand, inheritCredEnv } from "./exec.js";

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

describe("inheritCredEnv", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  for (const k of keys) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns only credential-locating env vars that are actually set", () => {
    for (const k of keys) delete process.env[k];
    process.env["HOME"] = "/home/x";
    process.env["USER"] = "orca";
    process.env["LOGNAME"] = "orca";
    process.env["XDG_CONFIG_HOME"] = "/home/x/.config";
    const env = inheritCredEnv();
    expect(env).toEqual({
      HOME: "/home/x",
      USER: "orca",
      LOGNAME: "orca",
      XDG_CONFIG_HOME: "/home/x/.config",
    });
  });

  it("returns empty when no cred env vars are set", () => {
    for (const k of keys) delete process.env[k];
    expect(inheritCredEnv()).toEqual({});
  });
});
