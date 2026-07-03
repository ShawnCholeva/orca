import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  listOrchestrationAttempts: vi.fn(),
  listWorkflowRunArtifacts: vi.fn(),
  getWorkflowStepRun: vi.fn(),
  getOrchestrationWorker: vi.fn(),
  getWorkflowRunLedger: vi.fn(),
  submitHumanReviewDecision: vi.fn(),
  listTasks: vi.fn(),
  listSessions: vi.fn(),
  listContextPackages: vi.fn(),
  listWorkflowRunCompositions: vi.fn(),
  toErrorMessage: vi.fn((err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("../../api", () => apiMocks);

describe("WorkflowRunPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listWorkflowRunCompositions.mockResolvedValue({ compositions: [] });
  });

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
          adapterId: "claude-code",
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
    apiMocks.listOrchestrationAttempts.mockResolvedValue({
      attempts: [],
    });
    apiMocks.getWorkflowRunLedger.mockResolvedValue({
      committed: { version: 0, records: [] },
      versions: [],
    });

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="run-1" />);

    await waitFor(() => {
      expect(screen.getByText("orca/engineering · Issue Breakdown")).toBeInTheDocument();
    });

    expect(screen.getAllByText("advance: execution")).toHaveLength(2);
    expect(screen.getByText("workflow_step:Issue Breakdown (satisfied)")).toBeInTheDocument();
    expect(screen.getByText("artifact:Issue DAG (required)")).toBeInTheDocument();
    expect(screen.getByText("Implement workflow panel")).toBeInTheDocument();
  });

  it("shows transport fallback status and opens the debug drawer with sanitized worker diagnostics", async () => {
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
          decisionId: "dec-transport-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          decisionType: "select_operator",
          selectedAction: "recommend_operator:codex",
          reason: "Codex is the best available fit.",
          influencedBy: [],
          operatorSelectionJson: {
            operatorId: "codex",
            operatorKind: "agent",
            reason: "Strong repo editing support.",
            requiredCapabilities: ["planning"],
            alternativesConsidered: ["claude-code"],
            confidence: 0.82,
            requiresUserApproval: false,
          },
          transportSummary: {
            attemptId: "attempt-2",
            providerId: "orca/openai",
            modelId: "gpt-5",
            transport: "hidden_interactive",
            status: "succeeded",
            workerId: "worker-1",
            humanReviewId: null,
          },
          createdAt: now,
        },
      ],
    });
    apiMocks.listWorkflowRunArtifacts.mockResolvedValue({
      artifacts: [],
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
        satisfiedExitCriteria: [],
        outstandingExitCriteria: [],
      },
    });
    apiMocks.listTasks.mockResolvedValue({
      tasks: [],
      generations: [],
    });
    apiMocks.listSessions.mockResolvedValue({
      sessions: [],
    });
    apiMocks.listContextPackages.mockResolvedValue({
      packages: [],
      assemblies: [],
    });
    apiMocks.listOrchestrationAttempts.mockResolvedValue({
      attempts: [
        {
          id: "attempt-1",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          kind: "select_operator",
          providerId: "orca/openai",
          modelId: "gpt-5",
          transport: "one_shot",
          status: "fallback",
          failureReason: "one_shot_parse_failed",
          failureMessage: "invalid envelope",
          diagnostics: "one_shot_parse_failed: invalid envelope",
          workerId: null,
          startedAt: now,
          finishedAt: now,
          createdAt: now,
        },
        {
          id: "attempt-2",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          kind: "select_operator",
          providerId: "orca/openai",
          modelId: "gpt-5",
          transport: "hidden_interactive",
          status: "succeeded",
          failureReason: null,
          failureMessage: null,
          diagnostics: null,
          workerId: "worker-1",
          startedAt: now,
          finishedAt: now,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });
    apiMocks.getOrchestrationWorker.mockResolvedValue({
      worker: {
        id: "worker-1",
        providerId: "orca/openai",
        modelId: "gpt-5",
        state: "ready",
        currentGoalId: "goal-1",
        currentWorkflowRunId: "run-1",
        currentAttemptId: "attempt-2",
        failureReason: null,
        failureMessage: null,
        healthCheckedAt: "2026-01-01T00:02:00.000Z",
        createdAt: now,
        updatedAt: "2026-01-01T00:02:00.000Z",
        hookCapabilities: null,
        hookTraces: [],
        outputTail: "sanitized tail",
      },
    });
    apiMocks.getWorkflowRunLedger.mockResolvedValue({
      committed: { version: 0, records: [] },
      versions: [],
    });

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="run-1" />);

    expect((await screen.findAllByText("Fell back to interactive worker")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Debug transport" })[0]!);

    expect(await screen.findByRole("dialog", { name: "Transport Debug" })).toBeInTheDocument();
    expect(screen.getByText("Transport Debug")).toBeInTheDocument();
    expect(screen.getByText("Occurred")).toBeInTheDocument();
    expect(screen.getByText("Sanitized output tail")).toBeInTheDocument();
    expect(screen.getByText("sanitized tail")).toBeInTheDocument();
    expect(screen.getByText("Ready at 2026-01-01 00:02")).toBeInTheDocument();
    expect(screen.queryByText(/raw prompt/i)).not.toBeInTheDocument();
  });

  it("renders the pending human review form when the run falls back to human review", async () => {
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
    apiMocks.listWorkflowDecisions.mockResolvedValue({ decisions: [] });
    apiMocks.listWorkflowRunArtifacts.mockResolvedValue({ artifacts: [] });
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
        satisfiedExitCriteria: [],
        outstandingExitCriteria: [],
      },
    });
    apiMocks.listTasks.mockResolvedValue({ tasks: [], generations: [] });
    apiMocks.listSessions.mockResolvedValue({ sessions: [] });
    apiMocks.listContextPackages.mockResolvedValue({ packages: [], assemblies: [] });
    apiMocks.listOrchestrationAttempts.mockResolvedValue({
      attempts: [
        {
          id: "attempt-3",
          goalId: "goal-1",
          workflowRunId: "run-1",
          stepRunId: "step-2",
          kind: "select_operator",
          providerId: "orca/openai",
          modelId: "gpt-5",
          transport: "human_review",
          status: "pending",
          failureReason: null,
          failureMessage: null,
          diagnostics: null,
          workerId: null,
          startedAt: now,
          finishedAt: null,
          createdAt: now,
          humanReview: {
            id: "review-1",
            goalId: "goal-1",
            workflowRunId: "run-1",
            stepRunId: "step-2",
            attemptId: "attempt-3",
            kind: "select_operator",
            providerId: "orca/openai",
            modelId: "gpt-5",
            title: "Choose an operator",
            summary:
              "Step purpose: Pick the best operator for implementation\nFailed transports: one_shot:fallback:one_shot_parse_failed",
            choices: [
              {
                id: "human",
                label: "human",
                description: "Continue with explicit human supervision.",
                proposal: {
                  orcaProposalVersion: 1,
                  kind: "select_operator",
                  payload: {
                    operatorId: "human",
                    operatorKind: "human",
                    reason: "Human review fallback",
                    requiredCapabilities: [],
                    alternativesConsidered: [],
                    confidence: 0.5,
                    requiresUserApproval: false,
                  },
                },
              },
            ],
            createdAt: now,
          },
        },
      ],
    });
    apiMocks.getWorkflowRunLedger.mockResolvedValue({
      committed: { version: 0, records: [] },
      versions: [],
    });

    render(<WorkflowRunPanel goalId="goal-1" initialRunId="run-1" />);

    expect(await screen.findByText("Human Review Required")).toBeInTheDocument();
    expect(screen.getByText("Pick the best operator for implementation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit review" })).toBeInTheDocument();
  });
});
