import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex.js";
import type { RunCheckFn } from "./codex.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["codex"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/codex")) {
  return new CodexAdapter(resolved, run);
}

describe("CodexAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "codex 0.9.0", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.9.0");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new CodexAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("CodexAdapter.checkAuth", () => {
  it("exit 0 \u2192 ready", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "Logged in as shawn", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
  });

  it("exit non-zero + 'not logged in' stderr \u2192 needs_auth", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "you are not logged in", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("exit non-zero without auth pattern \u2192 misconfigured", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 2, stdout: "", stderr: "keychain unlock failed", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("timeout \u2192 misconfigured", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: undefined, stdout: "", stderr: "", durationMs: 5000, timedOut: true });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("invokes codex login status", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false });
    await a(run).checkAuth();
    expect(run).toHaveBeenCalledWith("/usr/bin/codex", ["login", "status"], expect.anything());
  });

  it("exit 0 with 'not logged in' stdout → needs_auth (not ready)", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "You are not logged in.", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("widened regex matches 'not yet authenticated'", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "You are not yet authenticated", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("widened regex matches 'not signed in'", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "you are not signed in", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });
});

describe("CodexAdapter.repairFor", () => {
  const adapter = new CodexAdapter(ok("/usr/bin/codex"), vi.fn());
  it("needs_auth \u2192 codex login", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "codex login" });
  });
});
