import { describe, it, expect } from "vitest";
import { resolveAgentProvider } from "./registry.js";

describe("hookContract declarations", () => {
  it("Codex declares a verified worker PermissionRequest with payload fields and the bypass spawn arg", () => {
    const entries = resolveAgentProvider("codex").hookContract();
    const perm = entries.find((e) => e.surface === "worker" && e.event === "PermissionRequest");
    expect(perm).toBeDefined();
    expect(perm!.verified).toBe(true);
    expect(perm!.file).toBe("hooks.json");
    expect(perm!.payloadFields).toEqual(
      expect.arrayContaining(["tool_name", "tool_input", "session_id", "turn_id"]),
    );
    expect(perm!.assertSpawnArg).toBe("--dangerously-bypass-hook-trust");
    expect(perm!.verifiedAgainstVersion).toBe("0.136.0");
  });

  it("Antigravity declares Stop verified but the worker permission surface unverified", () => {
    const entries = resolveAgentProvider("antigravity").hookContract();
    const stop = entries.find((e) => e.surface === "orchestrator" && e.event === "Stop");
    const worker = entries.find((e) => e.surface === "worker");
    expect(stop!.verified).toBe(true);
    expect(worker!.verified).toBe(false);
    expect(worker!.event).toBeNull();
    expect(worker!.note).toMatch(/unknown/i);
  });

  it("Claude declares verified orchestrator + worker Stop and PermissionRequest entries", () => {
    const entries = resolveAgentProvider("claude-code").hookContract();
    expect(entries.some((e) => e.surface === "orchestrator" && e.event === "Stop")).toBe(true);
    expect(entries.some((e) => e.surface === "worker" && e.event === "PermissionRequest")).toBe(true);
    expect(entries.every((e) => e.provider === "claude-code")).toBe(true);
  });
});
