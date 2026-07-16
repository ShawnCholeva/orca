import { describe, expect, it } from "vitest";
import type { StepMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { diagnoseTemplate, INSTRUCTION_ADDRESSABLE } from "./diagnose.js";

function step(over: Partial<StepMetrics> = {}): StepMetrics {
  return {
    stepTemplateId: "s1", name: "Generate", ordinal: 0,
    score: 60, sampleSize: 12, confidence: "ok",
    runs: 12, passedFirstTry: 6, recovered: 2, failed: 4,
    quality: { verdictPassRate: 0.57, verifiedSampleSize: 8, scoredSampleSize: 8, sensorPassRate: 0.9, oracleSufficientRate: 0.8, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
    cost: { p50LatencyMs: 100, meanTokens: 1000, meanUsd: 0.01, meanRetries: 0.2 },
    risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
    failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 8, sampleTransitionIds: ["t1", "t2"] }],
    verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [] },
    failureModes: [{ label: "Produced output that didn't match what the step asked for", count: 8, pct: 1 }],
    reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
    trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [], ...over,
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
      versions: [], confidence: "ok", calibration: [],
      // TODO(gate-metrics): populated in the gates-wiring task
      gateHealth: { value: null, grade: null, delta: null, confidence: "low" },
    },
    steps,
    // TODO(gate-metrics): populated in the gates-wiring task
    gates: [],
    policyGateway: {
      decisionDist: { allow: 0, require_approval: 0, deny: 0 },
      overPermissive: { count: 0, sampleTransitionIds: [] },
      boundaryViolations: [],
    },
  };
}
const meta = new Map([["s1", { instructions: "Generate a proposal.", outputSchemaJson: '[\n  {\n    "key": "summary",\n    "type": "string",\n    "required": true\n  }\n]' }]]);

describe("diagnoseTemplate", () => {
  it("flags an instruction-addressable cluster (R2) and carries evidence", () => {
    const { bundles: out } = diagnoseTemplate({ detail: detail([step()]), signals: [], stepMeta: meta });
    expect(out).toHaveLength(1);
    expect(out[0].stepTemplateId).toBe("s1");
    expect(out[0].targetedFailureMode.rule).toBe("R2");
    expect(out[0].targetedFailureMode.failureCode).toBe("invalid_output");
    expect(out[0].evidence.sampleTransitionIds).toEqual(["t1", "t2"]);
    expect(out[0].currentInstructions).toBe("Generate a proposal.");
  });

  it("suppresses steps below the sample threshold", () => {
    const { bundles: out } = diagnoseTemplate({ detail: detail([step({ sampleSize: 3, confidence: "low" })]), signals: [], stepMeta: meta });
    expect(out).toHaveLength(0);
  });

  it("excludes infra-coded clusters but keeps revision-signal density (R3)", () => {
    const infra = step({ score: 95, failureClusters: [{ failureCode: "daemon_restart", boundary: "step_complete", count: 9, sampleTransitionIds: ["t9"] }] });
    const signals = [
      { id: "rs1", stepTemplateId: "s1", feedbackText: "fix the schema", supersededReason: null, createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "rs2", stepTemplateId: "s1", feedbackText: "still wrong", supersededReason: null, createdAt: "2026-05-01T00:01:00.000Z" },
      { id: "rs3", stepTemplateId: "s1", feedbackText: "again", supersededReason: null, createdAt: "2026-05-01T00:02:00.000Z" },
    ];
    const { bundles: out } = diagnoseTemplate({ detail: detail([infra]), signals, stepMeta: meta });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R3");
    expect(out[0].targetedFailureMode.signalCount).toBe(3);
    expect(out[0].evidence.revisionSignalIds).toEqual(["rs1", "rs2", "rs3"]);
  });

  it("INSTRUCTION_ADDRESSABLE excludes infra codes", () => {
    expect(INSTRUCTION_ADDRESSABLE.has("invalid_output")).toBe(true);
    expect(INSTRUCTION_ADDRESSABLE.has("daemon_restart")).toBe(false);
  });

  it("R1 does not fire on a null score (no gradient) nor on infra-dominated failures", () => {
    const nullScore = step({ score: null, failureClusters: [] });
    expect(diagnoseTemplate({ detail: detail([nullScore]), signals: [], stepMeta: meta }).bundles).toHaveLength(0);

    const infra = step({
      score: 40,
      failureClusters: [
        { failureCode: "provider_error", boundary: "step_complete", count: 6, sampleTransitionIds: ["t1"] },
        { failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["t2"] },
      ],
    });
    // invalid_output count (2) < K, so R2 can't fire; R1 must refuse: infra majority.
    expect(diagnoseTemplate({ detail: detail([infra]), signals: [], stepMeta: meta }).bundles).toHaveLength(0);

    const addressable = step({ score: 40, failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["t2"] }] });
    const { bundles: out } = diagnoseTemplate({ detail: detail([addressable]), signals: [], stepMeta: meta });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R1");
  });

  it("bundle carries refute reasons, superseded reasons, and the step's own version delta", () => {
    const s = step({
      verification: { ...step().verification, recentRefuteReasons: ["claimed tests ran but none exist"] },
      versionScoreDelta: 0.25,
    });
    const signals = [
      { id: "rs1", stepTemplateId: "s1", feedbackText: "fix the schema", supersededReason: "output missed the acceptance list", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "rs2", stepTemplateId: "s1", feedbackText: "still wrong", supersededReason: null, createdAt: "2026-05-01T00:01:00.000Z" },
      { id: "rs3", stepTemplateId: "s1", feedbackText: "again", supersededReason: null, createdAt: "2026-05-01T00:02:00.000Z" },
    ];
    const { bundles: out } = diagnoseTemplate({ detail: detail([s]), signals, stepMeta: meta });
    expect(out[0].evidence.refuteReasons).toEqual(["claimed tests ran but none exist"]);
    expect(out[0].evidence.supersededReasons).toEqual(["output missed the acceptance list"]);
    expect(out[0].evidence.metricSnapshot.versionDelta).toBe(0.25);
  });

  it("R4 routes to step_output_schema and carries the current schema", () => {
    const r4 = step({ score: 70, failureClusters: [], quality: { ...step().quality, verdictPassRate: 0.9, oracleSufficientRate: null } });
    const { bundles: out } = diagnoseTemplate({ detail: detail([r4]), signals: [], stepMeta: meta });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R4");
    expect(out[0].component).toBe("step_output_schema");
    expect(out[0].currentOutputSchemaJson).toContain('"summary"');
  });

  it("R1/R2/R3 keep step_instructions", () => {
    const r2 = step(); // existing fixture: invalid_output cluster of 8 → R2
    const { bundles: out } = diagnoseTemplate({ detail: detail([r2]), signals: [], stepMeta: meta });
    expect(out[0].component).toBe("step_instructions");
  });

  it("R4 skips steps whose current schema is missing or empty (removed/renamed steps)", () => {
    const r4 = step({ score: 70, failureClusters: [], quality: { ...step().quality, verdictPassRate: 0.9, oracleSufficientRate: null } });
    // stepMeta has NO entry for s1 → fallback "[]"
    expect(diagnoseTemplate({ detail: detail([r4]), signals: [], stepMeta: new Map() }).bundles).toHaveLength(0);

    // R1 for the same missing step still diagnoses (instructions path tolerates empty)
    const r1 = step({ score: 40, failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["t"] }] });
    expect(diagnoseTemplate({ detail: detail([r1]), signals: [], stepMeta: new Map() }).bundles).toHaveLength(1);
  });

  it("returns the R4 invalid-schema skip as a skip entry", () => {
    const r4 = step({ score: 70, failureClusters: [], quality: { ...step().quality, verdictPassRate: 0.9, oracleSufficientRate: null } });
    const { bundles, skips } = diagnoseTemplate({ detail: detail([r4]), signals: [], stepMeta: new Map() });
    expect(bundles).toHaveLength(0);
    expect(skips).toEqual([{ stepTemplateId: "s1", reason: expect.stringMatching(/schema/i) }]);
  });
});
