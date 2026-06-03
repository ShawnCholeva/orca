import { describe, expect, it } from "vitest";
import {
  buildEvaluationFailedStepResult,
  mapStepRunStatusToResultStatus,
} from "./step-result.js";

describe("workflow step result builder", () => {
  it("maps terminal step statuses", () => {
    expect(mapStepRunStatusToResultStatus("passed")).toBe("completed");
    expect(mapStepRunStatusToResultStatus("blocked")).toBe("blocked");
    expect(mapStepRunStatusToResultStatus("failed")).toBe("failed");
    expect(mapStepRunStatusToResultStatus("skipped")).toBe("cancelled");
  });

  it("rejects non-terminal status mapping", () => {
    expect(() => mapStepRunStatusToResultStatus("active")).toThrow(/non-terminal/);
  });

  it("builds explicit evaluation-failed result", () => {
    const result = buildEvaluationFailedStepResult({
      stepId: "step-1",
      stepStatus: "completed",
      startedAt: "2026-06-03T00:00:00.000Z",
      finishedAt: "2026-06-03T00:01:05.000Z",
      retries: 2,
      producedArtifactsCount: 1,
      blockingIssuesCount: 0,
      warningsCount: 0,
      reason: "model timed out",
    });

    expect(result).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "failed",
      successScore: 0,
      quality: {
        outputCompleteness: 0,
        outputCorrectness: 0,
        instructionAdherence: 0,
        downstreamReadiness: 0,
        riskLevel: 1,
      },
      performance: {
        durationSeconds: 65,
        retries: 2,
      },
      outcome: {
        reason: "step result evaluation failed: model timed out",
        producedArtifactsCount: 1,
        blockingIssuesCount: 0,
        warningsCount: 0,
        handoffReady: false,
      },
    });
  });
});
