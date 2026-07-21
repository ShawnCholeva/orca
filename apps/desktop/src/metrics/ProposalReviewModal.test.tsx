import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TemplateInstructionProposal } from "@orca/contracts";
import { ProposalReviewModal } from "./ProposalReviewModal";
import { ApiError } from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const proposal: TemplateInstructionProposal = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "Generate.", afterInstructions: "Generate and validate against schema.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "Cuts invalid-output failures", invariantsPreserved: [],
  falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: null, verdictPassRate: 0.5, oracleSufficientRate: null, versionDelta: null } },
  rationale: "Steps produced output that didn't match the schema.", humanEdited: false, status: "pending",
  createdAt: "2026-05-01T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

describe("ProposalReviewModal", () => {
  it("stays open and shows an error when onApply rejects (does not swallow the failure)", async () => {
    const onApply = vi.fn().mockRejectedValue(new ApiError("Stale proposal — template was modified."));
    const onDismiss = vi.fn();
    render(<ProposalReviewModal proposal={proposal} stepName="Proposal" onApply={onApply} onDismiss={onDismiss} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    expect(await screen.findByText(/Stale proposal — template was modified\./i)).toBeInTheDocument();
    // Modal must stay mounted/open — the parent only unmounts it on success.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("stays open and shows an error when onDismiss rejects", async () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn().mockRejectedValue(new ApiError("Proposal already decided."));
    render(<ProposalReviewModal proposal={proposal} stepName="Proposal" onApply={onApply} onDismiss={onDismiss} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));

    expect(await screen.findByText(/Proposal already decided\./i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("passes undefined to onApply when the textarea is unedited", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<ProposalReviewModal proposal={proposal} stepName="Proposal" onApply={onApply} onDismiss={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(undefined));
  });

  it("passes the edited text to onApply when the textarea was changed", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<ProposalReviewModal proposal={proposal} stepName="Proposal" onApply={onApply} onDismiss={vi.fn()} onClose={vi.fn()} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Generate and validate against schema, then re-check." } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("Generate and validate against schema, then re-check."));
  });
});
