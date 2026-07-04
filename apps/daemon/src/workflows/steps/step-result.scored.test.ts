import { describe, expect, it } from "vitest";
import type { StepResultScoringFacts, StepResultScoringProposal } from "@orca/contracts";
import { buildScoredStepResult } from "./step-result.js";

const facts: StepResultScoringFacts = {
  stepId: "00000000-0000-0000-0000-000000000001",
  stepStatus: "completed",
  performance: { durationSeconds: 96, retries: 0 },
  outcome: { producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0 },
};

const proposal: StepResultScoringProposal = {
  reasoning: "output is complete, correct, and ready for downstream steps",
  successScore: 0.82,
  quality: {
    outputCompleteness: 0.8,
    outputCorrectness: 0.85,
    instructionAdherence: 0.9,
    downstreamReadiness: 0.8,
    riskLevel: 0.2,
  },
  reason: "Output complete and correct.",
  handoffReady: true,
};

describe("buildScoredStepResult", () => {
  it("combines daemon facts with shadow-owned scoring", () => {
    const result = buildScoredStepResult(facts, proposal);
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.82);
    expect(result.quality).toEqual(proposal.quality);
    expect(result.performance).toEqual(facts.performance);
    expect(result.outcome.producedArtifactsCount).toBe(1);
    expect(result.outcome.handoffReady).toBe(true);
    expect(result.outcome.reason).toBe("Output complete and correct.");
  });

  it("threads proposal.reasoning onto the scored result", () => {
    const result = buildScoredStepResult(facts, { ...proposal, reasoning: "worked it through" });
    expect(result.reasoning).toBe("worked it through");
  });
});
