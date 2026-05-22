import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { RunCheckFn } from "./claude-code.js";

const ok = (path: string) => () => Promise.resolve({ resolvedPath: path });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["claude"] });

function adapter(run: RunCheckFn, resolved = ok("/usr/bin/claude")) {
  return new ClaudeCodeAdapter(resolved, run);
}

describe("ClaudeCodeAdapter.checkInstalled", () => {
  it("reports installed + version on exit 0", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "claude 1.2.3\n",
      stderr: "",
      durationMs: 10,
      timedOut: false,
    });
    const step = await adapter(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("1.2.3");
  });

  it("reports missing on ENOENT", async () => {
    const step = await new ClaudeCodeAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/not found/i);
  });
});

describe("ClaudeCodeAdapter.checkAuth", () => {
  it("classifies loggedIn=true JSON as ready", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, account: "shawn@example.com" }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.ok).toBe(true);
    // PII never persisted on success
    expect(step.errorOutput).toBeUndefined();
    expect(step.detail).toBe("authenticated");
  });

  it("classifies loggedIn=false JSON as needs_auth (exit 1)", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("classifies loggedIn=false JSON as needs_auth even if exit code is unexpected (exit 0)", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("classifies invalid JSON / unexpected exit as misconfigured", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 2,
      stdout: "panic: keychain locked",
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
    expect(step.errorOutput).toBeDefined();
  });

  it("classifies timeout as misconfigured", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      durationMs: 5000,
      timedOut: true,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
    expect(step.detail).toMatch(/timeout/i);
  });

  it("invokes claude auth status --json", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '{"loggedIn":true}',
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    await adapter(run).checkAuth();
    expect(run).toHaveBeenCalledWith("/usr/bin/claude", ["auth", "status", "--json"], expect.anything());
  });
});

describe("ClaudeCodeAdapter.repairFor", () => {
  const a = new ClaudeCodeAdapter(ok("/usr/bin/claude"), vi.fn());
  it("missing → install_url", () => {
    expect(a.repairFor("missing")).toMatchObject({ kind: "install_url" });
  });
  it("needs_auth → run_command with claude auth login", () => {
    expect(a.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "claude auth login" });
  });
  it("ready returns undefined", () => {
    expect(a.repairFor("ready")).toBeUndefined();
  });
});
