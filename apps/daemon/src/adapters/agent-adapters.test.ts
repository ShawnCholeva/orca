import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { OpenCodeAdapter } from "./opencode.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";
import type { ResolveBinaryResult, ResolveFn } from "./resolve.js";

function makeResolve(result: ResolveBinaryResult): ResolveFn {
  return (_candidates) => Promise.resolve(result);
}

function makeCapturingResolve(result: ResolveBinaryResult) {
  let captured: string[] = [];
  const fn: ResolveFn = (candidates) => {
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

interface AdapterCase {
  name: string;
  envKey: string;
  defaultBin: string;
  create(resolveFn: ResolveFn): AgentAdapter;
}

const ADAPTER_CASES: AdapterCase[] = [
  {
    name: "ClaudeCodeAdapter",
    envKey: "ORCA_CLAUDE_CODE_BIN",
    defaultBin: "claude",
    create: (fn) => new ClaudeCodeAdapter(fn),
  },
  {
    name: "OpenCodeAdapter",
    envKey: "ORCA_OPENCODE_BIN",
    defaultBin: "opencode",
    create: (fn) => new OpenCodeAdapter(fn),
  },
  {
    name: "CodexAdapter",
    envKey: "ORCA_CODEX_BIN",
    defaultBin: "codex",
    create: (fn) => new CodexAdapter(fn),
  },
];

for (const { name, envKey, defaultBin, create } of ADAPTER_CASES) {
  describe(name, () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[envKey];
      delete process.env[envKey];
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = savedEnv;
      }
    });

    describe("resolveSpawn", () => {
      it("returns resolved command", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn(INPUT);
        expect(result.command).toBe("/usr/local/bin/tool");
      });

      it("returns empty args array", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn(INPUT);
        expect(result.args).toEqual([]);
      });

      it("sets cwd to workspacePath", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn(INPUT);
        expect(result.cwd).toBe(INPUT.workspacePath);
      });

      it("emits ORCA_GOAL_ID and ORCA_SESSION_ID", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn(INPUT);
        expect(result.env["ORCA_GOAL_ID"]).toBe(INPUT.goalId);
        expect(result.env["ORCA_SESSION_ID"]).toBe(INPUT.sessionId);
      });

      it("includes ORCA_ROLE when role provided", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn({ ...INPUT, role: "Engineer" });
        expect(result.env["ORCA_ROLE"]).toBe("Engineer");
      });

      it("includes ORCA_INSTRUCTION when instruction provided", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.resolveSpawn({ ...INPUT, instruction: "Fix the bug" });
        expect(result.env["ORCA_INSTRUCTION"]).toBe("Fix the bug");
      });

      it("throws with code command_not_found when binary not found", async () => {
        const adapter = create(makeResolve({ error: "not_found", tried: [defaultBin] }));
        await expect(adapter.resolveSpawn(INPUT)).rejects.toMatchObject({ code: "command_not_found" });
      });

      it("env override is first candidate when set", async () => {
        process.env[envKey] = "/custom/override/bin";
        const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/custom/override/bin" });
        const adapter = create(fn);
        await adapter.resolveSpawn(INPUT);
        expect(getCaptured()[0]).toBe("/custom/override/bin");
      });

      it("default binary name is used as candidate when override not set", async () => {
        const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/usr/local/bin/" + defaultBin });
        const adapter = create(fn);
        await adapter.resolveSpawn(INPUT);
        expect(getCaptured()).toContain(defaultBin);
      });
    });

    describe("probeAvailability", () => {
      it("returns available when binary resolves", async () => {
        const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
        const result = await adapter.probeAvailability();
        expect(result.status).toBe("available");
      });

      it("returns unavailable with non-empty detail when binary not found", async () => {
        const adapter = create(makeResolve({ error: "not_found", tried: [defaultBin] }));
        const result = await adapter.probeAvailability();
        expect(result.status).toBe("unavailable");
        expect((result as { detail: string }).detail.length).toBeGreaterThan(0);
      });

      it("unavailable detail mentions the env override key", async () => {
        const adapter = create(makeResolve({ error: "not_found", tried: [] }));
        const result = await adapter.probeAvailability();
        expect(result.status).toBe("unavailable");
        expect((result as { detail: string }).detail).toContain(envKey.replace("ORCA_", "ORCA_").split("_BIN")[0].replace("ORCA_", ""));
      });
    });

  });
}
