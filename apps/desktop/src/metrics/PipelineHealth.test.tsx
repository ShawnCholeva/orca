import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GateMetrics, StepMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { CoverageReadout, coverageHeadline } from "./PipelineHealth";

afterEach(cleanup);

const step = (over: Partial<StepMetrics> = {}): StepMetrics => ({
  stepTemplateId: "proposal", name: "Proposal", ordinal: 1,
  score: 87, sampleSize: 1, confidence: "low",
  runs: 1, passedFirstTry: 1, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, verifiedSampleSize: 1, scoredSampleSize: 1, sensorPassRate: 1,
             oracleSufficientRate: 1, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0.01, meanRetries: 1 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.7, falseAcceptanceRate: 0.1,
                  artifacts: [], recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
  failureModes: [], reconciliation: null, trend: [], versionBoundaries: [],
  versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [], ...over,
});

const gate = (over: Partial<GateMetrics> = {}): GateMetrics => ({
  nodeId: "critique", name: "Critique", evalSubstrate: "shadow", health: null, grade: null,
  confidence: "low", sampleSize: 0, delta: null,
  scored: { overturnRate: null, overturnSampleSize: 0, overturnDecisionIds: [], groundedness: null,
            ungroundedDecisionIds: [], convergence: null, limitingTerm: null },
  cost: { p50LatencyMs: null, meanTokens: null, meanUsd: null, tokensSpentOnOverturned: null },
  failureModes: [],
  context: { approvalRate: null, rejectRate: null, decisions: 0, meanLoops: null, capHitRate: null,
             stagnationRate: null, parkRate: null, residualRiskBurden: null, recentRejectReasons: [] },
  trend: [], versionBoundaries: [], decisionConfidence: { value: null, sampleSize: 0, state: "insufficient" }, ...over,
});

const detail = (over: Partial<TemplateMetricsDetail> = {}): TemplateMetricsDetail => ({
  summary: {} as TemplateMetricsDetail["summary"],
  steps: [step()], gates: [gate()], splitters: [],
  policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 },
                   overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] },
  completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 },
                    vetoed: { count: 0, sampleTransitionIds: [] } },
  ...over,
});

// The surface renders a COUNT, not an estimate. It replaced a score readout that had
// two defects: it gated the letter grade while rendering the score unconditionally
// (so `100 /100` from one run was the loudest cell on the screen), and — worse — the
// interval that gate consumed was fabricated, treating a composed 0–100 score as a
// binomial pass count it has no sampling distribution for. A gate built to stop a
// claim outrunning its evidence was doing exactly that.
//
// Coverage is counted; quality is estimated. `RateInterval` already renders a count
// correctly at every n, so the surface delegates rather than inventing a rule.
describe("the surface states counted coverage, never an estimate", () => {
  it("says the outcome as a word at a single observation, not a rate", () => {
    const { container } = render(<CoverageReadout checked={1} of={1} />);
    expect(container.textContent).toContain("checked");
    expect(container.textContent).not.toMatch(/%/);
  });

  it("leads with the count below five observations", () => {
    const { container } = render(<CoverageReadout checked={1} of={4} />);
    expect(container.textContent).toContain("1 of 4");
    expect(container.textContent).not.toMatch(/\d+%/);
  });

  it("promotes to a rate once the sample earns one", () => {
    const { container } = render(<CoverageReadout checked={4} of={9} />);
    expect(container.textContent).toMatch(/\d+%/);
  });

  it("renders no score and no letter grade anywhere", () => {
    // The whole point of the surface: it makes statements it can support at n=1.
    // A composed 0-100 score is not one of them, so it does not appear at all.
    const { container } = render(<CoverageReadout checked={1} of={1} />);
    expect(container.textContent).not.toMatch(/\/100|\b[ABCDF]\b/);
  });

  it("says so plainly when the node has not run", () => {
    const { container } = render(<CoverageReadout checked={0} of={0} />);
    expect(container.textContent).toContain("No runs this period");
  });
});

describe("the headline states coverage, not quality", () => {
  // At low n you can make true statements about what was MEASURED and none about how
  // well things went. Coverage is counted; quality is estimated. A headline naming the
  // worst step would be a comparison across nodes with one to five observations each —
  // exactly the claim every row below refuses to make, asserted in the largest text on
  // the screen.
  it("counts the nodes nothing has checked", () => {
    const d = detail({ steps: [step(), step({ stepTemplateId: "x", name: "X", quality: { ...step().quality, verifiedSampleSize: 0 } })] });
    expect(coverageHeadline(d)).toBe("2 of 3 steps in this workflow have never been independently checked.");
  });

  it("says so plainly when everything has been checked", () => {
    const d = detail({ steps: [step()], gates: [gate({ sampleSize: 9, decisionConfidence: { value: 0.7, sampleSize: 9, state: "measured" } })] });
    expect(coverageHeadline(d)).toBe("All 2 steps in this workflow have been independently checked.");
  });

  it("makes no claim about which node is worst", () => {
    const d = detail({ steps: [step(), step({ stepTemplateId: "b", name: "Good" })] });
    const h = coverageHeadline(d);
    expect(h).not.toMatch(/worst|struggling|failing|best|healthy/i);
  });
});
