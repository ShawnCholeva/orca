import { describe, expect, it } from "vitest";
import type { TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";
import { enrichWithRegression } from "./canary.js";

function summary(over: Partial<TemplateMetricsSummary> = {}): TemplateMetricsSummary {
  return {
    templateId: "tpl", name: "B", latestVersion: 2, runs: 10,
    dimensions: { trajectoryEfficiency: { value: 0.8 }, verificationStrength: { value: 0.6 }, recovery: { value: 0.5 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 } },
    firstPass: 0.5, recovered: 0.2, escalated: 0.05, latencyP50Ms: 100,
    deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
    versionComparison: { latest: 2, prior: 1, byDimension: { safetyCompliance: -0.2, verificationStrength: 0.05 } },
    versions: [{ version: 2, runs: 6, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok", ...over,
  };
}
function applied(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
    beforeInstructions: "old", afterInstructions: "new",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "applied",
    createdAt: "2026-06-30T00:00:00.000Z", decidedAt: "2026-06-30T01:00:00.000Z", decidedBy: "owner", appliedAsVersion: 2, ...over,
  };
}

describe("enrichWithRegression", () => {
  it("flags regression when a watched invariant drops past threshold above sample-min", () => {
    const [p] = enrichWithRegression([applied()], summary());
    expect(p.regressionDetected).toBe(true);
    expect(p.watchedDeltas).toMatchObject({ safetyCompliance: -0.2 });
  });
  it("does not flag below sample-min on the applied version", () => {
    const [p] = enrichWithRegression([applied()], summary({ versions: [{ version: 2, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" }] }));
    expect(p.regressionDetected).toBe(false);
  });
  it("leaves non-applied proposals untouched", () => {
    const [p] = enrichWithRegression([applied({ status: "pending", appliedAsVersion: null })], summary());
    expect(p.regressionDetected).toBeUndefined();
  });
});
