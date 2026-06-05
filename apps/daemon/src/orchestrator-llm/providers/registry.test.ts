import { describe, it, expect } from "vitest";
import { resolveShadowProvider } from "./registry.js";

describe("resolveShadowProvider", () => {
  it("returns the claude-code provider exposing the interface members", () => {
    const provider = resolveShadowProvider("claude-code");
    expect(provider.id).toBe("claude-code");
    expect(typeof provider.displayName).toBe("string");
    expect(typeof provider.modelProviderId).toBe("string");
    expect(typeof provider.launch).toBe("function");
    expect(typeof provider.hookConfig).toBe("function");
    expect(typeof provider.captureMode).toBe("function");
    expect(typeof provider.turnParser).toBe("function");
  });

  it("returns the codex provider exposing the interface members", () => {
    const provider = resolveShadowProvider("codex");
    expect(provider.id).toBe("codex");
    expect(typeof provider.displayName).toBe("string");
    expect(typeof provider.modelProviderId).toBe("string");
    expect(typeof provider.launch).toBe("function");
    expect(typeof provider.hookConfig).toBe("function");
    expect(typeof provider.captureMode).toBe("function");
    expect(typeof provider.turnParser).toBe("function");
  });

  it("returns the antigravity provider exposing the interface members", () => {
    const provider = resolveShadowProvider("antigravity");
    expect(provider.id).toBe("antigravity");
    expect(provider.modelProviderId).toBe("orca/google");
    expect(provider.captureMode()).toEqual({ kind: "hook" });
  });

  it("surfaces permission-persistence support per provider", () => {
    expect(resolveShadowProvider("claude-code").supportsPermissionPersistence).toBe(true);
    expect(resolveShadowProvider("codex").supportsPermissionPersistence).toBe(false);
    expect(resolveShadowProvider("antigravity").supportsPermissionPersistence).toBe(false);
  });

  it("throws on an unknown adapter id", () => {
    // @ts-expect-error exercising the runtime guard with an invalid id
    expect(() => resolveShadowProvider("nope")).toThrow();
  });
});
