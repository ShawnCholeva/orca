import { describe, expect, it } from "vitest";
import { ADAPTER_EXECUTION_MODE_DEFAULTS } from "./execution-modes.js";

describe("ADAPTER_EXECUTION_MODE_DEFAULTS", () => {
  it("claude-code preferred shadow_session, disabled one_shot with billing reason", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["claude-code"];
    expect(cfg).toBeDefined();
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    const disabled = cfg.disabledExecutionModes.find((e) => e.mode === "one_shot");
    expect(disabled?.reason).toMatch(/2026-06-15/);
  });

  it("codex preferred one_shot with shadow_session as fallback enabled", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["codex"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("one_shot");
    const fallback = cfg.enabledExecutionModes.find((e) => e.preferred !== true);
    expect(fallback?.mode).toBe("shadow_session");
  });

  it("opencode preferred shadow_session, disabled one_shot", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["opencode"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    expect(cfg.disabledExecutionModes.find((e) => e.mode === "one_shot")).toBeDefined();
  });
});
