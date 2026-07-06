import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepRow } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
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
    recentRefuteReasons: [] },
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
});
