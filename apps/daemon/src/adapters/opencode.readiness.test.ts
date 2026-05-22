import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "./opencode.js";
import type { RunCheckFn } from "./opencode.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["opencode"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/opencode")) {
  return new OpenCodeAdapter(resolved, run);
}

describe("OpenCodeAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "opencode 0.4.1\n", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.4.1");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new OpenCodeAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("OpenCodeAdapter.checkAuth", () => {
  it("positive credential count → ready without persisting provider names", async () => {
    const stdout = [
      "┌  Credentials ~/.local/share/opencode/auth.json",
      "│",
      "●  MiniMax Token Plan (minimaxi.com) api",
      "│",
      "●  OpenAI oauth",
      "│",
      "2 credentials",
      "└",
    ].join("\n");
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toBe("authenticated (2 credentials)");
  });

  it("'0 credentials' footer or empty list → needs_auth", async () => {
    const stdout = "No credentials stored\n0 credentials\n";
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("empty stdout but exit 0 → needs_auth", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("exit non-zero → misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 2, stdout: "", stderr: "config parse error", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("invokes opencode auth list with --pure to avoid plugin loading", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "1 credentials", stderr: "", durationMs: 1, timedOut: false });
    await a(run).checkAuth();
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/opencode",
      ["auth", "list", "--pure"],
      expect.anything(),
    );
  });
});

describe("OpenCodeAdapter.repairFor", () => {
  const adapter = new OpenCodeAdapter(ok("/usr/bin/opencode"), vi.fn());
  it("needs_auth → opencode auth login", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "opencode auth login" });
  });
});
