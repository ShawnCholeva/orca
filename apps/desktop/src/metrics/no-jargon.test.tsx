import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepRow } from "./StepPerformance";
import type { StepMetrics } from "@orca/contracts";

const step: StepMetrics = {
  stepTemplateId: "verify", name: "Verify Proposal", ordinal: 3,
  score: 61, sampleSize: 20, confidence: "ok",
  runs: 20, passedFirstTry: 8, recovered: 6, failed: 6,
  quality: { verdictPassRate: 0.6, verifiedSampleSize: 20, sensorPassRate: 0.7, oracleSufficientRate: 0.3,
    untestedRegions: ["proration edge"], residualRisk: ["rounding drift"], oracleGaps: ["no e2e"], limitingDimension: null },
  cost: { p50LatencyMs: 3000, meanTokens: 5000, meanUsd: 0.05, meanRetries: 1.6 },
  risk: { riskClassDist: { medium: 12 }, gateDecisionDist: { allow: 18, require_approval: 2 },
    hardConstraintViolations: 3, approvals: { count: 2, sampleTransitionIds: ["t1", "t2"] } },
  failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 4, sampleTransitionIds: ["a"] }],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.7, falseAcceptanceRate: 0.1,
    artifacts: [{ source: "independent_review", verifies: "a second model reviewed the output", cannotVerify: "whether it executes correctly", confidence: 0.6, verdict: "pass" }] },
  failureModes: [{ label: "invalid_output", count: 4, pct: 0.2 }],
  reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false },
  trend: [], versionBoundaries: [], insights: ["Loops between failed strategies — high retry churn."],
  recentReasons: [{ at: "2026-05-01T00:00:00.000Z", reason: "constraint X violated" }],
};

describe("no jargon in the metrics step detail", () => {
  it("renders no 'oracle', 'sensor', or 'verdict'", () => {
    const { container } = render(<StepRow step={step} index={0} isLast open onToggle={() => {}} />);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict)\b/i);
  });
});
