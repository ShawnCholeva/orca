import { describe, expect, it } from "vitest";
import { StepRevisionSignal } from "./index.js";

describe("StepRevisionSignal", () => {
  it("round-trips a signal", () => {
    const s = StepRevisionSignal.parse({
      id: "sig1",
      stepRunId: "s1",
      goalId: "g1",
      revisionIndex: 0,
      supersededScoring: {
        reasoning: "output covers the acceptance criteria with no gaps",
        successScore: 0.9,
        quality: {
          outputCompleteness: 0.9,
          outputCorrectness: 0.85,
          instructionAdherence: 0.95,
          downstreamReadiness: 0.8,
          riskLevel: 0.1
        },
        reason: "looks good",
        handoffReady: true
      },
      feedbackText: "please add error handling",
      createdAt: "2026-06-11T00:00:00.000Z"
    });
    expect(s.revisionIndex).toBe(0);
    expect(s.supersededScoring.successScore).toBe(0.9);
  });

  it("allows null feedback", () => {
    const s = StepRevisionSignal.parse({
      id: "sig2",
      stepRunId: "s1",
      goalId: "g1",
      revisionIndex: 1,
      supersededScoring: {
        reasoning: "output partially addresses the goal, missing the edge cases",
        successScore: 0.5,
        quality: {
          outputCompleteness: 0.5,
          outputCorrectness: 0.5,
          instructionAdherence: 0.5,
          downstreamReadiness: 0.5,
          riskLevel: 0.5
        },
        reason: "partial",
        handoffReady: false
      },
      feedbackText: null,
      createdAt: "2026-06-11T00:00:00.000Z"
    });
    expect(s.feedbackText).toBeNull();
  });
});
