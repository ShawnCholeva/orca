import { describe, expect, it } from "vitest";
import type { RunCheckResult } from "./exec.js";
import { checkTmuxReadiness, tmuxRepairFor } from "./system.js";

const CLOCK = () => "2026-01-01T00:00:00.000Z";

function result(partial: Partial<RunCheckResult>): RunCheckResult {
  return { stdout: "", stderr: "", durationMs: 1, timedOut: false, ...partial };
}

describe("checkTmuxReadiness", () => {
  it("reports ready and parses the version when tmux -V succeeds", async () => {
    const report = await checkTmuxReadiness(
      async () => result({ exitCode: 0, stdout: "tmux 3.4\n" }),
      CLOCK,
    );
    expect(report.status).toBe("ready");
    expect(report.dependency).toBe("tmux");
    expect(report.version).toBe("3.4");
    expect(report.steps[0].ok).toBe(true);
    expect(report.repair).toBeUndefined();
  });

  it("reports missing with a repair hint when tmux is not on PATH", async () => {
    const report = await checkTmuxReadiness(
      async () => result({ failureKind: "spawn", spawnError: { code: "ENOENT", message: "not found" } }),
      CLOCK,
    );
    expect(report.status).toBe("missing");
    expect(report.steps[0].ok).toBe(false);
    expect(report.repair).toBeDefined();
  });

  it("reports failed when tmux -V times out", async () => {
    const report = await checkTmuxReadiness(
      async () => result({ timedOut: true, failureKind: "timeout" }),
      CLOCK,
    );
    expect(report.status).toBe("failed");
    expect(report.repair).toBeDefined();
  });

  it("reports failed on a non-zero exit", async () => {
    const report = await checkTmuxReadiness(
      async () => result({ exitCode: 1, stderr: "boom", failureKind: "exit" }),
      CLOCK,
    );
    expect(report.status).toBe("failed");
  });
});

describe("tmuxRepairFor", () => {
  it("uses Homebrew on macOS", () => {
    const repair = tmuxRepairFor("darwin");
    expect(repair.kind).toBe("run_command");
    expect(repair.command).toContain("brew install tmux");
  });

  it("uses a package-manager command on Linux", () => {
    const repair = tmuxRepairFor("linux");
    expect(repair.kind).toBe("run_command");
    expect(repair.command).toContain("tmux");
  });

  it("falls back to an install URL on Windows", () => {
    const repair = tmuxRepairFor("win32");
    expect(repair.kind).toBe("install_url");
    expect(repair.url).toMatch(/^https?:\/\//);
  });
});
