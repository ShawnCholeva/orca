import { describe, expect, it, vi } from "vitest";
import { recommendationOrDirectLaunch } from "./session-launcher.js";

describe("recommendationOrDirectLaunch", () => {
  it("requiresApproval=true → returns 'recommendation' decision", () => {
    const launcher = { launch: vi.fn() };
    const r = recommendationOrDirectLaunch({
      requiresApproval: true,
      launcher,
      ctx: { goalId: "g", workflowRunId: "r", workflowStepRunId: "sr", operatorId: "agent:codex", operatorKind: "agent", objective: "do it" },
    });
    expect(r).toBe("recommendation");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("requiresApproval=false → invokes the launcher", () => {
    const launcher = { launch: vi.fn() };
    const r = recommendationOrDirectLaunch({
      requiresApproval: false,
      launcher,
      ctx: { goalId: "g", workflowRunId: "r", workflowStepRunId: "sr", operatorId: "agent:codex", operatorKind: "agent", objective: "do it" },
    });
    expect(r).toBe("direct");
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });
});
