import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GateRow } from "./GatePerformance";
import type { GateMetrics } from "@orca/contracts";

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
