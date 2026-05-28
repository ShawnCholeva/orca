import { describe, expect, it, vi } from "vitest";
import { ProductionWorkflowSessionLauncher } from "./session-launcher-impl.js";

describe("ProductionWorkflowSessionLauncher", () => {
  it("creates a session via createSessionUseCase with adapterId stripped from agent:<id>", async () => {
    const createSession = vi.fn(async () => ({ id: "sess-1" }));
    const firstWorkspaceId = vi.fn(() => "ws-1");
    const launcher = new ProductionWorkflowSessionLauncher({ createSession, firstWorkspaceId });
    const r = await launcher.launch({
      goalId: "g", workflowRunId: "r", workflowStepRunId: "sr",
      operatorId: "agent:codex", operatorKind: "agent", objective: "do it",
    });
    expect(r.sessionId).toBe("sess-1");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      goalId: "g", workspaceId: "ws-1", adapterId: "codex",
      workflowStepRunId: "sr", instruction: "do it",
    }));
  });

  it("throws direct_launch_unsupported if the goal has no workspace", async () => {
    const launcher = new ProductionWorkflowSessionLauncher({
      createSession: vi.fn(),
      firstWorkspaceId: vi.fn(() => null),
    });
    await expect(launcher.launch({
      goalId: "g", workflowRunId: "r", workflowStepRunId: "sr",
      operatorId: "agent:codex", operatorKind: "agent", objective: "x",
    })).rejects.toThrow(/direct_launch_unsupported/);
  });
});
