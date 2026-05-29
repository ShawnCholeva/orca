import { describe, expect, it, vi } from "vitest";
import { resumeActiveRuns } from "./resume.js";

describe("resumeActiveRuns", () => {
  it("reattaches alive sessions and respawns dead ones", async () => {
    const isSessionAlive = vi.fn(async (id: string) => id === "alive-1");
    const reattach = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: "alive-1" },
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: "dead-1" },
        { runId: "r3", goalId: "g3", currentStepRunId: "s3", sessionId: null },
      ],
      isSessionAlive, reattach, respawn,
    });
    expect(reattach).toHaveBeenCalledWith({ runId: "r1", sessionId: "alive-1" });
    expect(respawn).toHaveBeenCalledWith({ runId: "r2", stepRunId: "s2", goalId: "g2" });
    expect(respawn).toHaveBeenCalledWith({ runId: "r3", stepRunId: "s3", goalId: "g3" });
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(respawn).toHaveBeenCalledTimes(2);
  });

  it("continues when one run's respawn throws", async () => {
    const respawn = vi.fn()
      .mockRejectedValueOnce(new Error("no workspace"))
      .mockResolvedValueOnce(undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: null },
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: null },
      ],
      isSessionAlive: async () => false,
      reattach: async () => undefined,
      respawn,
    });
    expect(respawn).toHaveBeenCalledTimes(2);
  });
});
