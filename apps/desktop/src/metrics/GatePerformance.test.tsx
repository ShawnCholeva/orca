import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateRow, FusedPipelinePanel } from "./GatePerformance";
import type { GateMetrics, SplitterMetrics, PipelineNode, TemplateMetricsDetail } from "@orca/contracts";

const gate = (over: Partial<GateMetrics> = {}): GateMetrics => ({
  nodeId: "review", name: "Review", evalSubstrate: "shadow", health: 72, grade: "C",
  confidence: "ok", sampleSize: 8, delta: null,
  scored: { overturnRate: 0.2, overturnSampleSize: 8, overturnDecisionIds: ["d1"], groundedness: 0.75, ungroundedDecisionIds: [], convergence: 0.9, limitingTerm: "overturn" },
  cost: { p50LatencyMs: 1200, meanTokens: 3400, meanUsd: 0.02, tokensSpentOnOverturned: 800 },
  failureModes: [{ label: "Approved work a person then sent back", count: 2, pct: 0.25, sampleDecisionIds: ["d1"] }],
  context: { approvalRate: 0.75, rejectRate: 0.25, decisions: 8, meanLoops: 1.4, capHitRate: 0, stagnationRate: 0, parkRate: null, residualRiskBurden: null, recentRejectReasons: [{ at: "2026-07-16", reason: "missing test", issueRefs: ["t1"] }] },
  trend: [], versionBoundaries: [], decisionConfidence: { value: null, sampleSize: 0, state: "insufficient" }, ...over,
});

const baseGate = gate();

describe("GateRow", () => {
  it("renders the resolved gate name, grade, and expands to cost + failure modes — no jargon or raw id", () => {
    const { container } = render(<GateRow gate={gate()} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText(/Approved work a person then sent back/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/__gate__:/);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("shows 'unproven' when health is null instead of a failing grade", () => {
    render(<GateRow gate={gate({ health: null, grade: null, scored: { ...gate().scored, overturnRate: null } })} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/unproven/i)).toBeInTheDocument();
  });

  it("shows the decision-confidence percentage only when measured", () => {
    const measured = { ...baseGate, decisionConfidence: { value: 0.82, sampleSize: 12, state: "measured" as const } };
    render(<GateRow gate={measured} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/82% of its approvals held up downstream/i)).toBeTruthy();
  });

  it("hides the number and shows an honest line when sample is insufficient", () => {
    const thin = { ...baseGate, decisionConfidence: { value: 0.9, sampleSize: 1, state: "insufficient" as const } };
    render(<GateRow gate={thin} index={0} isLast open onToggle={() => {}} />);
    expect(screen.queryByText(/90%/)).toBeNull();
    expect(screen.getByText(/Not enough decisions yet to tell whether its approvals hold up\./i)).toBeTruthy();
  });

  it("gate confidence copy stays jargon-free", () => {
    const measured = { ...baseGate, decisionConfidence: { value: 0.82, sampleSize: 12, state: "measured" as const } };
    const { container } = render(<GateRow gate={measured} index={0} isLast open onToggle={() => {}} />);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});

const splitter = (over: Partial<SplitterMetrics> = {}): SplitterMetrics => ({
  nodeId: "split", name: "Route", confidence: { value: 0.75, sampleSize: 8, state: "measured" },
  decisions: 8, misrouteRate: 0.25, retrospectiveOnly: true, deterministic: false, attributedToNodeId: null,
  ...over,
});

const summaryForPipeline = {
  templateId: "tpl", name: "Brainstorm", latestVersion: 1, scope: "current" as const, runs: 12,
  dimensions: { trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.82 },
    recovery: { value: 0.28 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 0.92 }, replayability: { value: 1 } },
  firstPass: 0.64, recovered: 0.28, escalated: 0.08, latencyP50Ms: 2400,
  deltas: { trajectoryEfficiency: null, verificationStrength: 0.04, recovery: 0.05,
    stateConsistency: 0, safetyCompliance: -0.03, replayability: 0, latencyP50Ms: -300 },
  versionComparison: null, versions: [{ version: 1, runs: 12, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok" as const,
  calibration: [],
  gateHealth: { value: 78, grade: "C" as const, delta: null, confidence: "ok" as const },
};

describe("FusedPipelinePanel", () => {
  it("renders splitter with measured confidence: shows percentage and 'routes weren't walked back' message", () => {
    const pipeline: PipelineNode[] = [
      { nodeId: "split", name: "Route", type: "splitter", branchesTo: ["path-a", "path-b"] },
    ];
    const detail: TemplateMetricsDetail = {
      summary: summaryForPipeline,
      steps: [],
      gates: [],
      splitters: [splitter({ confidence: { value: 0.75, sampleSize: 8, state: "measured" } })],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
      pipeline,
    };
    render(<FusedPipelinePanel detail={detail} loading={false} openStep={null} onToggleStep={() => {}} openGate={null} onToggleGate={() => {}} />);
    expect(screen.getByText(/75% of routes weren't walked back/)).toBeInTheDocument();
  });

  it("renders splitter with insufficient confidence: shows 'not enough routes yet to rate', no percentage", () => {
    const pipeline: PipelineNode[] = [
      { nodeId: "split", name: "Route", type: "splitter", branchesTo: ["path-a", "path-b"] },
    ];
    const detail: TemplateMetricsDetail = {
      summary: summaryForPipeline,
      steps: [],
      gates: [],
      splitters: [splitter({ confidence: { value: 0.9, sampleSize: 1, state: "insufficient" } })],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
      pipeline,
    };
    render(<FusedPipelinePanel detail={detail} loading={false} openStep={null} onToggleStep={() => {}} openGate={null} onToggleGate={() => {}} />);
    expect(screen.getByText(/not enough routes yet to rate/)).toBeInTheDocument();
    expect(screen.queryByText(/90%/)).toBeNull();
  });

  it("renders splitter with deterministic routing attribution: shows 'routing decided by {node name}'", () => {
    const pipeline: PipelineNode[] = [
      { nodeId: "decider", name: "DecisionStep", type: "step" },
      { nodeId: "split", name: "Route", type: "splitter", branchesTo: ["path-a", "path-b"] },
    ];
    const detail: TemplateMetricsDetail = {
      summary: summaryForPipeline,
      steps: [],
      gates: [],
      splitters: [splitter({
        confidence: { value: 0.8, sampleSize: 10, state: "measured" },
        deterministic: true,
        attributedToNodeId: "decider",
      })],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
      pipeline,
    };
    render(<FusedPipelinePanel detail={detail} loading={false} openStep={null} onToggleStep={() => {}} openGate={null} onToggleGate={() => {}} />);
    expect(screen.getByText(/routing decided by DecisionStep/)).toBeInTheDocument();
  });

  it("splitter branch text stays jargon-free", () => {
    const pipeline: PipelineNode[] = [
      { nodeId: "split", name: "Route", type: "splitter", branchesTo: ["path-a", "path-b"] },
    ];
    const detail: TemplateMetricsDetail = {
      summary: summaryForPipeline,
      steps: [],
      gates: [],
      splitters: [splitter({ confidence: { value: 0.75, sampleSize: 8, state: "measured" } })],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
      pipeline,
    };
    const { container } = render(<FusedPipelinePanel detail={detail} loading={false} openStep={null} onToggleStep={() => {}} openGate={null} onToggleGate={() => {}} />);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("omits confidence line when no splitter metrics entry exists", () => {
    const pipeline: PipelineNode[] = [
      { nodeId: "split", name: "Route", type: "splitter", branchesTo: ["path-a", "path-b"] },
    ];
    const detail: TemplateMetricsDetail = {
      summary: summaryForPipeline,
      steps: [],
      gates: [],
      splitters: [],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
      pipeline,
    };
    render(<FusedPipelinePanel detail={detail} loading={false} openStep={null} onToggleStep={() => {}} openGate={null} onToggleGate={() => {}} />);
    expect(screen.getByText(/Route — branches to/)).toBeInTheDocument();
    expect(screen.queryByText(/routes weren't walked back|not enough routes yet to rate/)).toBeNull();
  });
});
