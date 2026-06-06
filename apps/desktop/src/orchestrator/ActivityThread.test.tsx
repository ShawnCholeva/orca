import { render, screen } from "@testing-library/react";
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
