import { describe, expect, it } from "vitest";
import type { StepMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { diagnoseTemplate, INSTRUCTION_ADDRESSABLE } from "./diagnose.js";

function step(over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    stepTemplateId: "s1", name: "Generate", ordinal: 0,
    score: 60, sampleSize: 12, confidence: "ok",
    runs: 12, passedFirstTry: 6, recovered: 2, failed: 4,
    quality: { verdictPassRate: 0.57, verifiedSampleSize: 8, sensorPassRate: 0.9, oracleSufficientRate: 0.8, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
    cost: { p50LatencyMs: 100, meanTokens: 1000, meanUsd: 0.01, meanRetries: 0.2 },
    risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
    failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 8, sampleTransitionIds: ["t1", "t2"] }],
    verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [] },
    failureModes: [{ label: "Produced output that didn't match what the step asked for", count: 8, pct: 1 }],
    reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false },
    trend: [], versionBoundaries: [], insights: [], recentReasons: [], ...over,
  };
}
function detail(steps: StepMetrics[]): TemplateMetricsDetail {
  return {
    summary: {
      templateId: "tpl", name: "Brainstorm", latestVersion: 2, runs: 12,
      dimensions: { trajectoryEfficiency: { value: 0.8 }, verificationStrength: { value: 0.6 }, recovery: { value: 0.5 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 1 }, replayability: { value: 1 } },
      firstPass: 0.5, recovered: 0.2, escalated: 0.05, latencyP50Ms: 100,
      deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null, stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
      versionComparison: { latest: 2, prior: 1, byDimension: { verificationStrength: -0.05 } },
      versions: [], confidence: "ok",
    },
    steps,
  };
}
const instr = new Map([["s1", "Generate a proposal."]]);

describe("diagnoseTemplate", () => {
  it("flags an instruction-addressable cluster (R2) and carries evidence", () => {
    const out = diagnoseTemplate({ detail: detail([step()]), signals: [], stepInstructions: instr });
    expect(out).toHaveLength(1);
    expect(out[0].stepTemplateId).toBe("s1");
    expect(out[0].targetedFailureMode.rule).toBe("R2");
    expect(out[0].targetedFailureMode.failureCode).toBe("invalid_output");
    expect(out[0].evidence.sampleTransitionIds).toEqual(["t1", "t2"]);
    expect(out[0].currentInstructions).toBe("Generate a proposal.");
  });

  it("suppresses steps below the sample threshold", () => {
    const out = diagnoseTemplate({ detail: detail([step({ sampleSize: 3, confidence: "low" })]), signals: [], stepInstructions: instr });
    expect(out).toHaveLength(0);
  });

  it("excludes infra-coded clusters but keeps revision-signal density (R3)", () => {
    const infra = step({ score: 95, failureClusters: [{ failureCode: "daemon_restart", boundary: "step_complete", count: 9, sampleTransitionIds: ["t9"] }] });
    const signals = [
      { id: "rs1", stepTemplateId: "s1", feedbackText: "fix the schema", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "rs2", stepTemplateId: "s1", feedbackText: "still wrong", createdAt: "2026-05-01T00:01:00.000Z" },
      { id: "rs3", stepTemplateId: "s1", feedbackText: "again", createdAt: "2026-05-01T00:02:00.000Z" },
    ];
    const out = diagnoseTemplate({ detail: detail([infra]), signals, stepInstructions: instr });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R3");
    expect(out[0].targetedFailureMode.signalCount).toBe(3);
    expect(out[0].evidence.revisionSignalIds).toEqual(["rs1", "rs2", "rs3"]);
  });

  it("INSTRUCTION_ADDRESSABLE excludes infra codes", () => {
    expect(INSTRUCTION_ADDRESSABLE.has("invalid_output")).toBe(true);
    expect(INSTRUCTION_ADDRESSABLE.has("daemon_restart")).toBe(false);
  });
});
