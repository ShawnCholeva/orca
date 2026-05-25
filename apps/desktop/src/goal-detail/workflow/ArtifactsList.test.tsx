import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactsList } from "./ArtifactsList";

const now = "2026-01-01T00:00:00.000Z";

describe("ArtifactsList", () => {
  it("groups artifacts by step and includes run-level artifacts", () => {
    render(
      <ArtifactsList
        stepRuns={[
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
            satisfiedExitCriteria: [],
            outstandingExitCriteria: [],
          },
        ]}
        artifacts={[
          {
            id: "art-1",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepRunId: "step-1",
            type: "research_summary",
            title: "Research notes",
            body: "Bounded notes",
            source: "orchestrator",
            linkedSessionId: null,
            linkedTaskId: "task-1",
            linkedContextPackageId: null,
            createdAt: now,
          },
          {
            id: "art-2",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepRunId: null,
            type: "final_summary",
            title: "Final wrap-up",
            body: "Done",
            source: "system",
            linkedSessionId: "session-1",
            linkedTaskId: null,
            linkedContextPackageId: null,
            createdAt: now,
          },
        ]}
      />,
    );

    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Run-level")).toBeInTheDocument();
    expect(screen.getByText("Research notes")).toBeInTheDocument();
    expect(screen.getByText("Final wrap-up")).toBeInTheDocument();
  });
});
