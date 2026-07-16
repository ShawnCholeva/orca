import { describe, expect, it } from "vitest";
import { buildGateMetrics, buildPolicyGatewayMetrics } from "./gate-metrics.js";
import type { GateDecisionRow, TemplateTransition } from "./fetch.js";

const names = new Map([["review", { name: "Review", evalSubstrate: "shadow" as const }]]);
const decision = (over: Partial<GateDecisionRow>): GateDecisionRow => ({
  id: "d", workflowRunId: "r1", nodeId: "review", traversalSeq: 1, outcome: "approved",
  reason: "ok", issueRefs: [], recommendedOutcome: "approved", recommendedReason: null,
  createdAt: "2026-07-16T00:00:00.000Z", templateVersion: 1, ...over,
});

describe("buildGateMetrics", () => {
  it("renders health null ('unproven') when overturn coverage is below the floor", () => {
    const gates = buildGateMetrics({ decisions: [decision({})], transitions: [], names, period: "7d" });
    expect(gates).toHaveLength(1);
    expect(gates[0].health).toBeNull();
    expect(gates[0].scored.overturnRate).toBeNull();
    expect(gates[0].name).toBe("Review"); // no __gate__: leak
  });

  it("computes overturnRate once coverage is met and grades the gate", () => {
    // 5 supervised decisions with a recommendation; 1 overturned (recommended approve, human rejected).
    const decisions: GateDecisionRow[] = [];
    for (let i = 0; i < 5; i++) {
      const overturned = i === 0;
      decisions.push(decision({
        id: `d${i}`, workflowRunId: `r${i}`, traversalSeq: 1,
        recommendedOutcome: "approved", outcome: overturned ? "rejected" : "approved",
      }));
    }
    const gates = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
    expect(gates[0].scored.overturnSampleSize).toBe(5);
    expect(gates[0].scored.overturnRate).toBeCloseTo(0.2, 5);
    expect(gates[0].health).not.toBeNull();
    expect(gates[0].failureModes.find((f) => f.label.match(/sent back/i))?.count).toBe(1);
  });

  it("classifies a park (reviewer_unavailable) as NOT a failure and never lets cost move health", () => {
    const decisions = Array.from({ length: 5 }, (_, i) => decision({ id: `d${i}`, workflowRunId: `r${i}`, recommendedOutcome: "approved", outcome: "approved" }));
    const withCost = buildGateMetrics({ decisions, transitions: costTransitions(9999), names, period: "7d" });
    const noCost = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
    expect(withCost[0].health).toBe(noCost[0].health); // cost never folded into health
    expect(withCost[0].cost.meanUsd).not.toBeNull();
  });
});

function costTransitions(usd: number): TemplateTransition[] {
  return [{
    templateVersion: 1, stepTemplateId: "__gate__:review",
    transition: { workflowRunId: "r0", boundary: "step_complete", createdAt: "2026-07-16T00:00:00.000Z",
      telemetry: { latency_ms: 100, cost: { usd, tokens_in: 10, tokens_out: 5 } } } as never,
  }];
}

const riskT = (gate: string, risk: string): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s1",
  transition: { id: `t-${gate}-${risk}`, workflowRunId: "r1", boundary: "tool_gate", createdAt: "2026-07-16T00:00:00.000Z",
    risk: { boundary: "tool_gate", gate_decision: gate, risk_class: risk } } as never,
});

describe("buildPolicyGatewayMetrics", () => {
  it("aggregates the tool-gate decision distribution and flags over-permissive allows", () => {
    const pg = buildPolicyGatewayMetrics([riskT("allow", "low"), riskT("allow", "high"), riskT("deny", "critical"), riskT("require_approval", "high")]);
    expect(pg.decisionDist.allow).toBe(2);
    expect(pg.decisionDist.deny).toBe(1);
    expect(pg.overPermissive.count).toBe(1); // the allow at high risk
    expect(pg.overPermissive.sampleTransitionIds).toContain("t-allow-high");
  });
});
