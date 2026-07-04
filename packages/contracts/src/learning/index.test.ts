import { describe, expect, it } from "vitest";
import {
  ProposeInstructionRevisionProposal,
  TemplateInstructionProposal,
  JudgeInstructionEditProposal, JudgeInstructionEditRequest, CounterfactualJudgment,
} from "./index.js";
import { OrchestrationDecisionKind } from "../workflows/index.js";

describe("learning contracts", () => {
  it("accepts a valid proposal fill and rejects a non-dimension invariant", () => {
    const ok = ProposeInstructionRevisionProposal.safeParse({
      proposedInstructions: "Do X, then verify Y.",
      predictedImprovement: "Higher instruction adherence.",
      invariantsPreserved: ["safetyCompliance", "verificationStrength"],
      rationale: "Targets invalid_output cluster.",
    });
    expect(ok.success).toBe(true);

    const bad = ProposeInstructionRevisionProposal.safeParse({
      proposedInstructions: "x",
      predictedImprovement: "y",
      invariantsPreserved: ["not_a_dimension"],
      rationale: "z",
    });
    expect(bad.success).toBe(false);
  });

  it("round-trips a TemplateInstructionProposal", () => {
    const p = {
      id: "p1", templateId: "tpl", templateVersionAtProposal: 2, stepTemplateId: "s1",
      component: "step_instructions" as const,
      beforeInstructions: "old", afterInstructions: "new",
      targetedFailureMode: { rule: "R2" as const, failureCode: "invalid_output", clusterCount: 8, signalCount: null },
      predictedImprovement: "fewer invalid outputs",
      invariantsPreserved: ["safetyCompliance" as const],
      falsifier: "version_comparison" as const,
      rollbackPlan: "revert_to_before" as const,
      evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 62, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: null } },
      rationale: "because",
      humanEdited: false,
      status: "pending" as const,
      createdAt: "2026-06-30T00:00:00.000Z",
      decidedAt: null, decidedBy: null, appliedAsVersion: null,
    };
    expect(TemplateInstructionProposal.parse(p)).toMatchObject(p);
  });

  it("includes propose_instruction_revision in OrchestrationDecisionKind", () => {
    expect(OrchestrationDecisionKind.safeParse("propose_instruction_revision").success).toBe(true);
  });
});

describe("Counterfactual judge contracts", () => {
  it("round-trips a regression_risk proposal", () => {
    const p = { reasoning: "solved cases still pass but the failure case now drops its check", verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial",
      regressionCases: ["case-1"], reason: "would drop the error-path check", inputsConsidered: ["solved:s1"] };
    expect(JudgeInstructionEditProposal.parse(p)).toEqual(p);
  });
  it("rejects an unknown verdict", () => {
    expect(JudgeInstructionEditProposal.safeParse({ verdict: "maybe", regressionRisk: "none",
      addressesFailureMode: "yes", regressionCases: [], reason: "x", inputsConsidered: [] }).success).toBe(false);
  });
  it("accepts a well-formed request with both buckets", () => {
    const r = { step: { name: "analyze", currentInstructions: "do X", proposedInstructions: "do X and Y" },
      targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 4, signalCount: null },
      solvedCases: [{ stepRunId: "s1", output: "{}" }], failureCases: [{ stepRunId: "s2", output: "{}" }] };
    expect(JudgeInstructionEditRequest.parse(r).solvedCases[0].stepRunId).toBe("s1");
  });
  it("rejects an oversized request", () => {
    const big = "x".repeat(70000);
    const r = { step: { name: "a", currentInstructions: "a", proposedInstructions: "a" },
      targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
      solvedCases: [{ stepRunId: "s1", output: big }], failureCases: [] };
    expect(JudgeInstructionEditRequest.safeParse(r).success).toBe(false);
  });
  it("round-trips a persisted judgment and attaches to a proposal", () => {
    const j = { verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [],
      reason: "keeps solved cases", solvedCaseIds: ["s1"], failureCaseIds: ["s2"], solvedSampleSize: 1,
      failureSampleSize: 1, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3 };
    expect(CounterfactualJudgment.parse(j)).toEqual(j);
    const base = { id: "p1", templateId: "t1", templateVersionAtProposal: 3, stepTemplateId: "st1",
      component: "step_instructions", beforeInstructions: "a", afterInstructions: "b",
      targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
      predictedImprovement: "x", invariantsPreserved: [], falsifier: "version_comparison",
      rollbackPlan: "revert_to_before",
      evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
      rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-04T00:00:00.000Z",
      decidedAt: null, decidedBy: null, appliedAsVersion: null, judgment: j };
    expect(TemplateInstructionProposal.parse(base).judgment?.verdict).toBe("pass");
  });
});

describe("reasoning field (learning)", () => {
  it("JudgeInstructionEditProposal accepts leading reasoning", () => {
    expect(JudgeInstructionEditProposal.parse({ reasoning: "solved cases hold", verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }).reasoning).toBe("solved cases hold");
  });
  it("rejects a proposal missing reasoning (now required)", () => {
    expect(JudgeInstructionEditProposal.safeParse({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }).success).toBe(false);
  });
  it("CounterfactualJudgment carries optional reasoning", () => {
    const j = { verdict: "unavailable", regressionRisk: null, addressesFailureMode: null, regressionCases: [], reason: null, solvedCaseIds: [], failureCaseIds: [], solvedSampleSize: 0, failureSampleSize: 0, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 1 };
    expect(CounterfactualJudgment.parse(j).reasoning ?? null).toBeNull();
    expect(CounterfactualJudgment.parse({ ...j, reasoning: "why" }).reasoning).toBe("why");
  });
});
