import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SelfImprovementRail } from "./SelfImprovement";
import * as api from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;

const pending = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "Generate.", afterInstructions: "Generate and validate against schema.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
  rationale: "because", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

describe("SelfImprovementRail", () => {
  it("analyzes on click and renders a proposal card with the diff", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "analyzeTemplate").mockResolvedValue([pending as never]);
    render(<SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /analyze this template/i }));
    expect(await screen.findByText(/Generate and validate against schema/i)).toBeTruthy();
    expect(screen.getByText(/invalid_output/i)).toBeTruthy();
  });

  it("applies a proposal and calls onMutated", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    const applySpy = vi.spyOn(api, "applyProposal").mockResolvedValue({ ...pending, status: "applied", appliedAsVersion: 2 } as never);
    const onMutated = vi.fn();
    render(<SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={onMutated} />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith("p1", undefined));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("shows error message when applyProposal rejects", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    vi.spyOn(api, "applyProposal").mockRejectedValue(new api.ApiError("Stale proposal — template was modified."));
    render(<SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    expect(await screen.findByText(/Stale proposal — template was modified\./i)).toBeTruthy();
  });
});
