import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShellManualAdapter } from "./shell-manual.js";
import type { ResolveBinaryResult } from "./resolve.js";

function makeResolve(result: ResolveBinaryResult) {
  return (_candidates: string[]) => Promise.resolve(result);
}

function makeCapturingResolve(result: ResolveBinaryResult) {
  let captured: string[] = [];
  const fn = (candidates: string[]) => {
    captured = candidates;
    return Promise.resolve(result);
  };
  return { fn, getCaptured: () => captured };
}

const INPUT = {
  goalId: "goal-1",
  sessionId: "sess-1",
  workspacePath: "/workspace/repo",
};

describe("ShellManualAdapter", () => {
  let savedOrcaShell: string | undefined;
  let savedShell: string | undefined;

  beforeEach(() => {
    savedOrcaShell = process.env["ORCA_SHELL"];
    savedShell = process.env["SHELL"];
    delete process.env["ORCA_SHELL"];
    delete process.env["SHELL"];
  });

  afterEach(() => {
    if (savedOrcaShell === undefined) {
      delete process.env["ORCA_SHELL"];
    } else {
      process.env["ORCA_SHELL"] = savedOrcaShell;
    }
    if (savedShell === undefined) {
      delete process.env["SHELL"];
    } else {
      process.env["SHELL"] = savedShell;
    }
  });

  describe("resolveSpawn", () => {
    it("returns the resolved shell command", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.command).toBe("/bin/sh");
    });

    it("returns empty args", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.args).toEqual([]);
    });

    it("sets cwd to workspacePath", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.cwd).toBe(INPUT.workspacePath);
    });

    it("emits ORCA_GOAL_ID and ORCA_SESSION_ID in env", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.env["ORCA_GOAL_ID"]).toBe(INPUT.goalId);
      expect(result.env["ORCA_SESSION_ID"]).toBe(INPUT.sessionId);
    });

    it("omits ORCA_ROLE when role not provided", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.env["ORCA_ROLE"]).toBeUndefined();
    });

    it("includes ORCA_ROLE when role is provided", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn({ ...INPUT, role: "Architect" });
      expect(result.env["ORCA_ROLE"]).toBe("Architect");
    });

    it("includes ORCA_INSTRUCTION when instruction is provided", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn({ ...INPUT, instruction: "Do the thing" });
      expect(result.env["ORCA_INSTRUCTION"]).toBe("Do the thing");
    });

    it("omits ORCA_INSTRUCTION when instruction not provided", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.resolveSpawn(INPUT);
      expect(result.env["ORCA_INSTRUCTION"]).toBeUndefined();
    });

    it("throws with code command_not_found when no shell resolved", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ error: "not_found", tried: ["/bin/sh"] }));
      await expect(adapter.resolveSpawn(INPUT)).rejects.toMatchObject({ code: "command_not_found" });
    });

    it("ORCA_SHELL overrides SHELL — candidate order puts ORCA_SHELL first", async () => {
      process.env["ORCA_SHELL"] = "/custom/shell";
      process.env["SHELL"] = "/other/shell";
      const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/custom/shell" });
      const adapter = new ShellManualAdapter(fn);
      await adapter.resolveSpawn(INPUT);
      const candidates = getCaptured();
      expect(candidates[0]).toBe("/custom/shell");
    });

    it("SHELL is included as second candidate when ORCA_SHELL not set", async () => {
      process.env["SHELL"] = "/usr/bin/zsh";
      const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/usr/bin/zsh" });
      const adapter = new ShellManualAdapter(fn);
      await adapter.resolveSpawn(INPUT);
      const candidates = getCaptured();
      expect(candidates[0]).toBe("/usr/bin/zsh");
    });

    it("falls back to built-in shell list when neither ORCA_SHELL nor SHELL set", async () => {
      const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/bin/sh" });
      const adapter = new ShellManualAdapter(fn);
      await adapter.resolveSpawn(INPUT);
      const candidates = getCaptured();
      // POSIX: should have the hardcoded fallbacks
      expect(candidates).toContain("/bin/sh");
    });
  });

  describe("probeAvailability", () => {
    it("returns available when shell resolves", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ resolvedPath: "/bin/sh" }));
      const result = await adapter.probeAvailability();
      expect(result.status).toBe("available");
    });

    it("returns unavailable with detail when no shell found", async () => {
      const adapter = new ShellManualAdapter(makeResolve({ error: "not_found", tried: ["/bin/sh"] }));
      const result = await adapter.probeAvailability();
      expect(result.status).toBe("unavailable");
      expect((result as { detail: string }).detail).toBeTruthy();
    });
  });
});
