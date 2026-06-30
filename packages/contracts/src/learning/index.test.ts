import { describe, expect, it } from "vitest";
import {
  ProposeInstructionRevisionProposal,
  TemplateInstructionProposal,
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
