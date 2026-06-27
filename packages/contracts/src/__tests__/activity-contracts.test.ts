import { describe, expect, it, test } from "vitest";
import { Activity, ActivitySourceKind, ActivityStep, ActivityDiff } from "../index.js";

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

test("Activity defaults steps to an empty array (back-compat)", () => {
  const parsed = Activity.parse({
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
    agentSessionId: null, turnOrdinal: 0, status: "active",
    currentText: "Reading…", finalSummary: null, sourceKind: "tool_use",
    workCategory: "reading", confidence: null,
    createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z",
    completedAt: null,
  });
  expect(parsed.steps).toEqual([]);
});

test("ActivityStep accepts an optional diff", () => {
  const diff = ActivityDiff.parse({
    filePath: "verifier.ts", additions: 2, deletions: 1,
    hunks: [{ oldStart: 42, newStart: 42, lines: [
      { kind: "remove", text: "old()" },
      { kind: "add", text: "new()" },
    ] }],
  });
  const step = ActivityStep.parse({
    id: "st1", text: "Edited verifier.ts", category: "editing",
    status: "done", diff, createdAt: "2026-06-16T00:00:00.000Z",
  });
  expect(step.diff?.additions).toBe(2);
  expect(step.status).toBe("done");
});

it("accepts the mark_done_pending source kind", () => {
  expect(ActivitySourceKind.parse("mark_done_pending")).toBe("mark_done_pending");
});

it("carries an optional recommendationId for the mark-done card", () => {
  const a = Activity.parse({
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1",
    agentSessionId: null, turnOrdinal: 0, status: "paused_for_input",
    currentText: "Approve to complete the run.", finalSummary: null,
    sourceKind: "mark_done_pending", workCategory: null, confidence: null,
    recommendationId: "rec-1",
    createdAt: "t", updatedAt: "t", completedAt: null, steps: [],
  });
  expect(a.recommendationId).toBe("rec-1");
});
