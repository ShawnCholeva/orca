import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkflowBanner } from "./WorkflowBanner";

const now = "2026-01-01T00:00:00.000Z";

describe("WorkflowBanner", () => {
  it("renders run state, next action, and artifacts", () => {
    render(
      <WorkflowBanner
        run={{
          id: "run-1",
          goalId: "goal-1",
          templateId: "orca/engineering",
          templateVersion: 1,
          status: "active",
          currentStepRunId: "step-1",
          startedAt: now,
          finishedAt: null,
          blockedReason: null,
        }}
        stepRun={{
          id: "step-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepTemplateId: "issue_breakdown",
          ordinal: 3,
          attempt: 1,
          status: "active",
          startedAt: now,
          finishedAt: null,
          blockedReason: null,
          stepResult: null,
        }}
        latestDecision={{
          decisionId: "dec-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-1",
          decisionType: "advance_step",
          selectedAction: "recommend_advance:execution",
          reason: "The current step criteria are complete.",
          influencedBy: [
            {
              kind: "workflow_step",
              id: "issue_breakdown",
              label: "Issue Breakdown",
              effect: "satisfied",
            },
          ],
          createdAt: now,
        }}
        artifacts={[
          {
            id: "art-1",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepRunId: "step-1",
            type: "issue_breakdown",
            title: "Issue DAG",
            body: "{}",
            source: "orchestrator",
            linkedSessionId: null,
            linkedTaskId: null,
            linkedContextPackageId: null,
            createdAt: now,
          },
        ]}
      />,
    );

    expect(screen.getByText("Engineering workflow · Issue Breakdown")).toBeInTheDocument();
    expect(screen.getByText("advance:execution")).toBeInTheDocument();
    expect(screen.getByText("Why this action?")).toBeInTheDocument();
    expect(screen.getByText("Issue DAG")).toBeInTheDocument();
  });
});
