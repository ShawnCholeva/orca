import { describe, expect, it } from "vitest";
import { gradeFor, healthOf, pctLabel, statusMeta, statusForStep, workflowHealthFromSteps } from "./metrics-data";
import type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

const step = (over: Partial<StepMetrics>): StepMetrics => ({
  stepTemplateId: "s", name: "X", ordinal: 0, score: 62, sampleSize: 3, confidence: "ok",
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, verifiedSampleSize: 3, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.62, falseAcceptanceRate: 0, artifacts: [] },
  failureModes: [], reconciliation: null, ...over,
});

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

  it("labels the unverified state 'No check yet'", () => {
    expect(statusMeta.unverified.label).toBe("No check yet");
  });

  it("statusForStep distinguishes UNVERIFIED (no coverage) from a genuinely-degraded step", () => {
    // Zero verified coverage → low VERIFICATION, not low quality: never a failing grade.
    expect(statusForStep(step({ score: 0, quality: { ...step({}).quality, verifiedSampleSize: 0 } }))).toBe("unverified");
    // Verified but low → genuinely degraded quality.
    expect(statusForStep(step({ score: 30, quality: { ...step({}).quality, verifiedSampleSize: 4 } }))).toBe("degraded");
    // Verified and high → healthy.
    expect(statusForStep(step({ score: 100, quality: { ...step({}).quality, verifiedSampleSize: 4 } }))).toBe("healthy");
  });

  it("workflow health is the sample-weighted mean of conclusive step scores", () => {
    const h = workflowHealthFromSteps([
      step({ score: 90, sampleSize: 2 }),
      step({ score: 60, sampleSize: 2 }),
    ]);
    expect(h).toBe(75);
  });
});
