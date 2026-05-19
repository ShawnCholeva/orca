import { describe, expect, it, beforeEach } from "vitest";
import { AdapterRegistry } from "./registry.js";
import { ShellManualAdapter } from "./shell-manual.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { OpenCodeAdapter } from "./opencode.js";
import { CodexAdapter } from "./codex.js";
import type { ResolveBinaryResult } from "./resolve.js";

function makeResolve(result: ResolveBinaryResult) {
  return (_candidates: string[]) => Promise.resolve(result);
}

const available = makeResolve({ resolvedPath: "/usr/local/bin/tool" });
const unavailable = makeResolve({ error: "not_found", tried: [] });

function makeRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ShellManualAdapter(available));
  registry.register(new ClaudeCodeAdapter(unavailable));
  registry.register(new OpenCodeAdapter(unavailable));
  registry.register(new CodexAdapter(unavailable));
  return registry;
}

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("lists exactly the four registered adapter ids", async () => {
    const summaries = await registry.list();
    const ids = summaries.map((s) => s.id).sort();
    expect(ids).toEqual(["claude-code", "codex", "opencode", "shell-manual"]);
  });

  it("get returns the adapter by id", () => {
    expect(registry.get("shell-manual")).toBeDefined();
    expect(registry.get("claude-code")).toBeDefined();
    expect(registry.get("opencode")).toBeDefined();
    expect(registry.get("codex")).toBeDefined();
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("unknown" as never)).toBeUndefined();
  });

  it("list returns availability from probeAvailability", async () => {
    const summaries = await registry.list();
    const shell = summaries.find((s) => s.id === "shell-manual");
    expect(shell?.availability).toBe("available");
    const claude = summaries.find((s) => s.id === "claude-code");
    expect(claude?.availability).toBe("unavailable");
  });

  it("caches availability — second list call does not re-probe", async () => {
    let probeCount = 0;
    const countingResolve = (_candidates: string[]) => {
      probeCount++;
      return Promise.resolve({ resolvedPath: "/bin/sh" } satisfies ResolveBinaryResult);
    };
    const reg = new AdapterRegistry();
    reg.register(new ShellManualAdapter(countingResolve));

    await reg.list();
    await reg.list();
    // probeAvailability called once per list() call, but the result is cached
    expect(probeCount).toBe(1);
  });

  it("clearCache causes re-probe on next list call", async () => {
    let probeCount = 0;
    const countingResolve = (_candidates: string[]) => {
      probeCount++;
      return Promise.resolve({ resolvedPath: "/bin/sh" } satisfies ResolveBinaryResult);
    };
    const reg = new AdapterRegistry();
    reg.register(new ShellManualAdapter(countingResolve));

    await reg.list();
    reg.clearCache();
    await reg.list();
    expect(probeCount).toBe(2);
  });
});
