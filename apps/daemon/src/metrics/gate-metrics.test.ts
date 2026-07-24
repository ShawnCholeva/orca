import { describe, expect, it } from "vitest";
import { buildCompletionGateMetrics, buildGateMetrics, buildPolicyGatewayMetrics } from "./gate-metrics.js";
import type { GateDecisionRow, TemplateTransition } from "./fetch.js";

const names = new Map([["review", { name: "Review", evalSubstrate: "shadow" as const }]]);
const decision = (over: Partial<GateDecisionRow>): GateDecisionRow => ({
  id: "d", workflowRunId: "r1", nodeId: "review", traversalSeq: 1, outcome: "approved",
  reason: "ok", issueRefs: [], recommendedOutcome: "approved", recommendedReason: null,
  createdAt: "2026-07-16T00:00:00.000Z", templateVersion: 1, ...over,
});

// --- fixtures for graded groundedness (mirror composed-score.test.ts shapes) ---
const evf = (o: Record<string, unknown>) => ({
  sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
  oracleAdequacy: { sufficient: false, gaps: [] }, ...o,
});
const groundingPassed = { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] };
const stepTx = (over: { workflowRunId?: string; createdAt?: string; evidence?: unknown; refute?: unknown }): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s",
  transition: {
    workflowRunId: over.workflowRunId ?? "r", boundary: "step_complete",
    createdAt: over.createdAt ?? "2026-07-15T00:00:00.000Z",
    evidence: over.evidence, refute: over.refute,
  } as never,
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

  it("groundedness is the graded MEAN of reviewed-step evidence strength (not a binary fraction)", () => {
    const mk = (run: string, evidence: unknown) => ({
      d: decision({ id: `dec-${run}`, workflowRunId: run, recommendedOutcome: null }),
      t: stepTx({ workflowRunId: run, evidence }),
    });
    const exe = mk("r1", evf({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } })); // base 1.0
    const grd = mk("r2", evf({ grounding: groundingPassed }));                                                     // base 0.7
    const slf = mk("r3", evf({}));                                                                                 // base 0 (self-report only, unknown)
    const gates = buildGateMetrics({
      decisions: [exe.d, grd.d, slf.d], transitions: [exe.t, grd.t, slf.t], names, period: "7d",
    });
    expect(gates[0].scored.groundedness).toBeCloseTo((1.0 + 0.7 + 0) / 3, 5); // graded mean of 1.0, 0.7, 0 — not a binary fraction
  });

  it("a strongly grounding-verified reviewed step is GROUNDED — not ungrounded, not blind (honesty fix)", () => {
    const d = decision({ workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
    const t = stepTx({ workflowRunId: "r1", evidence: evf({ grounding: groundingPassed }) }); // base 0.7 > 0.3
    const gates = buildGateMetrics({ decisions: [d], transitions: [t], names, period: "7d" });
    expect(gates[0].scored.groundedness).toBeCloseTo(0.7, 5);
    expect(gates[0].scored.ungroundedDecisionIds).toEqual([]);
    expect(gates[0].failureModes.find((f) => f.label.match(/self-report|independent/i))).toBeUndefined();
  });

  it("self-report-only and refuted reviewed steps are ungrounded; an approved self-report is blind", () => {
    const dSelf = decision({ id: "dSelf", workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
    const tSelf = stepTx({ workflowRunId: "r1", evidence: evf({}) });                                            // base 0.3 (== floor)
    const dRef = decision({ id: "dRef", workflowRunId: "r2", outcome: "rejected", recommendedOutcome: null });
    const tRef = stepTx({ workflowRunId: "r2", refute: { verdict: "refuted" }, evidence: evf({ grounding: groundingPassed }) }); // refuted → base 0
    const gates = buildGateMetrics({ decisions: [dSelf, dRef], transitions: [tSelf, tRef], names, period: "7d" });
    expect([...gates[0].scored.ungroundedDecisionIds].sort()).toEqual(["dRef", "dSelf"]);
    const blind = gates[0].failureModes.find((f) => f.label.match(/self-report|independent/i));
    expect(blind?.count).toBe(1);                 // only the approved one; dRef was rejected
    expect(blind?.sampleDecisionIds).toEqual(["dSelf"]);
  });

  it("a decision with no reviewed step-complete contributes 0 to groundedness", () => {
    const d = decision({ workflowRunId: "r1", outcome: "approved", recommendedOutcome: null });
    const gates = buildGateMetrics({ decisions: [d], transitions: [], names, period: "7d" });
    expect(gates[0].scored.groundedness).toBe(0);
    expect(gates[0].scored.ungroundedDecisionIds).toEqual(["d"]);
  });

  it("shows only the current template's gates — a decision for a retired gate node drops out", () => {
    const decisions = [
      decision({ id: "d1", nodeId: "review", workflowRunId: "r1", recommendedOutcome: null }),   // current gate
      decision({ id: "d2", nodeId: "designgate", workflowRunId: "r2", recommendedOutcome: null }), // retired gate — not in `names`
    ];
    const gates = buildGateMetrics({ decisions, transitions: [], names, period: "7d" });
    expect(gates.map((g) => g.nodeId)).toEqual(["review"]); // designgate excluded
  });

  it("falls back to showing all gates when the gate set is unknown (empty names)", () => {
    const decisions = [decision({ id: "d1", nodeId: "review", workflowRunId: "r1", recommendedOutcome: null })];
    const gates = buildGateMetrics({ decisions, transitions: [], names: new Map(), period: "7d" });
    expect(gates.map((g) => g.nodeId)).toEqual(["review"]); // no filtering when the set is unknown
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
    risk: { gate_decision: gate, risk_class: risk } } as never,
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

const cgT = (over: { id?: string; evidence?: unknown; status?: string; failure_code?: string | null; boundary?: string; stepTemplateId?: string }): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: over.stepTemplateId ?? "s1",
  transition: {
    id: over.id ?? "t", workflowRunId: "r1", boundary: over.boundary ?? "step_complete",
    createdAt: "2026-07-16T00:00:00.000Z",
    evidence: over.evidence,
    telemetry: { outcome: { status: over.status ?? "succeeded", failure_code: over.failure_code ?? null } },
  } as never,
});

describe("buildCompletionGateMetrics", () => {
  it("buckets gated completions 4 ways and ignores non-gated / gate / non-complete transitions", () => {
    const cg = buildCompletionGateMetrics([
      cgT({ id: "up1", evidence: {}, status: "succeeded", failure_code: null }),
      cgT({ id: "esc1", evidence: {}, status: "escalated", failure_code: "evidence_veto" }),
      cgT({ id: "veto1", evidence: {}, status: "failed", failure_code: "evidence_veto" }),
      cgT({ id: "ref1", evidence: {}, status: "failed", failure_code: "refute_veto" }),
      cgT({ id: "nongated", status: "succeeded", failure_code: null }),                       // NO evidence → ignored
      cgT({ id: "gatenode", evidence: {}, stepTemplateId: "__gate__:review" }),               // gate node → ignored
      cgT({ id: "toolgate", evidence: {}, boundary: "tool_gate" }),                           // wrong boundary → ignored
    ]);
    expect(cg.verdictDist).toEqual({ upheld: 1, escalated: 1, evidence_veto: 1, refute_veto: 1 });
    expect(cg.vetoed.count).toBe(3);
    expect([...cg.vetoed.sampleTransitionIds].sort()).toEqual(["esc1", "ref1", "veto1"]);
  });

  it("caps sampleTransitionIds at GATE_SAMPLE_CAP while count stays the true total", () => {
    const cg = buildCompletionGateMetrics(
      Array.from({ length: 6 }, (_, i) => cgT({ id: `v${i}`, evidence: {}, status: "failed", failure_code: "evidence_veto" })),
    );
    expect(cg.verdictDist.evidence_veto).toBe(6);
    expect(cg.vetoed.count).toBe(6);
    expect(cg.vetoed.sampleTransitionIds).toHaveLength(5);
  });

  it("no gated completions → all zero", () => {
    expect(buildCompletionGateMetrics([]).verdictDist).toEqual({ upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 });
  });
});
