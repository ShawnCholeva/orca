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

  it("throws on an unknown adapter id", () => {
    // @ts-expect-error exercising the runtime guard with an invalid id
    expect(() => resolveShadowProvider("nope")).toThrow();
  });
});
