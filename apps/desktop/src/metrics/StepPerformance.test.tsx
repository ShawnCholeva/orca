import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepPerformancePanel, StepRow } from "./StepPerformance";
import type { TemplateMetricsDetail, StepMetrics } from "@orca/contracts";

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
    recentRefuteReasons: [] },
  failureModes: [{ label: "invalid_output", count: 4, pct: 0.2 }],
  reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
  trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: ["Loops between failed strategies — high retry churn."],
  recentReasons: [{ at: "2026-05-01T00:00:00.000Z", reason: "constraint X violated" }],
};

const detail = { summary: { name: "Brainstorm" }, steps: [step] } as unknown as TemplateMetricsDetail;

describe("StepPerformancePanel", () => {
  it("renders a step row with its score and expands to show scope + clusters + insights", () => {
    render(<StepPerformancePanel detail={detail} loading={false} openStep="Verify Proposal" onToggleStep={() => {}} />);
    expect(screen.getByText("Verify Proposal")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText(/invalid_output/)).toBeInTheDocument();
    expect(screen.getByText(/proration edge/)).toBeInTheDocument(); // untested region scope
    expect(screen.getByText(/Loops between failed strategies/)).toBeInTheDocument(); // insight
  });

  it("renders an unverified step as 'not verified' (neutral), never a failing grade", () => {
    const unverified: StepMetrics = {
      ...step, stepTemplateId: "critique", name: "Critique", score: null,
      quality: { ...step.quality, verdictPassRate: 0, verifiedSampleSize: 0, scoredSampleSize: 0 },
    };
    render(<StepPerformancePanel detail={{ summary: { name: "X" }, steps: [unverified] } as unknown as TemplateMetricsDetail} loading={false} openStep={null} onToggleStep={() => {}} />);
    expect(screen.getByText(/needs a check/i)).toBeInTheDocument();
    expect(screen.getByText("No check yet")).toBeInTheDocument();
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
    recentRefuteReasons: [] },
  failureModes: [], reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false, refuteReason: null },
};

describe("StepRow expanded", () => {
  it("renders plain-language sections and no jargon", () => {
    render(<StepRow step={reconciledStep} index={1} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/Checks run/i)).toBeTruthy();
    expect(screen.getByText(/a second model reviewed/i)).toBeTruthy();
    expect(screen.queryByText(/\b(oracle|sensor|verdict|refute|veto)\b/i)).toBeNull();
  });

  it("renders the reviewer's reason when a claim was overturned", () => {
    const s: StepMetrics = {
      ...reconciledStep,
      reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: true, refuteReason: "claimed tests ran but none exist" },
    };
    render(<StepRow step={s} index={0} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/claimed tests ran but none exist/)).toBeInTheDocument();
    // Disambiguate from the existing "— but the independent check overturned it." copy above it.
    expect(screen.getByText(/why it was overturned/i)).toBeInTheDocument();
  });

  it("renders 'needs a check' for a null score and a number for 0", () => {
    const { rerender } = render(<StepRow step={{ ...step, score: null }} index={0} isLast={false} open={false} onToggle={() => {}} />);
    expect(screen.getByText(/needs a check/i)).toBeInTheDocument();
    rerender(<StepRow step={{ ...step, score: 0 }} index={0} isLast={false} open={false} onToggle={() => {}} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
