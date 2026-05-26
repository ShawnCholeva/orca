import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowHumanReviewPanel } from "./WorkflowHumanReviewPanel";

const apiMocks = vi.hoisted(() => ({
  submitHumanReviewDecision: vi.fn(),
  toErrorMessage: vi.fn((error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  ),
}));

vi.mock("../../api", () => apiMocks);

const now = "2026-01-01T00:00:00.000Z";

const review = {
  id: "review-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-2",
  attemptId: "attempt-3",
  kind: "select_operator" as const,
  providerId: "orca/openai" as const,
  modelId: "gpt-5",
  title: "Choose an operator",
  summary:
    "Step purpose: Pick the best operator for implementation\nFailed transports: one_shot:fallback:one_shot_parse_failed; hidden_interactive:failed:interactive_output_invalid",
  choices: [
    {
      id: "codex",
      label: "codex",
      description: "agent operator (planning, repo_editing)",
      proposal: {
        orcaProposalVersion: 1 as const,
        kind: "select_operator" as const,
        payload: {
          operatorId: "codex",
          operatorKind: "agent" as const,
          reason: "Human review selected codex",
          requiredCapabilities: ["planning"],
          alternativesConsidered: ["human"],
          confidence: 0.5,
          requiresUserApproval: true,
        },
      },
    },
    {
      id: "human",
      label: "human",
      description: "Continue with explicit human supervision.",
      proposal: {
        orcaProposalVersion: 1 as const,
        kind: "select_operator" as const,
        payload: {
          operatorId: "human",
          operatorKind: "human" as const,
          reason: "Human review fallback",
          requiredCapabilities: [],
          alternativesConsidered: ["codex"],
          confidence: 0.4,
          requiresUserApproval: false,
        },
      },
    },
  ],
  createdAt: now,
};

describe("WorkflowHumanReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the pending review payload and submits an edited structured proposal", async () => {
    apiMocks.submitHumanReviewDecision.mockResolvedValue({
      decision: {
        decisionId: "dec-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-2",
        decisionType: "select_operator",
        selectedAction: "select:codex",
        reason: "Human review selected codex",
        influencedBy: [],
        operatorSelectionJson: review.choices[0].proposal.payload,
        createdAt: now,
      },
      recommendationIds: ["rec-1"],
    });
    const onSubmitted = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkflowHumanReviewPanel
        goalId="goal-1"
        runId="run-1"
        attemptId="attempt-3"
        review={review}
        currentStepLabel="Issue Breakdown"
        onSubmitted={onSubmitted}
      />,
    );

    expect(screen.getByText("Human Review Required")).toBeInTheDocument();
    expect(screen.getByText("Pick the best operator for implementation")).toBeInTheDocument();
    expect(
      screen.getByText(
        "one_shot:fallback:one_shot_parse_failed; hidden_interactive:failed:interactive_output_invalid",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Operator ID")).toHaveValue("codex");

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Codex can edit the repo directly." },
    });
    fireEvent.change(screen.getByLabelText("Required capabilities"), {
      target: { value: "planning, repo_editing" },
    });
    fireEvent.change(screen.getByLabelText("Confidence"), {
      target: { value: "0.83" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Human review form" }));

    await waitFor(() => {
      expect(apiMocks.submitHumanReviewDecision).toHaveBeenCalledWith(
        "goal-1",
        "run-1",
        "attempt-3",
        {
          choiceId: "codex",
          proposal: {
            orcaProposalVersion: 1,
            kind: "select_operator",
            payload: {
              operatorId: "codex",
              operatorKind: "agent",
              reason: "Codex can edit the repo directly.",
              requiredCapabilities: ["planning", "repo_editing"],
              alternativesConsidered: ["human"],
              confidence: 0.83,
              requiresUserApproval: true,
            },
          },
        },
      );
    });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("shows daemon validation failures in the summary area", async () => {
    apiMocks.submitHumanReviewDecision.mockRejectedValue(
      new Error("selected operator is not available for human review"),
    );

    render(
      <WorkflowHumanReviewPanel
        goalId="goal-1"
        runId="run-1"
        attemptId="attempt-3"
        review={review}
        currentStepLabel="Issue Breakdown"
        onSubmitted={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.submit(screen.getByRole("form", { name: "Human review form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "selected operator is not available for human review",
    );
  });
});
