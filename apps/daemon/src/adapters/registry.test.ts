import { describe, expect, it, beforeEach } from "vitest";
import { AdapterRegistry } from "./registry.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { AntigravityAdapter } from "./antigravity.js";
import type { ResolveBinaryResult, ResolveFn } from "./resolve.js";

function makeResolve(result: ResolveBinaryResult): ResolveFn {
  return (_candidates) => Promise.resolve(result);
}

const available = makeResolve({ resolvedPath: "/usr/local/bin/tool" });
const unavailable = makeResolve({ error: "not_found", tried: [] });

function makeRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter(available));
  registry.register(new CodexAdapter(unavailable));
  registry.register(new AntigravityAdapter(available));
  return registry;
}

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("lists exactly the registered adapter ids", async () => {
    const summaries = await registry.list();
    const ids = summaries.map((s) => s.id).sort();
    expect(ids).toEqual(["antigravity", "claude-code", "codex"]);
  });

  it("get returns the adapter by id", () => {
    expect(registry.get("claude-code")).toBeDefined();
    expect(registry.get("codex")).toBeDefined();
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("unknown" as never)).toBeUndefined();
  });

  it("list returns availability from probeAvailability", async () => {
    const summaries = await registry.list();
    const claude = summaries.find((s) => s.id === "claude-code");
    expect(claude?.availability).toBe("available");
    const codex = summaries.find((s) => s.id === "codex");
    expect(codex?.availability).toBe("unavailable");
  });

  it("caches availability — second list call does not re-probe", async () => {
    let probeCount = 0;
    const countingResolve = (_candidates: string[]) => {
      probeCount++;
      return Promise.resolve({ resolvedPath: "/bin/sh" } satisfies ResolveBinaryResult);
    };
    const reg = new AdapterRegistry();
    reg.register(new ClaudeCodeAdapter(countingResolve));

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
    reg.register(new ClaudeCodeAdapter(countingResolve));

    await reg.list();
    reg.clearCache();
    await reg.list();
    expect(probeCount).toBe(2);
  });
});
