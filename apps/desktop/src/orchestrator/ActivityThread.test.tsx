import { fireEvent, render, screen } from "@testing-library/react";
import type { Activity } from "@orca/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityCard,
  LiveActivity,
  isTimelineCard,
  pickLiveActivity,
} from "./ActivityThread";

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

describe("LiveActivity", () => {
  it("renders the live bubble's current text", () => {
    render(
      <LiveActivity
        goalId="g1"
        activity={mk({ currentText: "Reading through the codebase..." })}
        renderQuestionForm={unusedQuestionForm}
      />,
    );

    expect(screen.getByText("Reading through the codebase...")).toBeInTheDocument();
  });

  it("renders the embedded question form when paused", () => {
    render(
      <LiveActivity
        goalId="g1"
        activity={mk({
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
        })}
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

  it("renders a Continue button on a supervised confirmation checkpoint", () => {
    const onContinue = vi.fn();
    render(
      <LiveActivity
        goalId="g1"
        activity={mk({
          workflowRunId: "r1",
          status: "paused_for_input",
          currentText: "Completeness 90% · Correctness 85% · Ready for handoff — Continue or send revisions.",
          sourceKind: "step_confirmation_pending",
        })}
        renderQuestionForm={unusedQuestionForm}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByText(/Completeness 90%/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("step-confirm-continue"));
    expect(onContinue).toHaveBeenCalledWith("r1");
  });
});

describe("pickLiveActivity", () => {
  it("returns the latest active/paused activity and null when none are live", () => {
    expect(
      pickLiveActivity([
        mk({ id: "c1", status: "completed", finalSummary: "done", sourceKind: "turn_completed" }),
        mk({ id: "live-1", currentText: "Older live activity" }),
        mk({ id: "live-2", status: "paused_for_input", currentText: "Latest live activity" }),
      ])?.id,
    ).toBe("live-2");

    expect(
      pickLiveActivity([
        mk({ id: "c1", status: "completed", finalSummary: "done", sourceKind: "turn_completed" }),
      ]),
    ).toBeNull();
  });
});

describe("isTimelineCard", () => {
  it("includes meaningful completed summaries and step results", () => {
    expect(
      isTimelineCard(mk({ status: "completed", finalSummary: "12/12 pass", sourceKind: "turn_completed" })),
    ).toBe(true);
    expect(isTimelineCard(mk({ status: "completed", sourceKind: "step_result", finalSummary: null }))).toBe(true);
  });

  it("excludes weak signals, expired blips, and whitespace-only summaries", () => {
    expect(
      isTimelineCard(mk({ status: "completed", finalSummary: "Still working", sourceKind: "weak_signal" })),
    ).toBe(false);
    expect(
      isTimelineCard(mk({ status: "expired", finalSummary: "Expired signal", sourceKind: "weak_signal" })),
    ).toBe(false);
    expect(
      isTimelineCard(mk({ status: "completed", finalSummary: "   ", sourceKind: "turn_completed" })),
    ).toBe(false);
  });
});

describe("ActivityCard", () => {
  it("renders a completed summary", () => {
    render(<ActivityCard activity={mk({ status: "completed", finalSummary: "12/12 pass", sourceKind: "turn_completed" })} />);
    expect(screen.getByTestId("activity-summary")).toHaveTextContent("12/12 pass");
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
    render(<ActivityCard activity={stepResultActivity()} />);
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
    render(<ActivityCard activity={failed} />);
    const card = screen.getByTestId("step-result-card");
    expect(card).toHaveTextContent("Evaluation failed");
    expect(card).not.toHaveTextContent("%");
  });
});
