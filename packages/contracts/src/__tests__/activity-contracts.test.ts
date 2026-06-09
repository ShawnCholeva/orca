import { describe, expect, it } from "vitest";
import { Activity, ActivitySourceKind } from "../index.js";

it("accepts step_result as a source kind", () => {
  expect(ActivitySourceKind.parse("step_result")).toBe("step_result");
});

it("accepts a result-card payload on a step_result activity", () => {
  const base = {
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
    turnOrdinal: 5, status: "completed", currentText: "", finalSummary: null,
    sourceKind: "step_result", workCategory: null, confidence: null,
    createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:00:00.000Z",
    stepName: "Investigate",
    stepResult: {
      stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 0.8,
      quality: { outputCompleteness: 0.8, outputCorrectness: 0.8, instructionAdherence: 0.8, downstreamReadiness: 0.8, riskLevel: 0.2 },
      performance: { durationSeconds: 10, retries: 0 },
      outcome: { reason: "ok", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
    },
  };
  const parsed = Activity.parse(base);
  expect(parsed.stepName).toBe("Investigate");
});
