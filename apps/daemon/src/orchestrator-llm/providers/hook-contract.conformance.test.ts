import { describe, it, expect } from "vitest";
import { conformanceError, assertHookContractConformance } from "./hook-contract.js";
import { resolveShadowProvider } from "./registry.js";
import type { HookAssumption } from "./types.js";

describe("hook contract self-conformance", () => {
  it("all three providers' declared contracts conform to their emitted config", () => {
    expect(() => assertHookContractConformance()).not.toThrow();
  });

  it("flags a declared event that is not in the emitted config", () => {
    const provider = resolveShadowProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "TotallyMadeUpEvent",
      file: "hooks.json", payloadFields: [], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/TotallyMadeUpEvent/);
  });

  it("flags a declared payload field absent from the emitted config", () => {
    const provider = resolveShadowProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "PermissionRequest",
      file: "hooks.json", payloadFields: ["no_such_field"], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/no_such_field/);
  });

  it("skips unverified entries (no emitted config to check)", () => {
    const provider = resolveShadowProvider("antigravity");
    const unverified: HookAssumption = {
      provider: "antigravity", surface: "worker", event: null, file: null,
      payloadFields: [], assertSpawnArg: null, firingContext: "unknown",
      verifiedAgainstVersion: null, verified: false, note: "fixture",
    };
    expect(conformanceError(provider, unverified)).toBeNull();
  });
});
