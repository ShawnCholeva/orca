import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsPage } from "./MetricsPage";
import * as api from "../api";
import type { GateMetrics, StepMetrics, TemplateInstructionProposal } from "@orca/contracts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const summary = {
  templateId: "tpl", name: "Brainstorm", latestVersion: 1, scope: "current" as const, runs: 12,
  dimensions: { trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.82 },
    recovery: { value: 0.28 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 0.92 }, replayability: { value: 1 } },
  firstPass: 0.64, recovered: 0.28, escalated: 0.08,
  latencyP50Ms: 2400,
  deltas: { trajectoryEfficiency: null, verificationStrength: 0.04, recovery: 0.05,
    stateConsistency: 0, safetyCompliance: -0.03, replayability: 0, latencyP50Ms: -300 },
  versionComparison: null, versions: [{ version: 1, runs: 12, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok" as const,
  calibration: [],
  gateHealth: { value: 78, grade: "C" as const, delta: null, confidence: "ok" as const },
};

const step = (over: Partial<StepMetrics> = {}): StepMetrics => ({
  stepTemplateId: "proposal", name: "Proposal", ordinal: 1,
  score: 80, sampleSize: 10, confidence: "ok",
  runs: 10, passedFirstTry: 8, recovered: 1, failed: 1,
  quality: { verdictPassRate: 0.8, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 0.8, oracleSufficientRate: 0.5,
    untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 2000, meanTokens: 3000, meanUsd: 0.03, meanRetries: 1 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.7, falseAcceptanceRate: 0.1,
    artifacts: [], recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
  failureModes: [],
  reconciliation: null,
  trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [],
  recentReasons: [], ...over,
});

const gate = (over: Partial<GateMetrics> = {}): GateMetrics => ({
  nodeId: "review", name: "Review", evalSubstrate: "shadow", health: 72, grade: "C",
  confidence: "ok", sampleSize: 8, delta: null,
  scored: { overturnRate: 0.2, overturnSampleSize: 8, overturnDecisionIds: ["d1"], groundedness: 0.75, ungroundedDecisionIds: [], convergence: 0.9, limitingTerm: "overturn" },
  cost: { p50LatencyMs: 1200, meanTokens: 3400, meanUsd: 0.02, tokensSpentOnOverturned: 800 },
  failureModes: [],
  context: { approvalRate: 0.75, rejectRate: 0.25, decisions: 8, meanLoops: 1.4, capHitRate: 0, stagnationRate: 0, parkRate: null, residualRiskBurden: null, recentRejectReasons: [] },
  trend: [], versionBoundaries: [], ...over,
});

const proposal = (over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal => ({
  id: "prop-1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "proposal",
  component: "step_instructions", beforeInstructions: "Do the thing.", afterInstructions: "Do the thing carefully.",
  targetedFailureMode: { rule: "R1", failureCode: "vague_output", clusterCount: 3, signalCount: null },
  predictedImprovement: "Cuts vague-output failures", invariantsPreserved: [],
  falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: null, verdictPassRate: 0.5, oracleSufficientRate: null, versionDelta: null } },
  rationale: "Steps were vague.", humanEdited: false, status: "pending",
  createdAt: "2026-05-01T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
  ...over,
});

describe("MetricsPage", () => {
  it("renders a pending proposal in the rail and opens the review modal on 'Review change'", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [step()], gates: [], policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] }, completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } } });
    vi.spyOn(api, "listProposals").mockResolvedValue([proposal()]);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue([]);
    render(<MetricsPage />);

    expect(await screen.findByText("Cuts vague-output failures")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Review change"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });


  it("shows a loading state then renders the health tile", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [], gates: [], policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] }, completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } } });
    render(<MetricsPage />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Step health")).toBeInTheDocument());
    expect(screen.getByText("Brainstorm")).toBeInTheDocument();
  });

  it("shows Step health and Gate health as two distinct readouts", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [], gates: [], policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] }, completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } } });
    render(<MetricsPage />);
    expect(await screen.findByText("Step health")).toBeInTheDocument();
    expect(screen.getByText("Gate health")).toBeInTheDocument();
    expect(screen.queryByText("Workflow health")).toBeNull();
  });

  it("renders the completion gate readout with the four verdict counts", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({
      summary, steps: [], gates: [],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 3, escalated: 1, evidence_veto: 2, refute_veto: 0 }, vetoed: { count: 3, sampleTransitionIds: ["a", "b", "c"] } },
    });
    render(<MetricsPage />);
    const readout = await screen.findByText(/3 upheld/);
    expect(readout.textContent).toContain("3 upheld");
    expect(readout.textContent).toContain("1 escalated");
    expect(readout.textContent).toContain("2 vetoed");
    expect(readout.textContent).toContain("0 overturned");
  });

  it("shows the empty state when no templates have runs", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([]);
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Run a workflow to see metrics/i)).toBeInTheDocument());
  });

  it("shows an error state on fetch failure", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockRejectedValue(new Error("boom"));
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Couldn't load metrics/i)).toBeInTheDocument());
  });

  it("renders em dash for null metrics (not 0 / F)", async () => {
    const nullSummary = {
      ...summary,
      dimensions: { ...summary.dimensions, verificationStrength: { value: null } },
      firstPass: null, confidence: "ok" as const,
    };
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([nullSummary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary: nullSummary, steps: [], gates: [], policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] }, completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } } });
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText("Step health")).toBeInTheDocument());
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("F")).not.toBeInTheDocument();
  });

  it("renders version change-marker chips on gates and the scope toggle with Current shape active", async () => {
    const gateChangedShape = gate({ nodeId: "critique", name: "Critique", versionHistory: { changedFrom: "step", eras: [{ type: "step", fromVersion: 8, toVersion: 11, runs: 5 }, { type: "gate", fromVersion: 12, toVersion: 13, runs: 3 }] } });
    const gateRenamed = gate({ nodeId: "verify", name: "Verify", versionHistory: { renamedFrom: "Release Readiness", eras: [{ type: "gate", fromVersion: 8, toVersion: 12, runs: 7 }, { type: "gate", fromVersion: 13, toVersion: 13, runs: 1 }] } });
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({
      summary, steps: [], gates: [gateChangedShape, gateRenamed],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
    });
    render(<MetricsPage />);
    expect(await screen.findByText(/was a step/i)).toBeInTheDocument();
    expect(screen.getByText(/renamed from 'Release Readiness'/i)).toBeInTheDocument();

    const current = screen.getByRole("button", { name: "Current shape" });
    expect(current).toBeInTheDocument();
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Latest only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All versions" })).toBeInTheDocument();
  });

  it("renders one fused Pipeline panel with steps and gates interleaved in flow order, when detail.pipeline is present", async () => {
    const proposal = step({ stepTemplateId: "proposal", name: "Proposal" });
    const execution = step({ stepTemplateId: "execution", name: "Execution", ordinal: 2 });
    const critique = gate({ nodeId: "critique", name: "Critique" });
    const pipeline = [
      { nodeId: "proposal", name: "Proposal", type: "step" as const },
      { nodeId: "critique", name: "Critique", type: "gate" as const, guards: { from: "proposal", to: "execution" } },
      { nodeId: "split", name: "Route", type: "splitter" as const, branchesTo: ["execution", "fastpath"] },
      { nodeId: "execution", name: "Execution", type: "step" as const },
      { nodeId: "fastpath", name: "Fast Path", type: "step" as const },
    ];
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({
      summary, steps: [proposal, execution], gates: [critique], pipeline,
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
    });
    render(<MetricsPage />);
    expect(await screen.findByText("Pipeline")).toBeInTheDocument();

    const html = document.body.innerHTML;
    const iProposal = html.indexOf("Proposal");
    const iCritique = html.indexOf("Critique");
    const iExecution = html.indexOf(">Execution<");
    expect(iProposal).toBeGreaterThan(-1);
    expect(iCritique).toBeGreaterThan(iProposal);
    expect(iExecution).toBeGreaterThan(iCritique);

    expect(screen.getByText(/guards Proposal → Execution/)).toBeInTheDocument();
    const marker = screen.getByText(/branches to/i);
    expect(marker.textContent).toContain("Execution");
    expect(marker.textContent).toContain("Fast Path");

    expect(screen.getByText(/no runs this period/i)).toBeInTheDocument();

    expect(screen.queryByText("Step performance")).toBeNull();
    expect(screen.queryByText("Gates")).toBeNull();
  });

  it("falls back to the two-panel layout when detail.pipeline is absent", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({
      summary, steps: [step()], gates: [gate()],
      policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
      completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } },
    });
    render(<MetricsPage />);
    expect(await screen.findByText("Gates")).toBeInTheDocument();
    expect(screen.getByText("Step performance")).toBeInTheDocument();
    expect(screen.queryByText("Pipeline")).toBeNull();
  });
});
