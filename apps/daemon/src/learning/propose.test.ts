import { describe, expect, it, vi } from "vitest";
import type { DiagnosisBundle } from "./diagnose.js";
import { buildProposePayload, validateRevisionProposal, proposeInstructionRevision, type BrokerLike } from "./propose.js";

const bundle: DiagnosisBundle = {
  stepTemplateId: "s1", currentInstructions: "Generate a proposal.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: ["rs1"], revisionFeedbackTexts: ["follow the schema"], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
};

describe("buildProposePayload", () => {
  it("compacts the bundle (instruction, failure mode, feedback, snapshot)", () => {
    const payload = buildProposePayload(bundle);
    expect(payload).toMatchObject({ currentInstructions: "Generate a proposal.", targetedFailureMode: { rule: "R2" } });
    expect(JSON.stringify(payload).length).toBeLessThan(65536);
  });
});

describe("validateRevisionProposal", () => {
  const validate = validateRevisionProposal("Generate a proposal.");
  it("rejects empty / oversized / identical / bad-invariant fills", () => {
    expect(validate({ proposedInstructions: "", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "Generate a proposal.", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "New text.", predictedImprovement: "x", invariantsPreserved: ["nope"], rationale: "r" }).accepted).toBe(false);
  });
  it("accepts a valid fill", () => {
    const res = validate({ proposedInstructions: "Generate a proposal and validate it against the output schema.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" });
    expect(res.accepted).toBe(true);
  });
});

describe("proposeInstructionRevision", () => {
  it("returns the parsed fill on a proposed result", async () => {
    const parsed = { proposedInstructions: "New, schema-aware instruction.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
    const broker: BrokerLike = { propose: vi.fn(async (_req, opts) => { opts.validateProposal(parsed); return { status: "proposed", parsed }; }) };
    const out = await proposeInstructionRevision({ broker, providerId: "orca/anthropic", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out?.proposedInstructions).toBe("New, schema-aware instruction.");
  });
  it("returns null when the broker escalates to human review", async () => {
    const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "needs_human_review", reviewPayloadId: "x" })) };
    const out = await proposeInstructionRevision({ broker, providerId: "p", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out).toBeNull();
  });
});
