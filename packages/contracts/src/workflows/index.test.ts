import { describe, expect, it } from "vitest";
import { REASONING_MAX, RefuteCompletionProposal, GateEvaluationProposal, StepResultScoringProposal, SplitEvaluationProposal, WorkflowStepResult, RefuteCompletionRequest } from "./index.js";

describe("Refute contracts", () => {
  it("round-trips a refuted proposal", () => {
    const p = { verdict: "refuted", reason: "output ignores the acceptance criteria", issueRefs: ["missing-error-path"], inputsConsidered: ["stepOutput"] };
    expect(RefuteCompletionProposal.parse(p)).toEqual(p);
  });
  it("rejects an unknown verdict", () => {
    expect(RefuteCompletionProposal.safeParse({ verdict: "maybe", reason: "x", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  });
  it("accepts an upheld verdict with an empty reason (no over-escalation to unavailable)", () => {
    const p = { verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] };
    expect(RefuteCompletionProposal.parse(p)).toEqual(p);
  });
  it("accepts a well-formed request with oracle scope", () => {
    const r = { step: { name: "Analyze", instructions: "do X" }, goal: { id: "goal-1", description: "ship" },
      stepOutput: { summary: "done" }, selfReportedScoring: { successScore: 0.9 },
      oracle: { ran: true, verdict: "passed", sensorsRun: [{ kind: "test", summary: "12 passed" }], gaps: ["integration"] } };
    expect(RefuteCompletionRequest.parse(r).oracle.gaps).toEqual(["integration"]);
  });
});

describe("reasoning field (workflows)", () => {
  it("REASONING_MAX is 2000", () => { expect(REASONING_MAX).toBe(2000); });
  it("accepts a reasoning field on each proposal (optional for now)", () => {
    expect(RefuteCompletionProposal.parse({ reasoning: "checked X,Y; no failure", verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }).reasoning).toBe("checked X,Y; no failure");
    expect(GateEvaluationProposal.parse({ reasoning: "criteria met", outcome: "approved", reason: "ok", inputsConsidered: [] }).reasoning).toBe("criteria met");
    expect(StepResultScoringProposal.parse({ reasoning: "output complete", successScore: 0.9, quality: { outputCompleteness: 1, outputCorrectness: 1, instructionAdherence: 1, downstreamReadiness: 1, riskLevel: 0 }, reason: "done", handoffReady: true }).reasoning).toBe("output complete");
    expect(SplitEvaluationProposal.parse({ reasoning: "branch A fits", selectedBranch: "a", reason: "a", inputsConsidered: [] }).reasoning).toBe("branch A fits");
  });
  it("still parses proposals WITHOUT reasoning (optional in Task 1)", () => {
    expect(GateEvaluationProposal.safeParse({ outcome: "approved", reason: "ok", inputsConsidered: [] }).success).toBe(true);
  });
  it("rejects reasoning over REASONING_MAX", () => {
    expect(RefuteCompletionProposal.safeParse({ reasoning: "x".repeat(2001), verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  });
  it("WorkflowStepResult carries optional reasoning", () => {
    const base = { stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 1, quality: { outputCompleteness: 1, outputCorrectness: 1, instructionAdherence: 1, downstreamReadiness: 1, riskLevel: 0 }, performance: { durationSeconds: 1, retries: 0 }, outcome: { reason: "ok", producedArtifactsCount: 0, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true } };
    expect(WorkflowStepResult.parse({ ...base, reasoning: "why" }).reasoning).toBe("why");
    expect(WorkflowStepResult.parse(base).reasoning ?? null).toBeNull();
  });
});
