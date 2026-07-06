import { describe, expect, it } from "vitest";
import { MetricPeriod, TemplateMetricsSummary, TemplateMetricsDetail } from "./index.js";

describe("metrics contracts", () => {
  it("accepts the three period literals only", () => {
    expect(MetricPeriod.safeParse("7d").success).toBe(true);
    expect(MetricPeriod.safeParse("1y").success).toBe(false);
  });

  it("round-trips a minimal TemplateMetricsSummary", () => {
    const summary = {
      templateId: "tpl", name: "Brainstorm", latestVersion: 2, runs: 10,
      dimensions: {
        trajectoryEfficiency: { value: null, reason: "no transitions" },
        verificationStrength: { value: 0.8 },
        recovery: { value: 0.5 },
        stateConsistency: { value: 1 },
        safetyCompliance: { value: 1 },
        replayability: { value: 1 },
      },
      firstPass: 0.6, recovered: 0.28, escalated: 0.08,
      latencyP50Ms: 1200,
      deltas: { verificationStrength: 0.05, recovery: null, trajectoryEfficiency: null,
                stateConsistency: 0, safetyCompliance: 0, replayability: 0, latencyP50Ms: -100 },
      versionComparison: null,
      versions: [{ version: 2, runs: 6, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      confidence: "ok" as const,
    };
    expect(TemplateMetricsSummary.parse(summary)).toEqual(summary);
  });

  it("round-trips a TemplateMetricsDetail with one step", () => {
    const detail = {
      summary: TemplateMetricsSummary.parse({
        templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 1,
        dimensions: {
          trajectoryEfficiency: { value: null }, verificationStrength: { value: 1 },
          recovery: { value: null }, stateConsistency: { value: 1 },
          safetyCompliance: { value: 1 }, replayability: { value: 1 },
        },
        firstPass: null, recovered: null, escalated: null,
        latencyP50Ms: null,
        deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null,
                  stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
        versionComparison: null, versions: [], confidence: "low" as const,
      }),
      steps: [{
        stepTemplateId: "s1", name: "Define Intent", ordinal: 0,
        score: 94, sampleSize: 12, confidence: "ok" as const,
        runs: 12, passedFirstTry: 10, recovered: 1, failed: 1,
        quality: { verdictPassRate: 0.9, verifiedSampleSize: 11, sensorPassRate: 0.95, oracleSufficientRate: 0.8,
                   untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
        cost: { p50LatencyMs: 1100, meanTokens: 2000, meanUsd: 0.03, meanRetries: 0.2 },
        risk: { riskClassDist: { low: 10 }, gateDecisionDist: { allow: 10 },
                hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
        failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete",
                            count: 1, sampleTransitionIds: ["t9"] }],
        verification: {
          tier: "ai_reviewed" as const, tierLabel: "Reviewed, not proven", confidence: 0.8,
          falseAcceptanceRate: 0.05, artifacts: [],
        },
        failureModes: [],
        reconciliation: null,
        trend: [90, 92, 94], versionBoundaries: [],
        insights: ["Weakest step"], recentReasons: [],
      }],
    };
    expect(TemplateMetricsDetail.parse(detail)).toEqual(detail);
  });
});
