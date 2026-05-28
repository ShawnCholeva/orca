import { describe, expect, it } from "vitest";
import { resolveStepDispatch } from "./step-dispatch.js";

describe("resolveStepDispatch", () => {
  it("returns first ready adapter+model from preference", async () => {
    const result = await resolveStepDispatch({
      preferences: [
        { adapterId: "codex", modelId: "gpt-x" },
        { adapterId: "claude-code", modelId: "claude-haiku-4-5" },
      ],
      isAdapterReady: async (id) => id === "claude-code",
      supportsModel: (id, mid) => id === "claude-code" && mid === "claude-haiku-4-5",
      resolveMode: () => ({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] }),
    });
    expect(result.adapterId).toBe("claude-code");
    expect(result.modelId).toBe("claude-haiku-4-5");
    expect(result.executionMode).toBe("shadow_session");
  });

  it("throws when no preference is satisfiable", async () => {
    await expect(resolveStepDispatch({
      preferences: [{ adapterId: "codex", modelId: "gpt-x" }],
      isAdapterReady: async () => false,
      supportsModel: () => true,
      resolveMode: () => ({ adapterId: "codex", mode: "one_shot", fallbacks: [] }),
    })).rejects.toThrow(/no ready agent/);
  });
});
