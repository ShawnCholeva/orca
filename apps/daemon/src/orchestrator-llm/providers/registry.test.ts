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

  it("captures codex turns via hook (not pane-poll)", () => {
    expect(resolveShadowProvider("codex").captureMode()).toEqual({ kind: "hook" });
  });

  it("parses the codex action block out of a Stop-hook last_assistant_message", () => {
    // The Codex Stop hook POSTs `last_assistant_message` to /v1/shadow-hooks/stop,
    // which carries the full ```orca:action fenced block verbatim (verified
    // codex-cli 0.136.0). The hook capture path runs this through turnParser.
    const lastAssistantMessage = [
      "Done with the analysis.",
      "```orca:action",
      '{ "kind": "advance", "note": "ready" }',
      "```",
    ].join("\n");
    const action = resolveShadowProvider("codex").turnParser().parseAction(lastAssistantMessage);
    expect(action).toBe('{ "kind": "advance", "note": "ready" }');
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
