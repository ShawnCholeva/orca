import { describe, expect, it } from "vitest";
import { StepMetrics, TemplateMetricsSummary } from "./index.js";

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
    band: { level: "weak", label: "Weakly verified" },
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

const summaryBase = {
  templateId: "t", name: "T", latestVersion: 1, scope: "current" as const, runs: 3,
  dimensions: {
    trajectoryEfficiency: { value: 1 }, verificationStrength: { value: 1 }, recovery: { value: null },
    stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 },
  },
  firstPass: null, recovered: null, escalated: null, latencyP50Ms: null,
  deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
  versionComparison: null, versions: [], confidence: "ok" as const,
  calibration: [{ source: "grounding" as const, assumed: 0.7, measured: 0.62, sampleSize: 27.7, state: "measured" as const }],
  gateHealth: { value: null, grade: null, delta: null, confidence: "low" as const },
};

describe("TemplateMetricsSummary calibration contract", () => {
  // Regression: calibration sampleSize is Σ vindicator weights (a weighted effective-n),
  // fractional by design — a 30d payload sends e.g. 27.7. The .int() constraint here
  // rejected the whole detail payload → "Couldn't load metrics" on the tab. Mirror the
  // sibling scoreBreakdown.calibrationMix.sampleSize (z.number()).
  it("accepts a fractional calibration sampleSize (weighted effective-n)", () => {
    expect(() => TemplateMetricsSummary.parse(summaryBase)).not.toThrow();
    expect(TemplateMetricsSummary.parse(summaryBase).calibration[0]!.sampleSize).toBe(27.7);
  });
  it("still rejects a negative calibration sampleSize", () => {
    const bad = { ...summaryBase, calibration: [{ ...summaryBase.calibration[0]!, sampleSize: -1 }] };
    expect(() => TemplateMetricsSummary.parse(bad)).toThrow();
  });
});
