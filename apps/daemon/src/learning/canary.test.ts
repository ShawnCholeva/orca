import { describe, expect, it } from "vitest";
import type { StepMetrics, TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";
import { enrichWithRegression } from "./canary.js";

function step(over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    stepTemplateId: "s1", name: "Generate", ordinal: 0,
    score: 60, sampleSize: 12, confidence: "ok",
    runs: 12, passedFirstTry: 6, recovered: 2, failed: 4,
    quality: { verdictPassRate: 0.57, verifiedSampleSize: 8, scoredSampleSize: 8, sensorPassRate: 0.9, oracleSufficientRate: 0.8, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
    cost: { p50LatencyMs: 100, meanTokens: 1000, meanUsd: 0.01, meanRetries: 0.2 },
    risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
    failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 8, sampleTransitionIds: ["t1", "t2"] }],
    verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
    failureModes: [{ label: "Produced output that didn't match what the step asked for", count: 8, pct: 1 }],
    reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
    trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [], ...over,
  };
}

function summary(over: Partial<TemplateMetricsSummary> = {}): TemplateMetricsSummary {
  return {
    templateId: "tpl", name: "B", latestVersion: 2, scope: "current", runs: 10,
    dimensions: { trajectoryEfficiency: { value: 0.8 }, verificationStrength: { value: 0.6 }, recovery: { value: 0.5 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 } },
    firstPass: 0.5, recovered: 0.2, escalated: 0.05, latencyP50Ms: 100,
    deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
    versionComparison: { latest: 2, prior: 1, byDimension: { safetyCompliance: -0.2, verificationStrength: 0.05 } },
    versions: [{ version: 2, runs: 6, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok", calibration: [],
    // TODO(gate-metrics): populated in the gates-wiring task
    gateHealth: { value: null, grade: null, delta: null, confidence: "low" }, ...over,
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
  it("enriches with targetDelta/targetImproved from the targeted step's versionScoreDelta", () => {
    const steps = [
      step({ stepTemplateId: "s1", versionScoreDelta: 0.2, versionScoreDeltaVersions: { latest: 2, prior: 1 } }),
      step({ stepTemplateId: "other", versionScoreDelta: -0.4, versionScoreDeltaVersions: { latest: 2, prior: 1 } }),
    ];
    const [p] = enrichWithRegression([applied()], summary(), steps);
    expect(p.targetDelta).toBeCloseTo(0.2);
    expect(p.targetImproved).toBe(true);
  });
  it("targetImproved is null when the step has no version delta yet", () => {
    const steps = [step({ stepTemplateId: "s1", versionScoreDelta: null })];
    const [p] = enrichWithRegression([applied()], summary(), steps);
    expect(p.targetDelta).toBeNull();
    expect(p.targetImproved).toBeNull();
  });
  it("targetDelta is null when the step's compared pair does not span the applied version (stale prior-pair delta)", () => {
    // Step has a versionScoreDelta, but it compares v1-vs-v0 — the applied version is 2.
    const steps = [step({ stepTemplateId: "s1", versionScoreDelta: 0.2, versionScoreDeltaVersions: { latest: 1, prior: 0 } })];
    const [p] = enrichWithRegression([applied({ appliedAsVersion: 2 })], summary(), steps);
    expect(p.targetDelta).toBeNull();
    expect(p.targetImproved).toBeNull();
  });

  // Isolate schema canary from invariant path: with invariantsPreserved: [], regressionDetected can ONLY come from schemaCanaryTripped.
  it("schema canary: invalid-output spike on the applied version flags regression", () => {
    const steps = [step({ stepTemplateId: "s1", versionScoreDelta: 0.1,
      versionScoreDeltaVersions: { latest: 2, prior: 1 }, versionInvalidOutputRateDelta: 0.5 })];
    const [p] = enrichWithRegression([applied({ component: "step_output_schema", invariantsPreserved: [] })], summary(), steps);
    expect(p.invalidOutputRateDelta).toBeCloseTo(0.5);
    expect(p.regressionDetected).toBe(true);
  });

  it("instruction proposals ignore the invalid-output canary; pair still gates it", () => {
    const steps = [step({ stepTemplateId: "s1", versionScoreDeltaVersions: { latest: 2, prior: 1 }, versionInvalidOutputRateDelta: 0.5 })];
    const [pi] = enrichWithRegression([applied({ invariantsPreserved: [] })], summary(), steps); // step_instructions
    expect(pi.regressionDetected).toBe(false);
    const stale = [step({ stepTemplateId: "s1", versionScoreDeltaVersions: { latest: 1, prior: 0 }, versionInvalidOutputRateDelta: 0.5 })];
    const [ps] = enrichWithRegression([applied({ component: "step_output_schema", invariantsPreserved: [] })], summary(), stale);
    expect(ps.invalidOutputRateDelta).toBeNull();
    expect(ps.regressionDetected).toBe(false);
  });

  it("enriched proposals carry targetDeltaVersions for UI display", () => {
    const steps = [step({ stepTemplateId: "s1", versionScoreDelta: 0.2, versionScoreDeltaVersions: { latest: 2, prior: 1 } })];
    const [p] = enrichWithRegression([applied()], summary(), steps);
    expect(p.targetDeltaVersions).toEqual({ latest: 2, prior: 1 });
  });
});
