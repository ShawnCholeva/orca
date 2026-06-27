import { describe, it, expect } from "vitest";
import { conformanceError, assertHookContractConformance } from "./hook-contract.js";
import { resolveAgentProvider } from "./registry.js";
import type { HookAssumption, AgentProvider } from "./types.js";

describe("hook contract self-conformance", () => {
  it("all three providers' declared contracts conform to their emitted config", () => {
    expect(() => assertHookContractConformance()).not.toThrow();
  });

  it("flags a declared event that is not in the emitted config", () => {
    const provider = resolveAgentProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "TotallyMadeUpEvent",
      file: "hooks.json", payloadFields: [], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/TotallyMadeUpEvent/);
  });

  it("flags a declared payload field absent from the emitted config", () => {
    const provider = resolveAgentProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "PermissionRequest",
      file: "hooks.json", payloadFields: ["no_such_field"], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/no_such_field/);
  });

  it("skips unverified entries (no emitted config to check)", () => {
    const provider = resolveAgentProvider("antigravity");
    const unverified: HookAssumption = {
      provider: "antigravity", surface: "worker", event: null, file: null,
      payloadFields: [], assertSpawnArg: null, firingContext: "unknown",
      verifiedAgainstVersion: null, verified: false, note: "fixture",
    };
    expect(conformanceError(provider, unverified)).toBeNull();
  });

  it("does not accept StopFailure as conformance for a declared Stop event", () => {
    function stubOrchestratorProvider(contents: string): AgentProvider {
      return { hookConfig: () => ({ files: [{ relPath: "hooks.json", contents }] }) } as unknown as AgentProvider;
    }

    const entry: HookAssumption = {
      provider: "codex", surface: "orchestrator", event: "Stop", file: "hooks.json",
      payloadFields: [], assertSpawnArg: null, firingContext: "x",
      verifiedAgainstVersion: null, verified: true, note: "fixture",
    };
    // Only StopFailure present → a declared Stop must be flagged as drift.
    expect(conformanceError(stubOrchestratorProvider('{ "StopFailure": [] }'), entry)).toMatch(/Stop/);
    // A real Stop key present → conforms.
    expect(conformanceError(stubOrchestratorProvider('{ "Stop": [] }'), entry)).toBeNull();
  });

  it("flags a missing declared spawn arg", () => {
    const provider = resolveAgentProvider("codex");
    const entry: HookAssumption = {
      provider: "codex", surface: "worker", event: "PermissionRequest", file: "hooks.json",
      payloadFields: [], assertSpawnArg: "--no-such-flag", firingContext: "x",
      verifiedAgainstVersion: "0.136.0", verified: true, note: "fixture",
    };
    expect(conformanceError(provider, entry)).toMatch(/--no-such-flag/);
  });
});
