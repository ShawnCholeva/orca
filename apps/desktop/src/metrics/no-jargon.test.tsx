import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepRow } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { PolicyGatewayReadout, CompletionGateReadout } from "./GatePerformance";
import type { StepMetrics } from "@orca/contracts";
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

describe("no jargon in the metrics step detail", () => {
  it("renders no 'oracle', 'sensor', 'verdict', 'refute', or 'veto'", () => {
    const { container } = render(<StepRow step={step} index={0} isLast open onToggle={() => {}} />);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});

describe("no jargon in the gateway readouts", () => {
  // The completion-gate + policy-gateway panels are user-visible copy; scan them here so
  // a jargon word (e.g. an "EVIDENCE VETO" kicker) can't slip past the no-jargon bar.
  const detailWithGateways = {
    policyGateway: { decisionDist: { allow: 5, require_approval: 2, deny: 1 }, overPermissive: { count: 1, sampleTransitionIds: ["t1"] }, boundaryViolations: [] },
    completionGate: { verdictDist: { upheld: 10, escalated: 1, evidence_veto: 2, refute_veto: 1 }, vetoed: { count: 4, sampleTransitionIds: ["a", "b"] } },
  } as never;

  it("renders no 'oracle', 'sensor', 'verdict', 'refute', or 'veto' in the policy + completion gateway panels", () => {
    const { container } = render(
      <>
        <PolicyGatewayReadout detail={detailWithGateways} />
        <CompletionGateReadout detail={detailWithGateways} />
      </>
    );
    expect(container.textContent).toMatch(/upheld/i); // guard: the completion panel actually rendered
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});

const schemaBefore = JSON.stringify([{ key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: false }], null, 2);
const schemaAfter = JSON.stringify([
  { key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: true },
  { key: "evidence_refs", type: "array", itemType: "string", required: true },
], null, 2);

const pendingSchemaProposal = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_output_schema",
  beforeInstructions: schemaBefore, afterInstructions: schemaAfter,
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
  rationale: "because", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

const judgedProposal = {
  id: "p2", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s2", component: "step_instructions",
  beforeInstructions: "Generate.", afterInstructions: "Generate and validate.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
  rationale: "because", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
  judgment: {
    verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes",
    regressionCases: [], reason: "solved the targeted cases", reasoning: "because the schema check rules out the malformed shape early",
    solvedCaseIds: ["s1", "s2"], failureCaseIds: [],
    solvedSampleSize: 2, failureSampleSize: 2, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3,
  },
};

const appliedSchemaCanary = {
  ...pendingSchemaProposal, id: "a1", status: "applied", appliedAsVersion: 4, regressionDetected: true,
  invalidOutputRateDelta: 0.5, targetDelta: 0.2, targetImproved: true, targetDeltaVersions: { latest: 4, prior: 3 },
};

describe("no jargon in the self-improvement rail", () => {
  it("renders no 'oracle', 'sensor', 'verdict', 'refute', or 'veto' for a pending schema proposal or a judged proposal", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pendingSchemaProposal, judgedProposal] as never);
    const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;
    const { container } = render(
      <SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />
    );
    await screen.findByText(/\+ evidence_refs/i);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("renders no 'oracle', 'sensor', 'verdict', 'refute', or 'veto' for an applied card with falsifier and canary lines", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([appliedSchemaCanary] as never);
    const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;
    const { container } = render(
      <SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />
    );
    await screen.findByText(/new checks are rejecting output/i);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("renders the curated label for a targeted failureCode, never the raw code (e.g. 'evidence_veto' must not leak 'veto')", async () => {
    const proposal = { ...judgedProposal, id: "p3", judgment: undefined, targetedFailureMode: { rule: "R1", failureCode: "evidence_veto", clusterCount: 5, signalCount: null } };
    vi.spyOn(api, "listProposals").mockResolvedValue([proposal] as never);
    const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;
    const { container } = render(
      <SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />
    );
    expect(await screen.findByText(/Automated checks failed, so the completion was rejected/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("renders no 'oracle', 'sensor', 'verdict', 'refute', or 'veto' across every learning-log event type", async () => {
    const events = [
      { id: "e1", templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "created", templateVersion: 1, createdAt: "2026-07-01T00:00:00.000Z", payload: { kind: "created", component: "step_output_schema", rule: "R2", failureCode: "evidence_veto" } },
      { id: "e2", templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "judged", templateVersion: 1, createdAt: "2026-07-01T01:00:00.000Z", payload: { kind: "judged", verdict: "regression_risk", solvedSampleSize: 1, failureSampleSize: 2 } },
      { id: "e3", templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "applied", templateVersion: 2, createdAt: "2026-07-01T02:00:00.000Z", payload: { kind: "applied", appliedAsVersion: 2, humanEdited: true } },
      { id: "e4", templateId: "tpl", proposalId: "p2", stepTemplateId: "s2", eventType: "dismissed", templateVersion: 1, createdAt: "2026-07-01T03:00:00.000Z", payload: { kind: "dismissed" } },
      { id: "e5", templateId: "tpl", proposalId: "p3", stepTemplateId: "s3", eventType: "superseded", templateVersion: 2, createdAt: "2026-07-01T04:00:00.000Z", payload: { kind: "superseded", by: "restore" } },
      { id: "e6", templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "rolled_back", templateVersion: 3, createdAt: "2026-07-01T05:00:00.000Z", payload: { kind: "rolled_back", outcome: { targetDelta: -0.05, targetDeltaVersions: { latest: 3, prior: 2 }, invalidOutputRateDelta: 0.6, regressionDetected: true } } },
      { id: "e7", templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "baseline_restored", templateVersion: 3, createdAt: "2026-07-01T06:00:00.000Z", payload: { kind: "baseline_restored", supersededCount: 1 } },
      { id: "e8", templateId: "tpl", proposalId: null, stepTemplateId: "s1", eventType: "analyzed", templateVersion: 3, createdAt: "2026-07-01T07:00:00.000Z", payload: { kind: "analyzed", stepsDiagnosed: 2, proposalsCreated: 0, skips: [{ stepTemplateId: "s1", reason: "below the sample threshold" }] } },
    ];
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue(events as never);
    const detail = {
      summary: {
        templateId: "tpl", name: "Brainstorm",
        calibration: [
          { source: "grounding", assumed: 0.7, measured: 0.62, sampleSize: 41, state: "measured" },
          { source: "executable", assumed: 1.0, measured: null, sampleSize: 2, state: "insufficient" },
          { source: "self_report", assumed: 0.3, measured: null, sampleSize: 0, state: "unmeasurable" },
        ],
      },
    } as never;
    const { container } = render(
      <SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />
    );
    await screen.findByText("Learning");
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});
