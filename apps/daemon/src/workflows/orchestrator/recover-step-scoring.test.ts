import { describe, expect, it, vi } from "vitest";
import { recoverStepScoring } from "./recover-step-scoring.js";

const facts = {
  stepId: "00000000-0000-0000-0000-000000000001",
  stepStatus: "completed" as const,
  performance: { durationSeconds: 10, retries: 0 },
  outcome: { producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0 },
};

const validText = JSON.stringify({
  successScore: 0.7,
  quality: {
    outputCompleteness: 0.7,
    outputCorrectness: 0.7,
    instructionAdherence: 0.7,
    downstreamReadiness: 0.7,
    riskLevel: 0.3,
  },
  reason: "recovered output is adequate",
  handoffReady: true,
});

describe("recoverStepScoring", () => {
  it("returns a scored result when the shadow turn yields a valid proposal", async () => {
    const ask = vi.fn().mockResolvedValue({ text: validText });
    const result = await recoverStepScoring(
      { ask },
      {
        goalId: "g",
        adapterId: "claude-code",
        timeoutMs: 1000,
        facts,
        prompt: { systemPrompt: "s", userPrompt: "u" },
      }
    );
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.7);
  });

  it("returns an evaluation-failure result when the shadow turn times out", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("shadow ask timed out"));
    const result = await recoverStepScoring(
      { ask },
      {
        goalId: "g",
        adapterId: "claude-code",
        timeoutMs: 1000,
        facts,
        prompt: { systemPrompt: "s", userPrompt: "u" },
      }
    );
    expect(result.evaluationStatus).toBe("failed");
  });

  it("returns an evaluation-failure result when the shadow text is malformed", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "not json" });
    const result = await recoverStepScoring(
      { ask },
      {
        goalId: "g",
        adapterId: "claude-code",
        timeoutMs: 1000,
        facts,
        prompt: { systemPrompt: "s", userPrompt: "u" },
      }
    );
    expect(result.evaluationStatus).toBe("failed");
  });
});
