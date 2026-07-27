import { describe, expect, it } from "vitest";
import { GateMetrics, PolicyGatewayMetrics } from "./index.js";

const validGate = {
  nodeId: "review", name: "Review", evalSubstrate: "shadow" as const,
  health: null, grade: null, confidence: "low" as const, sampleSize: 3, delta: null,
  scored: { overturnRate: null, overturnSampleSize: 0, overturnDecisionIds: [], groundedness: 0.5, ungroundedDecisionIds: [], convergence: 1, limitingTerm: null },
  cost: { p50LatencyMs: null, meanTokens: null, meanUsd: null, tokensSpentOnOverturned: null },
  failureModes: [], context: { approvalRate: 1, rejectRate: 0, decisions: 3, meanLoops: 1, capHitRate: 0, stagnationRate: 0, parkRate: 0, residualRiskBurden: null, recentRejectReasons: [] },
  trend: [], versionBoundaries: [],
  decisionConfidence: { value: null, sampleSize: 0, state: "insufficient" as const },
};

describe("GateMetrics contract", () => {
  it("parses a valid honest-null gate", () => { expect(() => GateMetrics.parse(validGate)).not.toThrow(); });
  it("rejects an unknown key (strict)", () => { expect(() => GateMetrics.parse({ ...validGate, bogus: 1 })).toThrow(); });
});

describe("PolicyGatewayMetrics contract", () => {
  it("parses", () => {
    expect(() => PolicyGatewayMetrics.parse({
      decisionDist: { allow: 5, require_approval: 1, deny: 0 },
      overPermissive: { count: 0, sampleTransitionIds: [] },
      boundaryViolations: [],
    })).not.toThrow();
  });
});
