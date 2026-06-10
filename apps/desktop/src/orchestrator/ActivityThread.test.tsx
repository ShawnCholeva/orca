import { fireEvent, render, screen } from "@testing-library/react";
import type { Activity } from "@orca/contracts";
import { describe, expect, it } from "vitest";

import { ActivityThread } from "./ActivityThread";

const mk = (over: Partial<Activity> = {}): Activity => ({
  id: "a",
  goalId: "g1",
  workflowRunId: "r1",
  stepRunId: "s1",
  agentSessionId: null,
  turnOrdinal: 0,
  status: "active",
  currentText: "Watching...",
  finalSummary: null,
  sourceKind: "step_started",
  workCategory: null,
  confidence: null,
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  completedAt: null,
  ...over,
});

const unusedQuestionForm = () => null;

describe("ActivityThread", () => {
  it("renders the live bubble's current text", () => {
    render(
      <ActivityThread
        goalId="g1"
        activities={[mk({ currentText: "Reading through the codebase..." })]}
        renderQuestionForm={unusedQuestionForm}
      />,
    );

    expect(screen.getByText("Reading through the codebase...")).toBeInTheDocument();
  });

  it("renders meaningful completed summaries but not expired or weak-signal summaries (G5)", () => {
    render(
      <ActivityThread
        goalId="g1"
        activities={[
          mk({
            id: "c1",
            status: "completed",
            finalSummary: "12/12 pass",
            sourceKind: "turn_completed",
          }),
          mk({
            id: "w1",
            status: "completed",
            finalSummary: "Still working",
            sourceKind: "weak_signal",
          }),
          mk({
            id: "x1",
            status: "expired",
            finalSummary: "Expired signal",
            sourceKind: "weak_signal",
          }),
        ]}
        renderQuestionForm={unusedQuestionForm}
      />,
    );

    expect(screen.getByText("12/12 pass")).toBeInTheDocument();
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    expect(screen.queryByText("Expired signal")).not.toBeInTheDocument();
  });

  it("does not render a whitespace-only completed summary", () => {
    render(
      <ActivityThread
        goalId="g1"
        activities={[
          mk({
            status: "completed",
            finalSummary: "   ",
            sourceKind: "turn_completed",
          }),
        ]}
        renderQuestionForm={unusedQuestionForm}
      />,
    );

    expect(screen.queryByTestId("activity-summary")).not.toBeInTheDocument();
  });

  it("renders the embedded question form when paused", () => {
    render(
      <ActivityThread
        goalId="g1"
        activities={[
          mk({
            status: "paused_for_input",
            currentText: "I need your call on signals.",
            sourceKind: "question_pending",
            pendingQuestion: {
              questionId: "q1",
              toolUseId: "t1",
              questions: [
                {
                  header: "Signals",
                  question: "Which passed?",
                  multiSelect: true,
                  options: [{ label: "A", description: "x" }],
                },
              ],
            },
          }),
        ]}
        renderQuestionForm={({ goalId, pending }) => (
          <div>
            {goalId}: {pending.questions[0]?.question}
          </div>
        )}
      />,
    );

    expect(screen.getByText("I need your call on signals.")).toBeInTheDocument();
    expect(screen.getByText("g1: Which passed?")).toBeInTheDocument();
  });

  function stepResultActivity(over: Partial<Activity> = {}): Activity {
    return {
      id: "res1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
      turnOrdinal: 9, status: "completed", currentText: "", finalSummary: null,
      sourceKind: "step_result", workCategory: null, confidence: null,
      createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z", completedAt: "2026-06-09T00:00:00.000Z",
      stepName: "Investigate",
      stepResult: {
        stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 0.82,
        quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 },
        performance: { durationSeconds: 96, retries: 0 },
        outcome: { reason: "Output complete.", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
      },
      ...over,
    } as Activity;
  }

  it("renders a scored result card with a percentage and expands to metrics", () => {
    render(<ActivityThread goalId="g1" activities={[stepResultActivity()]} renderQuestionForm={() => null} />);
    const card = screen.getByTestId("step-result-card");
    expect(card).toHaveTextContent("Investigate");
    expect(card).toHaveTextContent("82%");
    fireEvent.click(screen.getByTestId("step-result-expand"));
    expect(card).toHaveTextContent("Instruction adherence");
  });

  it("shows 'Evaluation failed' and never a percentage for failed evaluation", () => {
    const baseResult = stepResultActivity().stepResult!;
    const failed = stepResultActivity({
      stepResult: {
        ...baseResult,
        evaluationStatus: "failed",
        successScore: 0,
        quality: { outputCompleteness: 0, outputCorrectness: 0, instructionAdherence: 0, downstreamReadiness: 0, riskLevel: 1 },
        outcome: { ...baseResult.outcome, reason: "step result evaluation failed: shadow timeout", handoffReady: false },
      },
    });
    render(<ActivityThread goalId="g1" activities={[failed]} renderQuestionForm={() => null} />);
    const card = screen.getByTestId("step-result-card");
    expect(card).toHaveTextContent("Evaluation failed");
    expect(card).not.toHaveTextContent("%");
  });

  it("preserves summary order and renders only the latest live activity", () => {
    render(
      <ActivityThread
        goalId="g1"
        activities={[
          mk({ id: "c1", status: "completed", finalSummary: "First", sourceKind: "turn_completed" }),
          mk({ id: "c2", status: "completed", finalSummary: "Second", sourceKind: "turn_completed" }),
          mk({ id: "live-1", currentText: "Older live activity" }),
          mk({ id: "live-2", status: "paused_for_input", currentText: "Latest live activity" }),
        ]}
        renderQuestionForm={unusedQuestionForm}
      />,
    );

    expect(screen.getAllByTestId("activity-summary").map((element) => element.textContent)).toEqual([
      "First",
      "Second",
    ]);
    expect(screen.getAllByTestId("activity-bubble")).toHaveLength(1);
    expect(screen.getByText("Latest live activity")).toBeInTheDocument();
    expect(screen.queryByText("Older live activity")).not.toBeInTheDocument();
  });
});
