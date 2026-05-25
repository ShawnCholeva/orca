import { describe, expect, it } from "vitest";

import { AdapterRegistry } from "../../../adapters/registry.js";
import type { AgentAdapter } from "../../../adapters/types.js";
import { getOneShotAllowlist, resolveOneShotRunner } from "./registry.js";
import type { OneShotAllowedAdapterId, OneShotRunner } from "./types.js";

function makeAdapter(id: AgentAdapter["id"]): AgentAdapter {
  return {
    id,
    title: `${id} adapter`,
    contextDelivery: { mode: "preview_only", maxBytes: 1024 },
    resolveSpawn: async () => ({ command: id, args: [], env: {}, cwd: "/tmp" }),
    probeAvailability: async () => ({ status: "available" }),
    checkInstalled: async () => ({ name: "installed", ok: true, command: `${id} --version` }),
    checkAuth: async () => ({
      name: "authenticated",
      ok: true,
      authStatus: "ready",
      command: `${id} auth status`,
    }),
    repairFor: () => undefined,
  };
}

function makeRunner(adapterId: OneShotAllowedAdapterId): OneShotRunner {
  return {
    adapterId,
    run: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      latencyMs: 1,
    }),
  };
}

describe("one-shot registry", () => {
  it("allowlists OpenAI and Gemini and excludes Claude", () => {
    const allowlist = getOneShotAllowlist();
    expect(allowlist["orca/openai"]).toBe("codex");
    expect(allowlist["orca/google-gemini"]).toBe("gemini-cli");
    expect(allowlist["orca/anthropic"]).toBeUndefined();
  });

  it("returns unavailable when provider is excluded by policy allowlist", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("claude-code"));

    const result = await resolveOneShotRunner("orca/anthropic", {
      adapterRegistry: registry,
      readinessLookup: async () => ({ status: "ready" }),
      runners: { codex: makeRunner("codex"), "gemini-cli": makeRunner("gemini-cli") },
    });

    expect(result).toEqual({
      status: "unavailable",
      providerId: "orca/anthropic",
      failureReason: "one_shot_unavailable",
    });
  });

  it("returns unavailable when allowlisted adapter is not registered", async () => {
    const result = await resolveOneShotRunner("orca/openai", {
      adapterRegistry: new AdapterRegistry(),
      readinessLookup: async () => ({ status: "ready" }),
      runners: { codex: makeRunner("codex") },
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.failureReason).toBe("one_shot_unavailable");
    }
  });

  it("returns unavailable when adapter readiness is not ready", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex"));

    const result = await resolveOneShotRunner("orca/openai", {
      adapterRegistry: registry,
      readinessLookup: async () => ({ status: "needs_auth" }),
      runners: { codex: makeRunner("codex") },
    });

    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when command strategy runner is missing", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex"));

    const result = await resolveOneShotRunner("orca/openai", {
      adapterRegistry: registry,
      readinessLookup: async () => ({ status: "ready" }),
      runners: {},
    });

    expect(result.status).toBe("unavailable");
  });

  it("returns available runner when all verification checks pass", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex"));

    const result = await resolveOneShotRunner("orca/openai", {
      adapterRegistry: registry,
      readinessLookup: async () => ({ status: "ready" }),
      runners: { codex: makeRunner("codex") },
    });

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.adapterId).toBe("codex");
    }
  });
});
