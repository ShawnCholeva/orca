import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepPerformancePanel } from "./StepPerformance";
import type { TemplateMetricsDetail, StepMetrics } from "@orca/contracts";

const step: StepMetrics = {
  stepTemplateId: "verify", name: "Verify Proposal", ordinal: 3,
  score: 61, sampleSize: 20, confidence: "ok",
  runs: 20, passedFirstTry: 8, recovered: 6, failed: 6,
  quality: { verdictPassRate: 0.6, sensorPassRate: 0.7, oracleSufficientRate: 0.3,
    untestedRegions: ["proration edge"], residualRisk: ["rounding drift"], oracleGaps: ["no e2e"], limitingDimension: null },
  cost: { p50LatencyMs: 3000, meanTokens: 5000, meanUsd: 0.05, meanRetries: 1.6 },
  risk: { riskClassDist: { medium: 12 }, gateDecisionDist: { allow: 18, require_approval: 2 },
    hardConstraintViolations: 3, approvals: { count: 2, sampleTransitionIds: ["t1", "t2"] } },
  failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 4, sampleTransitionIds: ["a"] }],
  trend: [], versionBoundaries: [], insights: ["Loops between failed strategies — high retry churn."],
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

  it("renders an empty step state when there are no steps", () => {
    render(<StepPerformancePanel detail={{ summary: { name: "X" }, steps: [] } as unknown as TemplateMetricsDetail} loading={false} openStep={null} onToggleStep={() => {}} />);
    expect(screen.getByText(/No step activity/i)).toBeInTheDocument();
  });
});
