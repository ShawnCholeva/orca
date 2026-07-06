import { describe, expect, it } from "vitest";
import { gradeFor, healthOf, pctLabel, statusMeta, statusForStep, workflowHealthFromSteps } from "./metrics-data";
import type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

const step = (over: Partial<StepMetrics> = {}): StepMetrics => ({
  stepTemplateId: "s", name: "X", ordinal: 0, score: 62, sampleSize: 3, confidence: "ok",
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, scoredSampleSize: 3, verifiedSampleSize: 3, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.62, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [] },
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

  it("statusForStep distinguishes UNVERIFIED (no score) from a genuinely-degraded step", () => {
    // Nothing was scoreable → UNVERIFIED, not a failing grade.
    expect(statusForStep(step({ score: null, quality: { ...step().quality, scoredSampleSize: 0, verifiedSampleSize: 0 } }))).toBe("unverified");
    // Scored but low → genuinely degraded quality.
    expect(statusForStep(step({ score: 30 }))).toBe("degraded");
    // Scored and high → healthy.
    expect(statusForStep(step({ score: 100 }))).toBe("healthy");
  });

  it("statusForStep: null score → unverified; 0 score → degraded", () => {
    expect(statusForStep(step({ score: null, quality: { ...step().quality, scoredSampleSize: 0, verifiedSampleSize: 0 } }))).toBe("unverified");
    expect(statusForStep(step({ score: 0 }))).toBe("degraded");
  });

  it("workflow health is the sample-weighted mean of conclusive step scores", () => {
    const h = workflowHealthFromSteps([
      step({ score: 90, sampleSize: 2 }),
      step({ score: 60, sampleSize: 2 }),
    ]);
    expect(h).toBe(75);
  });

  it("workflowHealthFromSteps weights by scoredSampleSize and skips null-score steps", () => {
    const a = step({ score: 100, sampleSize: 50, quality: { ...step().quality, scoredSampleSize: 2 } });
    const b = step({ score: 0, sampleSize: 2, quality: { ...step().quality, scoredSampleSize: 8 } });
    const c = step({ score: null, sampleSize: 40, quality: { ...step().quality, scoredSampleSize: 0 } });
    // (100*2 + 0*8) / 10 = 20 — NOT dominated by a's 50 unscored runs.
    expect(workflowHealthFromSteps([a, b, c])).toBe(20);
  });
});
