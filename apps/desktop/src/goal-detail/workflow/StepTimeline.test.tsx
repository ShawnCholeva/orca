import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepTimeline } from "./StepTimeline";

const now = "2026-01-01T00:00:00.000Z";

describe("StepTimeline", () => {
  it("renders ordered steps and marks the current step", () => {
    render(
      <StepTimeline
        currentStepRunId="step-2"
        steps={[
          {
            id: "step-1",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepTemplateId: "research",
            ordinal: 1,
            attempt: 1,
            status: "passed",
            startedAt: now,
            finishedAt: now,
            blockedReason: null,
            stepResult: null,
          },
          {
            id: "step-2",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepTemplateId: "issue_breakdown",
            ordinal: 2,
            attempt: 1,
            status: "active",
            startedAt: now,
            finishedAt: null,
            blockedReason: null,
            stepResult: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Issue Breakdown")).toBeInTheDocument();
    expect(screen.getByText(/active · current/i)).toBeInTheDocument();
  });
});
