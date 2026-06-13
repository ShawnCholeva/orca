import { describe, expect, it, vi } from "vitest";
import { resumeActiveRuns } from "./resume.js";

describe("resumeActiveRuns", () => {
  it("reattaches alive sessions and respawns dead ones", async () => {
    const isSessionAlive = vi.fn(async (id: string) => id === "alive-1");
    const reattach = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => undefined);
    const markRecoverySessionMissing = vi.fn(async () => undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: "alive-1", providerRecoveryPending: false },
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: "dead-1", providerRecoveryPending: false },
        { runId: "r3", goalId: "g3", currentStepRunId: "s3", sessionId: null, providerRecoveryPending: false },
      ],
      isSessionAlive, reattach, respawn, markRecoverySessionMissing,
    });
    expect(reattach).toHaveBeenCalledWith({ runId: "r1", sessionId: "alive-1" });
    expect(respawn).toHaveBeenCalledWith({ runId: "r2", stepRunId: "s2", goalId: "g2" });
    expect(respawn).toHaveBeenCalledWith({ runId: "r3", stepRunId: "s3", goalId: "g3" });
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(respawn).toHaveBeenCalledTimes(2);
    expect(markRecoverySessionMissing).not.toHaveBeenCalled();
  });

  it("continues when one run's respawn throws", async () => {
    const respawn = vi.fn()
      .mockRejectedValueOnce(new Error("no workspace"))
      .mockResolvedValueOnce(undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: null, providerRecoveryPending: false },
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: null, providerRecoveryPending: false },
      ],
      isSessionAlive: async () => false,
      reattach: async () => undefined,
      respawn,
      markRecoverySessionMissing: async () => undefined,
    });
    expect(respawn).toHaveBeenCalledTimes(2);
  });

  it("reattaches a pending-recovery run whose worker is still alive", async () => {
    const reattach = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => undefined);
    const markRecoverySessionMissing = vi.fn(async () => undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: "alive-1", providerRecoveryPending: true },
      ],
      isSessionAlive: async (id) => id === "alive-1",
      reattach,
      respawn,
      markRecoverySessionMissing,
    });
    expect(reattach).toHaveBeenCalledWith({ runId: "r1", sessionId: "alive-1" });
    expect(respawn).not.toHaveBeenCalled();
    expect(markRecoverySessionMissing).not.toHaveBeenCalled();
  });

  it("marks a pending-recovery run with a missing worker and never respawns", async () => {
    const reattach = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => undefined);
    const markRecoverySessionMissing = vi.fn(async () => undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: "dead-1", providerRecoveryPending: true },
        { runId: "r3", goalId: "g3", currentStepRunId: "s3", sessionId: null, providerRecoveryPending: true },
      ],
      isSessionAlive: async () => false,
      reattach,
      respawn,
      markRecoverySessionMissing,
    });
    expect(markRecoverySessionMissing).toHaveBeenCalledWith({ runId: "r2", stepRunId: "s2", sessionId: "dead-1" });
    expect(markRecoverySessionMissing).toHaveBeenCalledWith({ runId: "r3", stepRunId: "s3", sessionId: null });
    expect(markRecoverySessionMissing).toHaveBeenCalledTimes(2);
    expect(respawn).not.toHaveBeenCalled();
    expect(reattach).not.toHaveBeenCalled();
  });
});
