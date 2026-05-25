import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRunPanel } from "./WorkflowRunPanel";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

const apiMocks = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
  listWorkflowDecisions: vi.fn(),
  listWorkflowRunArtifacts: vi.fn(),
  getWorkflowStepRun: vi.fn(),
  listTasks: vi.fn(),
  listSessions: vi.fn(),
  listContextPackages: vi.fn(),
  toErrorMessage: vi.fn((err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("../../api", () => apiMocks);

describe("WorkflowRunPanel", () => {
  it("renders the active run with influenced-by chips and linked tasks", async () => {
    apiMocks.listWorkflowRuns.mockResolvedValue({
      runs: [
        {
          id: "run-1",
          goalId: "goal-1",
          templateId: "orca/engineering",
          templateVersion: 1,
          status: "active",
          currentStepRunId: "step-2",
          startedAt: now,
          finishedAt: null,
          blockedReason: null,
        },
      ],
    });
    apiMocks.getWorkflowRun.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: "step-2",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
      },
    });
    apiMocks.listWorkflowDecisions.mockResolvedValue({
      decisions: [
        {
          decisionId: "dec-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          decisionType: "advance_step",
          selectedAction: "recommend_advance:execution",
          reason: "Issue Breakdown is complete.",
          influencedBy: [
            {
              kind: "workflow_step",
              id: "issue_breakdown",
              label: "Issue Breakdown",
              effect: "satisfied",
            },
            {
              kind: "artifact",
              id: "art-1",
              label: "Issue DAG",
              effect: "required",
            },
          ],
          createdAt: now,
        },
      ],
    });
    apiMocks.listWorkflowRunArtifacts.mockResolvedValue({
      artifacts: [
        {
          id: "art-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          type: "issue_breakdown",
          title: "Issue DAG",
          body: "Task graph",
          source: "orchestrator",
          linkedSessionId: null,
          linkedTaskId: "task-1",
          linkedContextPackageId: null,
          createdAt: now,
        },
      ],
    });
    apiMocks.getWorkflowStepRun.mockResolvedValue({
      stepRun: {
        id: "step-2",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepTemplateId: "issue_breakdown",
        ordinal: 3,
        attempt: 1,
        status: "active",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
        satisfiedExitCriteria: ["draft tasks captured"],
        outstandingExitCriteria: ["dependencies validated"],
      },
    });
    apiMocks.listTasks.mockResolvedValue({
      tasks: [
        {
          id: "task-1",
          goalId: "goal-1",
          parentTaskId: null,
          workspaceId: null,
          role: "engineer",
          status: "open",
          origin: "generator",
          title: "Implement workflow panel",
          description: "",
          acceptanceCriteria: [],
          validationSteps: [{ id: "val-1", text: "Run tests", kind: "test" }],
          dependencies: [],
          sources: [],
          generationId: null,
          workflowStepRunId: "step-2",
          fingerprint: "task-1",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
      ],
      generations: [],
    });
    apiMocks.listSessions.mockResolvedValue({
      sessions: [
        {
          id: "session-1",
          goalId: "goal-1",
          workspaceId: "ws-1",
          adapterId: "shell-manual",
          contextPackageId: null,
          taskId: "task-1",
          fromRecommendationId: null,
          workflowStepRunId: "step-2",
          role: "engineer",
          title: "Manual session",
          status: "created",
          createdAt: now,
          startedAt: null,
          exitedAt: null,
        },
      ],
    });
    apiMocks.listContextPackages.mockResolvedValue({
      packages: [],
      assemblies: [],
    });

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText("Engineering workflow · Issue Breakdown")).toBeInTheDocument();
    });

    expect(screen.getAllByText("advance: execution")).toHaveLength(2);
    expect(screen.getByText("workflow_step:Issue Breakdown (satisfied)")).toBeInTheDocument();
    expect(screen.getByText("artifact:Issue DAG (required)")).toBeInTheDocument();
    expect(screen.getByText("Implement workflow panel")).toBeInTheDocument();
  });
});
