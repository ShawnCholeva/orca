import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, Recommendation } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const acceptRecommendationMock = vi.fn();
const createOrchestratorMessageMock = vi.fn();
const dismissRecommendationMock = vi.fn();
const getGoalDetailMock = vi.fn();
const getWorkflowRunMock = vi.fn();
const getWorkflowStepRunMock = vi.fn();
const listOrchestratorMessagesMock = vi.fn();
const listRecommendationsMock = vi.fn();
const listWorkflowDecisionsMock = vi.fn();
const listWorkflowRunArtifactsMock = vi.fn();
const openEventStreamMock = vi.fn();
const rejectRecommendationMock = vi.fn();
const requestNextOrchestratorDecisionMock = vi.fn();
const startWorkflowRunMock = vi.fn();
const submitWorkflowUserInputMock = vi.fn();

vi.mock("../api", () => ({
  acceptRecommendation: (...args: unknown[]) => acceptRecommendationMock(...args),
  createOrchestratorMessage: (...args: unknown[]) => createOrchestratorMessageMock(...args),
  dismissRecommendation: (...args: unknown[]) => dismissRecommendationMock(...args),
  getGoalDetail: (...args: unknown[]) => getGoalDetailMock(...args),
  getWorkflowRun: (...args: unknown[]) => getWorkflowRunMock(...args),
  getWorkflowStepRun: (...args: unknown[]) => getWorkflowStepRunMock(...args),
  listOrchestratorMessages: (...args: unknown[]) => listOrchestratorMessagesMock(...args),
  listRecommendations: (...args: unknown[]) => listRecommendationsMock(...args),
  listWorkflowDecisions: (...args: unknown[]) => listWorkflowDecisionsMock(...args),
  listWorkflowRunArtifacts: (...args: unknown[]) => listWorkflowRunArtifactsMock(...args),
  openEventStream: (...args: unknown[]) => openEventStreamMock(...args),
  rejectRecommendation: (...args: unknown[]) => rejectRecommendationMock(...args),
  requestNextOrchestratorDecision: (...args: unknown[]) => requestNextOrchestratorDecisionMock(...args),
  startWorkflowRun: (...args: unknown[]) => startWorkflowRunMock(...args),
  submitWorkflowUserInput: (...args: unknown[]) => submitWorkflowUserInputMock(...args),
  toErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

vi.mock("../goal-detail/sessions/CreateSessionDialog", () => ({
  CreateSessionDialog: ({
    prefill,
  }: {
    prefill?: {
      adapterId: string;
      objective: string;
      workflowStepRunId?: string;
    } | null;
  }) => (
    <div data-testid="create-session-dialog">
      {prefill?.adapterId}:{prefill?.workflowStepRunId}:{prefill?.objective}
    </div>
  ),
}));

const now = "2026-01-01T00:00:00.000Z";

const goal: Goal = {
  id: "goal-1",
  title: "Ship Engineering workflow chat",
  description: "Goal description",
  status: "active",
  autonomyLevel: 1,
  orchestratorProvider: "orca/openai",
  orchestratorModel: "gpt-5",
  activeWorkflowRunId: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const userMessage = {
  id: "msg-user",
  goalId: "goal-1",
  role: "user" as const,
  kind: "message" as const,
  body: "Need a rollout plan.",
  correlationId: "corr-1",
  createdAt: now,
};

const orcaMessage = {
  id: "msg-orca",
  goalId: "goal-1",
  role: "orchestrator" as const,
  kind: "message" as const,
  body: "Start with a bounded verification pass.",
  correlationId: "corr-1",
  createdAt: now,
};

function workflowRecommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id: "rec-1",
    goalId: "goal-1",
    type: "request_user_input",
    status: "proposed",
    source: "deterministic_provider",
    title: "Answer intake question",
    rationale: "Need the initial problem statement.",
    proposedAction: {
      kind: "request_user_input",
      workflowStepRunId: "step-1",
      question: "What problem are we solving?",
    },
    confidence: 0.8,
    sources: [],
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPackageId: null,
    relatedConflictId: null,
    generationId: null,
    workflowStepRunId: "step-1",
    fingerprint: "rec-fp-1",
    supersededById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupRunLoad(rec: Recommendation) {
  getGoalDetailMock.mockResolvedValue({
    goal: { ...goal, activeWorkflowRunId: "run-1" },
    refinement: null,
    workspaces: [{ id: "ws-1", goalId: "goal-1", path: "/tmp/ws", name: "workspace", workspaceType: "folder", branch: null, isDirty: null, gitProbe: "not_a_repo", attachedAt: now }],
  });
  getWorkflowRunMock.mockResolvedValue({
    run: {
      id: "run-1",
      goalId: "goal-1",
      templateId: "orca/engineering",
      templateVersion: 1,
      status: "active",
      currentStepRunId: "step-1",
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
    },
  });
  getWorkflowStepRunMock.mockResolvedValue({
    stepRun: {
      id: "step-1",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepTemplateId: "execution",
      ordinal: 4,
      attempt: 1,
      status: "active",
      startedAt: now,
      finishedAt: null,
      blockedReason: null,
      satisfiedExitCriteria: [],
      outstandingExitCriteria: ["assigned task completed or blocked with reason"],
    },
  });
  listWorkflowDecisionsMock.mockResolvedValue({
    decisions: [
      {
        decisionId: "dec-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "select_operator",
        selectedAction: "request_input:intake",
        reason: "Need user input before proceeding.",
        influencedBy: [],
        createdAt: now,
      },
    ],
  });
  listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });
  listRecommendationsMock.mockResolvedValue({ recommendations: [rec], generations: [] });
}

describe("OrcaChat", () => {
  beforeEach(() => {
    acceptRecommendationMock.mockReset();
    createOrchestratorMessageMock.mockReset();
    dismissRecommendationMock.mockReset();
    getGoalDetailMock.mockReset();
    getWorkflowRunMock.mockReset();
    getWorkflowStepRunMock.mockReset();
    listOrchestratorMessagesMock.mockReset();
    listRecommendationsMock.mockReset();
    listWorkflowDecisionsMock.mockReset();
    listWorkflowRunArtifactsMock.mockReset();
    rejectRecommendationMock.mockReset();
    requestNextOrchestratorDecisionMock.mockReset();
    startWorkflowRunMock.mockReset();
    submitWorkflowUserInputMock.mockReset();
    openEventStreamMock.mockReset();
    openEventStreamMock.mockReturnValue({ close: vi.fn() });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
  });

  it("shows a goal prompt and no composer when no goal is selected", async () => {
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId={null}
        connectionStatus="open"
      />,
    );

    expect(screen.getByText("Select a goal")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Message Orca…")).toBeNull();
  });

  it("shows the composer even when there are no pending workflow recommendations", async () => {
    setupRunLoad(workflowRecommendation());
    listRecommendationsMock.mockResolvedValue({ recommendations: [], generations: [] });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    expect(await screen.findByText("No pending workflow recommendations")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
  });

  it("does not show provider metadata on the initial goal message", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    expect(await screen.findByText("Engineering workflow ready")).toBeInTheDocument();
    expect(screen.queryByText(/orca\/openai/)).toBeNull();
  });

  it("loads persisted messages and sends a freeform orchestrator message", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [userMessage, orcaMessage] });
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-user-2", body: "Keep this scoped." },
      reply: { ...orcaMessage, id: "msg-orca-2", body: "I will keep it bounded." },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    expect(await screen.findByText("Need a rollout plan.")).toBeInTheDocument();
    expect(screen.getByText("Start with a bounded verification pass.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Keep this scoped." },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "Keep this scoped.",
      });
    });
    expect(await screen.findByText("I will keep it bounded.")).toBeInTheDocument();
  });

  it("starts the Engineering workflow for a selected goal", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    startWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: "step-1",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
      },
    });
    requestNextOrchestratorDecisionMock.mockResolvedValue({
      decision: {
        decisionId: "dec-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        decisionType: "request_user_input",
        selectedAction: "request_input:intake",
        reason: "Need the goal brief.",
        influencedBy: [],
        createdAt: now,
      },
      recommendationIds: ["rec-1"],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    fireEvent.click(await screen.findByText("Start Engineering workflow"));

    await waitFor(() => {
      expect(startWorkflowRunMock).toHaveBeenCalledWith("goal-1", {
        goalId: "goal-1",
        templateId: "orca/engineering",
      });
    });
    expect(requestNextOrchestratorDecisionMock).toHaveBeenCalledWith(
      "goal-1",
      "run-1",
      { workflowRunId: "run-1" },
    );
  });

  it("accepts a request_user_input recommendation and submits the answer", async () => {
    setupRunLoad(workflowRecommendation());
    acceptRecommendationMock.mockResolvedValue({
      recommendation: workflowRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "request_user_input",
        workflowStepRunId: "step-1",
        question: "What problem are we solving?",
      },
      feedback: {
        id: "fb-1",
        goalId: "goal-1",
        recommendationId: "rec-1",
        action: "accept",
        note: null,
        modifiedPayloadJson: null,
        createdAt: now,
      },
    });
    submitWorkflowUserInputMock.mockResolvedValue({
      stepRun: {
        id: "step-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepTemplateId: "intake",
        ordinal: 0,
        attempt: 1,
        status: "active",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
        satisfiedExitCriteria: ["goal brief captured"],
        outstandingExitCriteria: [],
      },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    fireEvent.click(await screen.findByText("Accept"));
    expect(await screen.findByText("User input requested")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Answer the intake question…"), {
      target: { value: "We need a deterministic workflow chat." },
    });
    fireEvent.click(screen.getByText("Submit"));

    await waitFor(() => {
      expect(submitWorkflowUserInputMock).toHaveBeenCalledWith("goal-1", "step-1", {
        stepRunId: "step-1",
        answerText: "We need a deterministic workflow chat.",
      });
    });
  });

  it("restores the input composer when a request_user_input recommendation was already accepted", async () => {
    setupRunLoad(workflowRecommendation({ status: "accepted" }));
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    expect(await screen.findByText("User input requested")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Answer the intake question…")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
  });

  it("accepts a launch_workflow_session recommendation and opens the session dialog with workflowStepRunId", async () => {
    setupRunLoad(
      workflowRecommendation({
        type: "launch_workflow_session",
        title: "Launch implementation session",
        rationale: "Execution can start.",
        proposedAction: {
          kind: "launch_workflow_session",
          workflowStepRunId: "step-1",
          operatorId: "agent:codex",
          operatorKind: "agent",
          objective: "Implement the next task",
        },
      }),
    );
    acceptRecommendationMock.mockResolvedValue({
      recommendation: workflowRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "launch_workflow_session",
        workflowStepRunId: "step-1",
        operatorId: "agent:codex",
        operatorKind: "agent",
        objective: "Implement the next task",
      },
      feedback: {
        id: "fb-1",
        goalId: "goal-1",
        recommendationId: "rec-1",
        action: "accept",
        note: null,
        modifiedPayloadJson: null,
        createdAt: now,
      },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    fireEvent.click(await screen.findByText("Accept"));

    expect(await screen.findByTestId("create-session-dialog")).toHaveTextContent(
      "codex:step-1:Implement the next task",
    );
  });
});
