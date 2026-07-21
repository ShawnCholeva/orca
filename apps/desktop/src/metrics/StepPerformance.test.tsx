import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepPerformancePanel, StepRow } from "./StepPerformance";
import type { TemplateMetricsDetail, StepMetrics, SampleDetail } from "@orca/contracts";
import * as api from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const step: StepMetrics = {
  stepTemplateId: "verify", name: "Verify Proposal", ordinal: 3,
  score: 61, sampleSize: 20, confidence: "ok",
  runs: 20, passedFirstTry: 8, recovered: 6, failed: 6,
  quality: { verdictPassRate: 0.6, verifiedSampleSize: 20, scoredSampleSize: 20, sensorPassRate: 0.7, oracleSufficientRate: 0.3,
    untestedRegions: ["proration edge"], residualRisk: ["rounding drift"], oracleGaps: ["no e2e"], limitingDimension: null },
  cost: { p50LatencyMs: 3000, meanTokens: 5000, meanUsd: 0.05, meanRetries: 1.6 },
  risk: { riskClassDist: { medium: 12 }, gateDecisionDist: { allow: 18, require_approval: 2 },
    hardConstraintViolations: 3, approvals: { count: 2, sampleTransitionIds: ["t1", "t2"] } },
  failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 4, sampleTransitionIds: ["a"] }],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.7, falseAcceptanceRate: 0.1,
    artifacts: [{ source: "independent_review", verifies: "a second model reviewed the output", cannotVerify: "whether it executes correctly", confidence: 0.6, verdict: "pass" }],
    recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
  failureModes: [{ label: "invalid_output", count: 4, pct: 0.2 }],
  reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
  trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: ["Loops between failed strategies — high retry churn."],
  recentReasons: [{ at: "2026-05-01T00:00:00.000Z", reason: "constraint X violated" }],
};

const detail = { summary: { name: "Brainstorm" }, steps: [step] } as unknown as TemplateMetricsDetail;

describe("StepPerformancePanel", () => {
  it("expands to show the What's-going-wrong failure drill", () => {
    render(<StepPerformancePanel detail={detail} loading={false} openStep="Verify Proposal" onToggleStep={() => {}} />);
    expect(screen.getByText("Verify Proposal")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText(/What's going wrong/i)).toBeInTheDocument();
    expect(screen.getAllByText(/invalid_output/).length).toBeGreaterThan(0);
    // removed sections must be gone
    expect(screen.queryByText(/Checks run/i)).toBeNull();
    expect(screen.queryByText(/how this score was reached/i)).toBeNull();
    expect(screen.queryByText(/proration edge/)).toBeNull();
    expect(screen.queryByText(/Loops between failed strategies/)).toBeNull();
  });

  it("renders an unverified step as 'not verified' (neutral), never a failing grade", () => {
    const unverified: StepMetrics = {
      ...step, stepTemplateId: "critique", name: "Critique", score: null,
      quality: { ...step.quality, verdictPassRate: 0, verifiedSampleSize: 0, scoredSampleSize: 0 },
      verification: { ...step.verification, band: { level: "needs_evidence", label: "Needs more evidence" } },
    };
    render(<StepPerformancePanel detail={{ summary: { name: "X" }, steps: [unverified] } as unknown as TemplateMetricsDetail} loading={false} openStep={null} onToggleStep={() => {}} />);
    expect(screen.getByText(/needs a check/i)).toBeInTheDocument();
    expect(screen.getByText("Needs more evidence")).toBeInTheDocument();
    expect(screen.queryByText("/100 F")).not.toBeInTheDocument();
  });

  it("renders an empty step state when there are no steps", () => {
    render(<StepPerformancePanel detail={{ summary: { name: "X" }, steps: [] } as unknown as TemplateMetricsDetail} loading={false} openStep={null} onToggleStep={() => {}} />);
    expect(screen.getByText(/No step activity/i)).toBeInTheDocument();
  });
});

const reconciledStep: StepMetrics = {
  stepTemplateId: "s", name: "Proposal", ordinal: 1, score: 62, sampleSize: 3, confidence: "ok",
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, scoredSampleSize: 3, verifiedSampleSize: 3, untestedRegions: ["whether the plan works"], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: ["Consistently passes but is never independently proven."], recentReasons: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.62, falseAcceptanceRate: 0,
    artifacts: [{ source: "independent_review", verifies: "a second model reviewed the result", cannotVerify: "anything not executed", confidence: 0.55, verdict: "pass" }],
    recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
  failureModes: [], reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
};

describe("StepRow expanded", () => {
  it("renders a healthy expanded drawer as one line, no mechanical sections, no jargon", () => {
    render(<StepRow step={reconciledStep} index={1} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/What's going wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/No problems detected this period/i)).toBeInTheDocument();
    expect(screen.queryByText(/Checks run/i)).toBeNull();
    expect(screen.queryByText(/a second model reviewed/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("renders 'needs a check' for a null score and a number for 0", () => {
    const { rerender } = render(<StepRow step={{ ...step, score: null }} index={0} isLast={false} open={false} onToggle={() => {}} />);
    expect(screen.getByText(/needs a check/i)).toBeInTheDocument();
    rerender(<StepRow step={{ ...step, score: 0 }} index={0} isLast={false} open={false} onToggle={() => {}} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders the epistemic band pill, not the tier label", () => {
    const s: StepMetrics = { ...step, verification: { ...step.verification, tierLabel: "Run & tested", band: { level: "weak", label: "Weakly verified" } } };
    render(<StepRow step={s} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText("Weakly verified")).toBeInTheDocument();
    expect(screen.queryByText("Run & tested")).toBeNull(); // tier pill retired
  });

  it("shows an inline drafted-fix card on a struggling step with a matching proposal", () => {
    const proposal = { id: "p1", stepTemplateId: "verify", status: "pending",
      predictedImprovement: "Require evidence_refs so a reviewer can check the work.",
    } as unknown as import("@orca/contracts").TemplateInstructionProposal;
    const onReviewProposal = vi.fn();
    render(<StepRow step={step} index={0} isLast open onToggle={() => {}} proposalForStep={proposal} onReviewProposal={onReviewProposal} />);
    expect(screen.getByText(/Orca drafted a fix/i)).toBeInTheDocument();
    expect(screen.getByText(/Require evidence_refs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Review change/i));
    expect(onReviewProposal).toHaveBeenCalledWith("p1");
  });

  it("shows no drafted-fix card on a healthy step (no clusters)", () => {
    const proposal = { id: "p1", stepTemplateId: "s", status: "pending", predictedImprovement: "x" } as unknown as import("@orca/contracts").TemplateInstructionProposal;
    render(<StepRow step={reconciledStep} index={0} isLast open onToggle={() => {}} proposalForStep={proposal} onReviewProposal={() => {}} />);
    expect(screen.queryByText(/Orca drafted a fix/i)).toBeNull();
  });
});

describe("diagnosis card", () => {
  it("renders a healthy grounded step: description, a 'Healthy' verdict, and the review framing", () => {
    const s: StepMetrics = {
      ...step, score: 95, failureModes: [],
      description: "Assess the goal without interviewing the user or changing any code.",
      verification: { ...step.verification, band: { level: "strong", label: "Reviewed" } },
    };
    render(<StepRow step={s} index={0} isLast open={false} onToggle={() => {}} />);
    expect(screen.getByText("Assess the goal without interviewing the user or changing any code.")).toBeInTheDocument();
    expect(screen.getByText(/Healthy/)).toBeInTheDocument();
    expect(screen.getByText(/review is the right bar/)).toBeInTheDocument();
  });

  it("renders a failing step with a 'Needs attention' verdict naming the failure, and the wrong channel shows count × pct", () => {
    const s: StepMetrics = {
      ...step, score: 66,
      failureModes: [{ label: "invalid_output", count: 3, pct: 0.15 }],
    };
    render(<StepRow step={s} index={0} isLast open={false} onToggle={() => {}} />);
    expect(screen.getByText(/Needs attention/)).toBeInTheDocument();
    expect(screen.getAllByText(/invalid_output/).length).toBeGreaterThanOrEqual(2); // verdict cause + wrong channel
    expect(screen.getByText(/invalid_output 3× · 15%/)).toBeInTheDocument();
  });

  it("renders 'Not checked yet' and 'No score yet' for a null-score step awaiting evidence", () => {
    const s: StepMetrics = {
      ...step, score: null,
      verification: { ...step.verification, band: { level: "needs_evidence", label: "Needs more evidence" } },
    };
    render(<StepRow step={s} index={0} isLast open={false} onToggle={() => {}} />);
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
    expect(screen.getByText(/No score yet/)).toBeInTheDocument();
  });

  it("does not render the OutcomeBar anywhere on the step row", () => {
    render(<StepRow step={step} index={0} isLast={false} open onToggle={() => {}} />);
    expect(screen.queryByTestId("outcome-bar")).not.toBeInTheDocument();
  });
});

describe("sample drill-through", () => {
  const clusterStep: StepMetrics = {
    ...step,
    failureClusters: [{ failureCode: "evidence_veto", boundary: "step_complete", count: 3, sampleTransitionIds: ["t1", "t2"] }],
  };

  const sample: SampleDetail = {
    transitionId: "t1", goalId: "g1", workflowRunId: "run-1", createdAt: "2026-07-01T00:00:00.000Z",
    templateVersion: 4, failureCode: "evidence_veto", status: "failed",
    checks: [{ label: "member_of on chosen_approach", detail: "value X not allowed", result: "failed" }],
  };

  it("renders the cluster label + count, fetches + shows samples on toggle, and opens the full run", async () => {
    const getSampleDetail = vi.spyOn(api, "getSampleDetail").mockResolvedValue(sample);
    const onOpenGoal = vi.fn();

    render(<StepRow step={clusterStep} index={0} isLast open onToggle={() => {}} onOpenGoal={onOpenGoal} />);

    expect(screen.getByText(/Automated checks failed, so the completion was rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/3×/)).toBeInTheDocument();
    const toggle = screen.getByText(/view 2 samples/i);
    expect(getSampleDetail).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(getSampleDetail).toHaveBeenCalledWith("t1");
    expect(getSampleDetail).toHaveBeenCalledWith("t2");

    await screen.findAllByText("member_of on chosen_approach"); // both t1 + t2 resolve to the same fixture
    expect(screen.getAllByText("value X not allowed").length).toBeGreaterThan(0);

    const openBtn = screen.getAllByText(/open full run/i)[0]!;
    fireEvent.click(openBtn);
    expect(onOpenGoal).toHaveBeenCalledWith("g1");
  });
});
