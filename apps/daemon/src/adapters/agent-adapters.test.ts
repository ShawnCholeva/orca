import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { MODELS_BY_AGENT_ID, PROVIDER_BY_AGENT_ID, adapterSupportsModel } from "./model-catalog.js";
import type { AgentAdapter } from "./types.js";
import { resolveBinary } from "./resolve.js";
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
    name: "CodexAdapter",
    envKey: "ORCA_CODEX_BIN",
    defaultBin: "codex",
    create: (fn) => new CodexAdapter(fn),
  },
];

async function createFakeExecutable(prefix: string): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(dir, "fake-adapter");
  await writeFile(filePath, "#!/bin/sh\necho hello\nexit 0\n", { mode: 0o755 });
  await chmod(filePath, 0o755);
  return { dir, filePath };
}

for (const { name, envKey, defaultBin, create } of ADAPTER_CASES) {
  describe(name, () => {
    let savedEnv: string | undefined;
    const tmpDirs: string[] = [];

    beforeEach(() => {
      savedEnv = process.env[envKey];
      delete process.env[envKey];
    });

    afterEach(async () => {
      if (savedEnv === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = savedEnv;
      }
      await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

      it("passes HOME and interactive vars so ~/.claude auth/hooks resolve", async () => {
        const prevHome = process.env["HOME"];
        const prevTerm = process.env["TERM"];
        process.env["HOME"] = "/home/test-user";
        process.env["TERM"] = "xterm-256color";
        try {
          const adapter = create(makeResolve({ resolvedPath: "/usr/local/bin/tool" }));
          const result = await adapter.resolveSpawn(INPUT);
          expect(result.env["HOME"]).toBe("/home/test-user");
          expect(result.env["TERM"]).toBe("xterm-256color");
        } finally {
          if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
          if (prevTerm === undefined) delete process.env["TERM"]; else process.env["TERM"] = prevTerm;
        }
      });

      it("throws with code command_not_found when binary not found", async () => {
        const adapter = create(makeResolve({ error: "not_found", tried: [defaultBin] }));
        await expect(adapter.resolveSpawn(INPUT)).rejects.toMatchObject({ code: "command_not_found" });
      });

      it("env override is the only candidate when set", async () => {
        process.env[envKey] = "/custom/override/bin";
        const { fn, getCaptured } = makeCapturingResolve({ resolvedPath: "/custom/override/bin" });
        const adapter = create(fn);
        await adapter.resolveSpawn(INPUT);
        expect(getCaptured()).toEqual(["/custom/override/bin"]);
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

      it("returns available when env override points at an executable script", async () => {
        const fake = await createFakeExecutable(envKey.toLowerCase());
        tmpDirs.push(fake.dir);
        process.env[envKey] = fake.filePath;

        const adapter = create(resolveBinary);
        const result = await adapter.probeAvailability();

        expect(result.status).toBe("available");
      });

      it("returns unavailable when env override points at a missing binary", async () => {
        process.env[envKey] = "/no/such/binary";
        const { fn, getCaptured } = makeCapturingResolve({ error: "not_found", tried: ["/no/such/binary"] });
        const adapter = create(fn);

        const result = await adapter.probeAvailability();

        expect(getCaptured()).toEqual(["/no/such/binary"]);
        expect(result.status).toBe("unavailable");
        expect((result as { detail: string }).detail).toContain("/no/such/binary");
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

describe("adapter supportsModel", () => {
  it("maps Antigravity to Google provider metadata", () => {
    expect(PROVIDER_BY_AGENT_ID.antigravity).toBe("orca/google");
    expect(MODELS_BY_AGENT_ID.antigravity?.map((m) => m.id)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3-flash",
    ]);
    expect(adapterSupportsModel("antigravity", "gemini-3.5-flash")).toBe(true);
  });

  it("claude-code supports the haiku/sonnet/opus models referenced by engineering v4", () => {
    const a = new ClaudeCodeAdapter();
    expect(a.supportsModel("claude-haiku-4-5")).toBe(true);
    expect(a.supportsModel("claude-sonnet-4-6")).toBe(true);
    expect(a.supportsModel("claude-opus-4-7")).toBe(true);
  });

  it("codex supports the models exposed by the Codex model menu", () => {
    const a = new CodexAdapter();
    expect(a.supportsModel("gpt-5.5")).toBe(true);
    expect(a.supportsModel("gpt-5.4")).toBe(true);
    expect(a.supportsModel("gpt-5.4-mini")).toBe(true);
    expect(a.supportsModel("gpt-5.3-codex")).toBe(true);
    expect(a.supportsModel("gpt-5.2")).toBe(true);
  });

  it("codex rejects unknown model ids", () => {
    expect(new CodexAdapter().supportsModel("anything")).toBe(false);
  });
});

describe("adapter supportedExecutionModes", () => {
  it("claude-code declares shadow_session and one_shot", () => {
    expect(new ClaudeCodeAdapter().supportedExecutionModes).toEqual(
      expect.arrayContaining(["shadow_session", "one_shot"])
    );
  });
  it("codex declares one_shot and shadow_session", () => {
    expect(new CodexAdapter().supportedExecutionModes).toEqual(
      expect.arrayContaining(["one_shot", "shadow_session"])
    );
  });
});
