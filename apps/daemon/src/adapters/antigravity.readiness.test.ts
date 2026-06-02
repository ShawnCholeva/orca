import { describe, expect, it, vi } from "vitest";
import { AntigravityAdapter } from "./antigravity.js";
import type { RunCheckFn } from "./antigravity.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["agy"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/agy")) {
  return new AntigravityAdapter(resolved, run);
}

describe("AntigravityAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "agy 2.0.1",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("2.0.1");
    expect(run).toHaveBeenCalledWith("/usr/bin/agy", ["--version"], expect.anything());
  });

  it("returns missing on ENOENT", async () => {
    const step = await new AntigravityAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
    expect(step.command).toBe("agy --version");
  });
});

describe("AntigravityAdapter.checkAuth", () => {
  it("short prompt success means ready", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ORCA_AUTH_OK",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/agy",
      ["-p", "Reply exactly: ORCA_AUTH_OK"],
      expect.objectContaining({ timeoutMs: 8000 }),
    );
  });

  it("auth wording means needs_auth", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Please sign in with Google to continue.",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("unexpected failure means misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "keyring failed",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("timeout means misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      durationMs: 8000,
      timedOut: true,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });
});

describe("AntigravityAdapter.repairFor", () => {
  const adapter = new AntigravityAdapter(ok("/usr/bin/agy"), vi.fn());

  it("missing points to install docs", () => {
    expect(adapter.repairFor("missing")).toMatchObject({
      kind: "install_url",
      label: "Install Antigravity",
    });
  });

  it("needs_auth runs agy", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({
      kind: "run_command",
      command: "agy",
      label: "Sign in to Antigravity",
    });
  });
});
