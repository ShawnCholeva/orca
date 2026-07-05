import { describe, expect, it } from "vitest";
import { gradeFor, healthOf, pctLabel, statusForStep } from "./metrics-data";
import type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

function step(partial: { score: number; verifiedSampleSize: number }): StepMetrics {
  return {
    stepTemplateId: "s", name: "S", ordinal: 0, score: partial.score, sampleSize: 6,
    confidence: "ok", runs: 6, passedFirstTry: 6, recovered: 0, failed: 0,
    quality: { verdictPassRate: partial.score / 100, verifiedSampleSize: partial.verifiedSampleSize,
      sensorPassRate: 1, oracleSufficientRate: 1, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
    cost: { p50LatencyMs: null, meanTokens: null, meanUsd: null, meanRetries: null },
    risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
    failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
  };
}

describe("metrics-data formatting helpers", () => {
  it("gradeFor maps scores to letters", () => {
    expect(gradeFor(95)).toBe("A");
    expect(gradeFor(61)).toBe("D");
    expect(gradeFor(40)).toBe("F");
  });

  it("healthOf reads verificationStrength as a 0..100 health", () => {
    const summary = { dimensions: { verificationStrength: { value: 0.82 } } } as TemplateMetricsSummary;
    expect(healthOf(summary)).toBe(82);
  });

  it("pctLabel renders a 0..1 metric as a percentage, or — when null", () => {
    expect(pctLabel({ value: 0.64 })).toBe("64%");
    expect(pctLabel({ value: null })).toBe("—");
  });

  it("statusForStep distinguishes UNVERIFIED (no coverage) from a genuinely-degraded step", () => {
    // Zero verified coverage → low VERIFICATION, not low quality: never a failing grade.
    expect(statusForStep(step({ score: 0, verifiedSampleSize: 0 }))).toBe("unverified");
    // Verified but low → genuinely degraded quality.
    expect(statusForStep(step({ score: 30, verifiedSampleSize: 4 }))).toBe("degraded");
    // Verified and high → healthy.
    expect(statusForStep(step({ score: 100, verifiedSampleSize: 4 }))).toBe("healthy");
  });
});
