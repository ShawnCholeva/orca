import { describe, expect, it } from "vitest";
import { StepMetrics } from "./index.js";

const base = {
  stepTemplateId: "s", name: "X", ordinal: 0, score: 58, sampleSize: 3, confidence: "ok" as const,
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, verifiedSampleSize: 3, scoredSampleSize: 3,
    untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
  verification: {
    tier: "ai_reviewed" as const, tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0,
    artifacts: [{ source: "self_report" as const, verifies: "a claim only", cannotVerify: "everything", confidence: 0.3, verdict: "pass" as const }],
    recentRefuteReasons: [],
  },
  failureModes: [{ label: "Reported success without an independent check", count: 3, pct: 1 }],
  reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
  versionScoreDelta: null, versionInvalidOutputRateDelta: null,
};

describe("StepMetrics contract", () => {
  it("accepts the new verification bundle, failureModes, reconciliation", () => {
    expect(() => StepMetrics.parse(base)).not.toThrow();
  });
  it("allows nullable sensorPassRate (no sensors ran)", () => {
    expect(StepMetrics.parse(base).quality.sensorPassRate).toBeNull();
  });
  it("allows null reconciliation", () => {
    expect(() => StepMetrics.parse({ ...base, reconciliation: null })).not.toThrow();
  });
});
