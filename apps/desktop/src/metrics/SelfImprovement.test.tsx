import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TemplateInstructionProposal } from "@orca/contracts";
import { SelfImprovementRail } from "./SelfImprovement";
import { ProposalReviewModal } from "./ProposalReviewModal";
import * as api from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const detail = { summary: { templateId: "tpl", name: "Brainstorm" } } as never;

// SelfImprovementRail is a controlled component (proposals/onReview/refetchProposals are
// props owned by MetricsPage). This harness reproduces just enough of MetricsPage's
// proposal-owning logic — fetch on mount, refetch after a mutation, render the modal keyed
// off the reviewed id — so the rail + modal can still be exercised together in isolation.
function Harness({ onMutated = () => {} }: { onMutated?: () => void }) {
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const refetchProposals = async () => { setProposals(await api.listProposals("tpl", "7d")); };
  useEffect(() => { refetchProposals(); }, []);
  const reviewing = proposals.find((p) => p.id === reviewingId) ?? null;
  return (
    <>
      <SelfImprovementRail detail={detail} workflowName="Brainstorm" templateId="tpl" period="7d" onMutated={onMutated}
        proposals={proposals} onReview={setReviewingId} refetchProposals={refetchProposals} />
      {reviewing && (
        <ProposalReviewModal proposal={reviewing} stepName={reviewing.stepTemplateId}
          onApply={async (edited) => { await api.applyProposal(reviewing.id, edited); setReviewingId(null); await refetchProposals(); }}
          onDismiss={async () => { await api.dismissProposal(reviewing.id); setReviewingId(null); await refetchProposals(); }}
          onClose={() => setReviewingId(null)} />
      )}
    </>
  );
}

const pending = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "Generate.", afterInstructions: "Generate and validate against schema.",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
  rationale: "because", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

const schemaBefore = JSON.stringify([{ key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: false }], null, 2);
const schemaAfter = JSON.stringify([
  { key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: true },
  { key: "evidence_refs", type: "array", itemType: "string", required: true },
], null, 2);

const schemaPending = {
  ...pending, id: "p2", component: "step_output_schema", beforeInstructions: schemaBefore, afterInstructions: schemaAfter,
};

const schemaDescriptionOnlyBefore = JSON.stringify([{ key: "summary", type: "string", required: true, description: "one paragraph" }], null, 2);
const schemaDescriptionOnlyAfter = JSON.stringify([{ key: "summary", type: "string", required: true, description: "one paragraph, plain language" }], null, 2);
const schemaDescriptionOnlyPending = {
  ...pending, id: "p6", component: "step_output_schema",
  beforeInstructions: schemaDescriptionOnlyBefore, afterInstructions: schemaDescriptionOnlyAfter,
};

const appliedImproved = {
  ...pending, id: "a1", status: "applied", appliedAsVersion: 4,
  targetDelta: 0.2, targetImproved: true, targetDeltaVersions: { latest: 4, prior: 3 },
};

const appliedNotImproved = {
  ...pending, id: "a2", status: "applied", appliedAsVersion: 4,
  targetDelta: -0.08, targetImproved: false, targetDeltaVersions: { latest: 4, prior: 3 },
};

const appliedAwaiting = {
  ...pending, id: "a3", status: "applied", appliedAsVersion: 4,
  targetDelta: null, targetImproved: null, targetDeltaVersions: null,
};

const appliedSchemaCanary = {
  ...schemaPending, id: "a4", status: "applied", appliedAsVersion: 4, regressionDetected: true,
  invalidOutputRateDelta: 0.5, targetDelta: null, targetImproved: null, targetDeltaVersions: null,
};

const appliedInstructionsNoCanary = {
  ...pending, id: "a5", status: "applied", appliedAsVersion: 4,
  invalidOutputRateDelta: 0.5, targetDelta: null, targetImproved: null, targetDeltaVersions: null,
};

describe("SelfImprovementRail", () => {
  it("analyzes on click and renders a proposal card", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValueOnce([]).mockResolvedValue([pending as never]);
    const analyzeSpy = vi.spyOn(api, "analyzeTemplate").mockResolvedValue([pending as never]);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /analyze this template/i }));
    await waitFor(() => expect(analyzeSpy).toHaveBeenCalled());
    expect(await screen.findByText(/produced output that didn't match/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /review change/i })).toBeTruthy();
  });

  it("pending card opens a review modal with the diff and keeps Apply/Dismiss", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    const applySpy = vi.spyOn(api, "applyProposal").mockResolvedValue({ ...pending, status: "applied", appliedAsVersion: 2 } as never);
    render(<Harness />);
    expect(await screen.findByText(/produced output that didn't match/i)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /review change/i }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/− Generate\./)).toBeTruthy();
    expect(dialog.getAllByText(/Generate and validate against schema\./).length).toBeGreaterThan(0);
    fireEvent.click(dialog.getByRole("button", { name: /^apply$/i }));
    // The modal only sends a second argument (marking humanEdited) when the textarea was
    // actually changed — an unedited Apply must not read as human-edited.
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith("p1", undefined));
  });

  it("schema proposals render field chips, not raw JSON, in the summary", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([schemaPending as never]);
    render(<Harness />);
    expect(await screen.findByText(/\+ evidence_refs/i)).toBeTruthy();
    expect(screen.queryByText(/"key": "summary"/)).toBeNull();
  });

  it("schema proposal with no chips (description-only extension) shows a fallback line, not a blank summary", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([schemaDescriptionOnlyPending as never]);
    render(<Harness />);
    expect(await screen.findByText(/Adds required structure — open Review change\./i)).toBeTruthy();
  });

  it("applies a proposal and calls onMutated", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    const applySpy = vi.spyOn(api, "applyProposal").mockResolvedValue({ ...pending, status: "applied", appliedAsVersion: 2 } as never);
    const onMutated = vi.fn();
    render(<Harness onMutated={onMutated} />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("shows error message when applyProposal rejects", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    vi.spyOn(api, "applyProposal").mockRejectedValue(new api.ApiError("Stale proposal — template was modified."));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    expect(await screen.findByText(/Stale proposal — template was modified\./i)).toBeTruthy();
  });

  it("shows the judge verdict and keeps Apply enabled (informs, never gates)", async () => {
    const judged = {
      ...pending,
      judgment: {
        verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial",
        regressionCases: ["s1"], reason: "would drop the error-path check", solvedCaseIds: ["s1"], failureCaseIds: ["s2"],
        solvedSampleSize: 1, failureSampleSize: 1, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3,
      },
    };
    vi.spyOn(api, "listProposals").mockResolvedValue([judged as never]);
    render(<Harness />);
    expect(await screen.findByText(/regression risk/i)).toBeTruthy();
    expect(screen.getByText(/would drop the error-path check/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^apply$/i })).toBeEnabled();
  });

  it("judge block shows verdict, samples, and expandable reasoning — no invented percentage", async () => {
    const judged = {
      ...pending,
      judgment: {
        verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes",
        regressionCases: [], reason: "solved the targeted cases", reasoning: "because the schema check rules out the malformed shape early",
        solvedCaseIds: ["s1", "s2"], failureCaseIds: [],
        solvedSampleSize: 2, failureSampleSize: 2, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 3,
      },
    };
    vi.spyOn(api, "listProposals").mockResolvedValue([judged as never]);
    const { container } = render(<Harness />);
    expect(await screen.findByText(/^pass/i)).toBeTruthy();
    expect(screen.getByText(/2 solved/i)).toBeTruthy();
    const summary = screen.getByText(/how the reviewer worked through it/i);
    // reasoning sits under a <details>/<summary> toggle — collapsed by default, not a raw always-on paragraph.
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/because the schema check rules out the malformed shape early/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/%\d/);
  });

  it("shows the Evaluate action when unjudged", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    render(<Harness />);
    expect(await screen.findByRole("button", { name: /evaluate this edit/i })).toBeTruthy();
  });

  it("review modal textarea is controlled and initializes from afterInstructions", async () => {
    // ProposalReviewModal now owns its edited-text state locally (init'd from
    // proposal.afterInstructions) and is only mounted while open — so a close/reopen is a
    // fresh mount that resets to the original text, rather than persisting the in-progress
    // edit. This is an accepted behavior change from lifting the modal out of the rail.
    vi.spyOn(api, "listProposals").mockResolvedValue([pending as never]);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /review change/i }));
    const dialog = within(await screen.findByRole("dialog"));
    const textarea = dialog.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe(pending.afterInstructions);
    fireEvent.change(textarea, { target: { value: "edited text" } });
    expect(textarea.value).toBe("edited text");
    fireEvent.click(dialog.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /review change/i }));
    const dialogReopened = within(await screen.findByRole("dialog"));
    const textareaReopened = dialogReopened.getByRole("textbox") as HTMLTextAreaElement;
    expect(textareaReopened.value).toBe(pending.afterInstructions);
  });

  it("applied card renders the falsifier line in all three states", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([appliedImproved, appliedNotImproved, appliedAwaiting] as never);
    render(<Harness />);
    expect(await screen.findByText(/improved \+20 points \(v3→v4\)/i)).toBeTruthy();
    expect(await screen.findByText(/not improved \(-8 points, v3→v4\)/i)).toBeTruthy();
    expect(await screen.findByText(/awaiting data — needs 2 scored runs on each version/i)).toBeTruthy();
  });

  it("schema canary line renders when invalidOutputRateDelta exceeds the threshold", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([appliedSchemaCanary] as never);
    render(<Harness />);
    expect(await screen.findByText(/new checks are rejecting output/i)).toBeTruthy();
    expect(screen.getByText(/\+50%/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /rollback/i })).toBeTruthy();
  });

  it("does not render the schema canary line for instructions proposals", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([appliedInstructionsNoCanary] as never);
    render(<Harness />);
    await screen.findByText(/awaiting data/i);
    expect(screen.queryByText(/new checks are rejecting output/i)).toBeNull();
  });

  it("empty state is honest when the last review diagnosed steps but drafted nothing", async () => {
    const analyzedWithSkips = {
      id: "ev-an", templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "analyzed", templateVersion: 3,
      createdAt: "2026-07-06T23:03:00.000Z",
      payload: {
        kind: "analyzed", stepsDiagnosed: 3, proposalsCreated: 0,
        skips: [{ stepTemplateId: "s1", reason: "the model didn't return a usable draft" }],
      },
    };
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue([analyzedWithSkips] as never);
    const { container } = render(<Harness />);
    expect(await screen.findByText(/The last review flagged 3 steps but couldn't draft a change/i)).toBeTruthy();
    expect(screen.queryByText(/steps are healthy or below the sample threshold/i)).toBeNull();
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("empty state keeps the healthy text when the last review had nothing to skip", async () => {
    const analyzedClean = {
      id: "ev-an2", templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "analyzed", templateVersion: 3,
      createdAt: "2026-07-06T23:03:00.000Z",
      payload: { kind: "analyzed", stepsDiagnosed: 0, proposalsCreated: 0, skips: [] },
    };
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue([analyzedClean] as never);
    render(<Harness />);
    expect(await screen.findByText(/steps are healthy or below the sample threshold/i)).toBeTruthy();
  });

  it("learning log renders events newest-first plus a synthesized row for an event-less proposal", async () => {
    const oldEvent = { id: "ev1", templateId: "tpl", proposalId: "a1", stepTemplateId: "s1", eventType: "applied", templateVersion: 3, createdAt: "2026-07-01T10:00:00.000Z", payload: { kind: "applied", appliedAsVersion: 3, humanEdited: false } };
    const newEvent = { id: "ev2", templateId: "tpl", proposalId: "a1", stepTemplateId: "s1", eventType: "rolled_back", templateVersion: 4, createdAt: "2026-07-03T09:00:00.000Z", payload: { kind: "rolled_back", outcome: { targetDelta: -0.1, targetDeltaVersions: { latest: 4, prior: 3 }, invalidOutputRateDelta: null, regressionDetected: true } } };
    const orphan = { ...appliedNotImproved, id: "old-proposal", status: "dismissed" };
    vi.spyOn(api, "listProposals").mockResolvedValue([orphan] as never);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue([newEvent, oldEvent] as never);
    render(<Harness />);
    const heading = await screen.findByText("Learning");
    const section = heading.closest("section") as HTMLElement;
    const text = section.textContent ?? "";
    expect(text).toContain("3 events");
    expect(text.indexOf("didn't improve")).toBeLessThan(text.indexOf("Applied as v3"));
    expect(text).toContain("(before the learning log existed)");
  });

  it("collapses adjacent identical learning-log lines into one row with a repeat count", async () => {
    const analyzed = (id: string, at: string) => ({
      id, templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "analyzed", templateVersion: 3,
      createdAt: at, payload: { kind: "analyzed", stepsDiagnosed: 3, proposalsCreated: 0, skips: [] },
    });
    const applied = { id: "ev-a", templateId: "tpl", proposalId: "a1", stepTemplateId: "s1", eventType: "applied", templateVersion: 3, createdAt: "2026-07-06T21:00:00.000Z", payload: { kind: "applied", appliedAsVersion: 3, humanEdited: false } };
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listLearningEvents").mockResolvedValue([
      analyzed("ev-1", "2026-07-06T23:03:00.000Z"),
      analyzed("ev-2", "2026-07-06T22:43:00.000Z"),
      analyzed("ev-3", "2026-07-06T22:41:00.000Z"),
      applied,
    ] as never);
    render(<Harness />);
    const heading = await screen.findByText("Learning");
    const section = heading.closest("section") as HTMLElement;
    // Three identical adjacent lines render once, with the repeat count; the header keeps the true event count.
    expect(section.textContent).toContain("4 events");
    const dupes = within(section).getAllByText(/Reviewed 3 steps — nothing to propose\./);
    expect(dupes).toHaveLength(1);
    expect(within(section).getByText(/×3/)).toBeTruthy();
    expect(within(section).getByText(/Applied as v3\./)).toBeTruthy();
  });

});
