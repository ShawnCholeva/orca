import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Goal, OrchestratorChatMessage } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const confirmStepMock = vi.fn();
const createOrchestratorMessageMock = vi.fn();
const getGoalDetailMock = vi.fn();
const getWorkflowRunMock = vi.fn();
const getWorkflowStepRunMock = vi.fn();
const getWorkflowTemplateMock = vi.fn();
const listActivitiesMock = vi.fn();
const listOrchestratorMessagesMock = vi.fn();
const listWorkflowDecisionsMock = vi.fn();
const listWorkflowRunArtifactsMock = vi.fn();
const openEventStreamMock = vi.fn();
const requestNextOrchestratorDecisionMock = vi.fn();
const listWorkflowTemplatesMock = vi.fn();
const startWorkflowRunMock = vi.fn();
const submitWorkerAnswersMock = vi.fn();
const submitWorkerFreeTextMock = vi.fn();
const submitPermissionDecisionMock = vi.fn();
const setWorkerPermissionModeMock = vi.fn();
const waitForProviderRecoveryMock = vi.fn();
const retryProviderRecoveryMock = vi.fn();
const refreshProviderRecoveryMock = vi.fn();
const switchProviderRecoveryMock = vi.fn();

vi.mock("../api", () => ({
  confirmStep: (...args: unknown[]) => confirmStepMock(...args),
  createOrchestratorMessage: (...args: unknown[]) => createOrchestratorMessageMock(...args),
  getGoalDetail: (...args: unknown[]) => getGoalDetailMock(...args),
  getWorkflowRun: (...args: unknown[]) => getWorkflowRunMock(...args),
  getWorkflowStepRun: (...args: unknown[]) => getWorkflowStepRunMock(...args),
  getWorkflowTemplate: (...args: unknown[]) => getWorkflowTemplateMock(...args),
  listActivities: (...args: unknown[]) => listActivitiesMock(...args),
  listOrchestratorMessages: (...args: unknown[]) => listOrchestratorMessagesMock(...args),
  listWorkflowDecisions: (...args: unknown[]) => listWorkflowDecisionsMock(...args),
  listWorkflowRunArtifacts: (...args: unknown[]) => listWorkflowRunArtifactsMock(...args),
  openEventStream: (...args: unknown[]) => openEventStreamMock(...args),
  requestNextOrchestratorDecision: (...args: unknown[]) => requestNextOrchestratorDecisionMock(...args),
  listWorkflowTemplates: (...args: unknown[]) => listWorkflowTemplatesMock(...args),
  startWorkflowRun: (...args: unknown[]) => startWorkflowRunMock(...args),
  submitWorkerAnswers: (...args: unknown[]) => submitWorkerAnswersMock(...args),
  submitWorkerFreeText: (...args: unknown[]) => submitWorkerFreeTextMock(...args),
  submitPermissionDecision: (...args: unknown[]) => submitPermissionDecisionMock(...args),
  setWorkerPermissionMode: (...args: unknown[]) => setWorkerPermissionModeMock(...args),
  waitForProviderRecovery: (...args: unknown[]) => waitForProviderRecoveryMock(...args),
  retryProviderRecovery: (...args: unknown[]) => retryProviderRecoveryMock(...args),
  refreshProviderRecovery: (...args: unknown[]) => refreshProviderRecoveryMock(...args),
  switchProviderRecovery: (...args: unknown[]) => switchProviderRecoveryMock(...args),
  toErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

const now = "2026-01-01T00:00:00.000Z";

const goal: Goal = {
  id: "goal-1",
  title: "Ship Engineering workflow chat",
  description: "Goal description",
  status: "active",
  autonomyLevel: 1,
  workerPermissionMode: "ask",
  orchestratorProvider: "orca/openai",
  orchestratorModel: "gpt-5",
  activeWorkflowRunId: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const goal2: Goal = {
  ...goal,
  id: "goal-2",
  title: "Ship another workflow",
};

const userMessage: OrchestratorChatMessage = {
  id: "msg-user",
  goalId: "goal-1",
  role: "user",
  kind: "message",
  body: "Need a rollout plan.",
  correlationId: "corr-1",
  createdAt: now,
};

const orcaMessage: OrchestratorChatMessage = {
  id: "msg-orca",
  goalId: "goal-1",
  role: "orchestrator",
  kind: "message",
  body: "Start with a bounded verification pass.",
  correlationId: "corr-1",
  createdAt: now,
};

const activeActivity: Activity = {
  id: "activity-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  agentSessionId: null,
  turnOrdinal: 0,
  status: "active",
  currentText: "Reading through the codebase...",
  finalSummary: null,
  sourceKind: "tool_use",
  workCategory: "reading",
  confidence: "high",
  steps: [],
  createdAt: now,
  updatedAt: now,
  completedAt: null,
};

function pausedActivity(
  questionId: string,
  optionLabel: string,
  currentText = "I need your input.",
): Activity {
  return {
    ...activeActivity,
    id: `activity-${questionId}`,
    status: "paused_for_input",
    currentText,
    sourceKind: "question_pending",
    pendingQuestion: {
      questionId,
      toolUseId: `tool-${questionId}`,
      questions: [
        {
          header: "Approach",
          question: `Question ${questionId}?`,
          multiSelect: false,
          options: [{ label: optionLabel, description: "Option description" }],
        },
      ],
    },
  };
}

function setupRunLoad() {
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
    },
  });
  listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
  listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });
}

describe("OrcaChat", () => {
  beforeEach(() => {
    confirmStepMock.mockReset();
    confirmStepMock.mockResolvedValue(undefined);
    createOrchestratorMessageMock.mockReset();
    getGoalDetailMock.mockReset();
    getWorkflowRunMock.mockReset();
    getWorkflowStepRunMock.mockReset();
    getWorkflowTemplateMock.mockReset();
    getWorkflowTemplateMock.mockResolvedValue({
      template: { steps: [{ id: "execution", ordinal: 4, name: "Build It" }] },
    });
    listActivitiesMock.mockReset();
    listActivitiesMock.mockResolvedValue([]);
    listOrchestratorMessagesMock.mockReset();
    listWorkflowDecisionsMock.mockReset();
    listWorkflowRunArtifactsMock.mockReset();
    requestNextOrchestratorDecisionMock.mockReset();
    listWorkflowTemplatesMock.mockReset();
    listWorkflowTemplatesMock.mockResolvedValue({ templates: [] });
    startWorkflowRunMock.mockReset();
    submitWorkerAnswersMock.mockReset();
    submitWorkerAnswersMock.mockResolvedValue(undefined);
    submitWorkerFreeTextMock.mockReset();
    submitWorkerFreeTextMock.mockResolvedValue(undefined);
    submitPermissionDecisionMock.mockReset();
    submitPermissionDecisionMock.mockResolvedValue(undefined);
    setWorkerPermissionModeMock.mockReset();
    setWorkerPermissionModeMock.mockResolvedValue(undefined);
    openEventStreamMock.mockReset();
    openEventStreamMock.mockReturnValue({ close: vi.fn() });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    waitForProviderRecoveryMock.mockReset();
    waitForProviderRecoveryMock.mockResolvedValue(undefined);
    retryProviderRecoveryMock.mockReset();
    retryProviderRecoveryMock.mockResolvedValue(undefined);
    refreshProviderRecoveryMock.mockReset();
    refreshProviderRecoveryMock.mockResolvedValue(undefined);
    switchProviderRecoveryMock.mockReset();
    switchProviderRecoveryMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks(); // undo any Date.now() spy so elapsed-time tests don't leak
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

  it("shows the starting indicator while run and step are active and Orca has not spoken", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    // ordinal is 4 → "Step 5"; the resolved-name variant is covered separately.
    expect(indicator).toHaveTextContent("Step 5");
    expect(indicator).toHaveTextContent("starting");
  });

  it("hides the starting indicator once an orchestrator message exists", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [orcaMessage] });
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    // Wait for the orchestrator message to land, then assert the indicator is absent.
    expect(await screen.findByText("Start with a bounded verification pass.")).toBeInTheDocument();
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });

  it("hides the starting indicator once the step has finished, even while the run awaits completion approval", async () => {
    setupRunLoad();
    // Final step: agent produced its output (finished_at set) but the step run is
    // held active pending the complete_workflow_run approval. Not "starting".
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
        finishedAt: "2026-01-01T00:01:00.000Z",
        blockedReason: null,
      },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByPlaceholderText("Message Orca…")).toBeInTheDocument();
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });

  it("does not render the goal title/description header card", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    // Composer is the reliable "goal is selected" signal now that the header
    // card is gone (the goal title lives in the goal rail, not in OrcaChat).
    expect(await screen.findByPlaceholderText("Message Orca…")).toBeInTheDocument();
    // The goal title/description header card no longer renders inside the chat.
    expect(screen.queryByText("Ship Engineering workflow chat")).toBeNull();
    expect(screen.queryByText("Goal description")).toBeNull();
  });

  it("shows the no-model SystemCard when the goal lacks an orchestrator model", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, orchestratorProvider: null, orchestratorModel: null },
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

    expect(await screen.findByText("Goal needs an orchestrator model")).toBeInTheDocument();
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

    expect(await screen.findByText("No workflow running")).toBeInTheDocument();
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

  it("interleaves step-result cards with messages in createdAt order", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        { ...userMessage, id: "m1", body: "First user message", createdAt: "2026-06-09T00:00:01.000Z" },
        { ...orcaMessage, id: "m2", body: "Later orchestrator reply", createdAt: "2026-06-09T00:00:03.000Z" },
      ],
    });
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        id: "card1",
        status: "completed",
        currentText: "",
        finalSummary: null,
        sourceKind: "step_result",
        stepName: "Investigate",
        createdAt: "2026-06-09T00:00:02.000Z",
        updatedAt: "2026-06-09T00:00:02.000Z",
        completedAt: "2026-06-09T00:00:02.000Z",
        stepResult: {
          stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 0.82,
          quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 },
          performance: { durationSeconds: 96, retries: 0 },
          outcome: { reason: "Output complete.", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
        },
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const userMsg = await screen.findByText("First user message");
    const card = await screen.findByTestId("step-result-card");
    const orcaMsg = screen.getByText("Later orchestrator reply");

    // Timeline order must be t1 (user) → t2 (card) → t3 (orchestrator).
    expect(userMsg.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(orcaMsg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("pins the starting indicator to the tail, after the latest message", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [{ ...userMessage, id: "m1", body: "User said something", createdAt: now }],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const userMsg = await screen.findByText("User said something");
    const indicator = await screen.findByTestId("step-starting");
    // The "starting" hint trails the conversation instead of floating above it.
    expect(userMsg.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts a workflow via recovery card for a goal with no run", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    listWorkflowTemplatesMock.mockResolvedValue({
      templates: [{ id: "orca/engineering", name: "Engineering", description: null, version: 1, steps: [] }],
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

    // Expand recovery form
    fireEvent.click(await screen.findByText("Start Workflow"));

    // Select the template
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "orca/engineering" } });

    // Submit
    fireEvent.click(screen.getByText("Start"));

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

  it("renders an agent-activity card for a tool_use activity with steps", async () => {
    setupRunLoad();
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        steps: [
          { id: "s1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: now },
          { id: "s2", text: "Ran tests: pnpm test", category: "testing", status: "active", createdAt: now },
        ],
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("agent-activity")).toBeInTheDocument();
    expect(screen.queryByText("routing")).not.toBeInTheDocument();
  });

  it("refreshes the visible activity when activity.changed arrives without resubscribing", async () => {
    setupRunLoad();
    const stepBase = { category: "reading" as const, status: "active" as const, createdAt: now };
    listActivitiesMock
      .mockResolvedValueOnce([
        { ...activeActivity, steps: [{ id: "s1", text: "Reading the old implementation...", ...stepBase }] },
      ])
      .mockResolvedValueOnce([
        { ...activeActivity, steps: [{ id: "s1", text: "Reading the updated implementation...", ...stepBase }] },
      ]);
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
        capturedOnEvent = onEvent;
        return { close: vi.fn() };
      },
    );
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("agent-activity")).toBeInTheDocument();
    expect(screen.getByText("Reading the old implementation...")).toBeInTheDocument();
    expect(capturedOnEvent).not.toBeNull();
    act(() => {
      capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });
    });

    expect(await screen.findByText("Reading the updated implementation...")).toBeInTheDocument();
    expect(screen.getAllByTestId("agent-activity")).toHaveLength(1);
    expect(listActivitiesMock).toHaveBeenCalledTimes(2);
    expect(openEventStreamMock).toHaveBeenCalledTimes(1);
  });

  it("does not submit a goal-1 worker answer to goal-2 after switching goals", async () => {
    getGoalDetailMock.mockImplementation((goalId: string) => {
      if (goalId === "goal-1") {
        return Promise.resolve({ goal, refinement: null, workspaces: [] });
      }
      return new Promise(() => {});
    });
    listOrchestratorMessagesMock.mockImplementation((goalId: string) => {
      if (goalId === "goal-1") {
        return Promise.resolve({
          messages: [
            {
              id: "wq-1", goalId: "goal-1", role: "orchestrator", kind: "message",
              body: "I need your input.", correlationId: null, createdAt: now,
              pendingQuestion: {
                questionId: "q1", toolUseId: "t1", source: "worker",
                questions: [{ header: "Approach", question: "Question q1?", multiSelect: false,
                  options: [{ label: "Keep goal one", description: "Option description" }] }],
              },
            },
          ],
        });
      }
      return new Promise(() => {});
    });
    const { OrcaChat } = await import("./OrcaChat");

    const { rerender } = render(
      <OrcaChat
        goals={[goal, goal2]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    await screen.findByText("Question q1?");
    fireEvent.click(screen.getByRole("radio", { name: /Keep goal one/ }));

    rerender(
      <OrcaChat
        goals={[goal, goal2]}
        selectedGoalId="goal-2"
        connectionStatus="open"
      />,
    );

    // Any stale submit button on screen must not route to goal-2.
    const staleSubmit = screen.queryByRole("button", { name: /send answer/i });
    if (staleSubmit) fireEvent.click(staleSubmit);
    expect(submitWorkerAnswersMock).not.toHaveBeenCalledWith(
      "goal-2",
      "q1",
      expect.anything(),
    );
  });

  it("keeps the current same-goal activity when an activity refresh fails", async () => {
    setupRunLoad();
    listActivitiesMock
      .mockResolvedValueOnce([
        {
          ...activeActivity,
          steps: [{ id: "s1", text: "Testing the current implementation...", category: "testing", status: "active", createdAt: now }],
        },
      ])
      .mockRejectedValueOnce(new Error("refresh failed"));
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
        capturedOnEvent = onEvent;
        return { close: vi.fn() };
      },
    );
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("agent-activity")).toBeInTheDocument();
    expect(screen.getByText("Testing the current implementation...")).toBeInTheDocument();
    act(() => {
      capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });
    });

    await waitFor(() => expect(listActivitiesMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("agent-activity")).toBeInTheDocument();
    expect(screen.getByText("Testing the current implementation...")).toBeInTheDocument();
  });

  it("does not show the step-starting indicator when a live activity exists", async () => {
    setupRunLoad();
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        steps: [{ id: "s1", text: "Reading through the codebase...", category: "reading", status: "active", createdAt: now }],
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("agent-activity")).toBeInTheDocument();
    await waitFor(() => expect(getWorkflowTemplateMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("step-starting")).not.toBeInTheDocument();
  });

  it("shows a Recommended badge but submits the original option label", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "wq-1", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need your call on the implementation approach.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "question-1", toolUseId: "tool-1", source: "worker",
            questions: [
              {
                header: "Approach",
                question: "Which approach should I use?",
                multiSelect: false,
                options: [
                  { label: "Use hooks (Recommended)", description: "Matches the existing integration." },
                  { label: "Poll the API", description: "Adds a separate refresh loop." },
                ],
              },
            ],
          },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which approach should I use?");
    expect(screen.getByText("Use hooks", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Recommended", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Use hooks (Recommended)", { exact: true })).not.toBeInTheDocument();

    const recommendedOption = screen.getByRole("radio", {
      name: "Use hooks (Recommended)",
    });
    expect(recommendedOption).toHaveAccessibleName("Use hooks (Recommended)");
    fireEvent.click(recommendedOption);
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() =>
      expect(submitWorkerAnswersMock).toHaveBeenCalledWith(
        "goal-1",
        "question-1",
        [{ questionIndex: 0, selectedLabels: ["Use hooks (Recommended)"] }],
      ),
    );
  });

  it("offers 'Something else' on a live worker question and submits free text", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "wq-1", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need your call on the approach.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "question-1", toolUseId: "tool-1", source: "worker",
            questions: [
              {
                header: "Approach",
                question: "Which approach should I use?",
                multiSelect: false,
                options: [
                  { label: "Use hooks", description: "Matches the existing integration." },
                  { label: "Poll the API", description: "Adds a separate refresh loop." },
                ],
              },
            ],
          },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which approach should I use?");
    fireEvent.click(screen.getByRole("radio", { name: /something else/i }));
    fireEvent.change(screen.getByPlaceholderText(/your own answer/i), {
      target: { value: "a dedicated workspaces tab" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() =>
      expect(submitWorkerFreeTextMock).toHaveBeenCalledWith(
        "goal-1",
        "question-1",
        "a dedicated workspaces tab",
        expect.anything(),
      ),
    );
  });

  it("submits an orchestrator ask_user answer as a user message, not the worker endpoint", async () => {
    setupRunLoad();
    const askMessage: OrchestratorChatMessage = {
      id: "msg-ask",
      goalId: "goal-1",
      role: "orchestrator",
      kind: "message",
      body: "Step 1 agent needs a decision before it can continue.",
      correlationId: "corr-ask",
      createdAt: now,
      pendingQuestion: {
        questionId: "oq-1",
        toolUseId: "ot-1",
        questions: [
          {
            header: "State",
            question: "Which did you mean by 'state'?",
            multiSelect: false,
            options: [
              { label: "Active / Archived", description: "Group by goal status." },
              { label: "Running / Idle", description: "Group by active workflow run." },
            ],
          },
        ],
      },
    };
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [askMessage] });
    createOrchestratorMessageMock.mockResolvedValue({ message: askMessage, reply: null });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which did you mean by 'state'?");
    // The question leads; the third-person framing body is suppressed.
    expect(
      screen.queryByText("Step 1 agent needs a decision before it can continue."),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Active / Archived" }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() =>
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "State: Active / Archived",
      }),
    );
    expect(submitWorkerAnswersMock).not.toHaveBeenCalled();
  });

  it("renders a new chat message question fresh when the question id changes", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock
      .mockResolvedValueOnce({
        messages: [{
          id: "wq-1", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need input.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "q1", toolUseId: "t1", source: "worker",
            questions: [{ header: "Approach", question: "Question q1?", multiSelect: false,
              options: [{ label: "First option", description: "Option description" }] }],
          },
        }],
      })
      .mockResolvedValueOnce({
        messages: [{
          id: "wq-2", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "Another question.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "q2", toolUseId: "t2", source: "worker",
            questions: [{ header: "Approach", question: "Question q2?", multiSelect: false,
              options: [{ label: "Second option", description: "Option description" }] }],
          },
        }],
      });
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
        capturedOnEvent = onEvent;
        return { close: vi.fn() };
      },
    );
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    fireEvent.click(await screen.findByRole("radio", { name: /First option/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("button", { name: "Sent" })).toBeDisabled();

    act(() => {
      capturedOnEvent!({ type: "orchestrator.message.created", goalId: "goal-1" });
    });

    const secondOption = await screen.findByRole("radio", { name: /Second option/ });
    expect(secondOption).not.toBeChecked();
    expect(secondOption).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  });

  it("shows a thinking indicator while a blocking (one_shot) send is in flight, before the reply lands", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });

    // one_shot: createOrchestratorMessage blocks until the LLM completes, then
    // resolves with a non-null reply. Control the promise to inspect the wait.
    let resolveSend: ((value: unknown) => void) | null = null;
    createOrchestratorMessageMock.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve as (value: unknown) => void; }),
    );

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByPlaceholderText("Message Orca…");

    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Plan the rollout." },
    });
    fireEvent.click(screen.getByText("Send"));

    // While the request is in flight, Orca must show it is working.
    expect(await screen.findByTestId("awaiting-reply")).toBeInTheDocument();

    // Resolve with a synchronous reply (one_shot path returns reply != null).
    expect(resolveSend).not.toBeNull();
    resolveSend!({
      message: { ...userMessage, id: "msg-user-1s", body: "Plan the rollout." },
      reply: { ...orcaMessage, id: "msg-orca-1s", body: "Here is the bounded plan." },
    });

    // Once the reply lands, the indicator clears and the reply is shown.
    await waitFor(() => {
      expect(screen.queryByTestId("awaiting-reply")).toBeNull();
    });
    expect(screen.getByText("Here is the bounded plan.")).toBeInTheDocument();
  });

  it("shows thinking indicator after async reply (reply:null) and clears it when orchestrator reply lands", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });

    // Capture the onEvent callback when openEventStream is called.
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });

    // createOrchestratorMessage returns reply:null (shadow_session async path).
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-user-async", body: "Kick off the plan." },
      reply: null,
    });

    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // Wait for initial render to settle.
    await screen.findByPlaceholderText("Message Orca…");

    // Type and send a message.
    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Kick off the plan." },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "Kick off the plan.",
      });
    });

    // Awaiting-reply indicator should now be visible.
    expect(await screen.findByTestId("awaiting-reply")).toBeInTheDocument();

    // Simulate the orchestrator reply arriving: update messages mock to return
    // an orchestrator-role message as the last item, then fire the SSE event
    // so the component refreshes.
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        { ...userMessage, id: "msg-user-async", body: "Kick off the plan." },
        { ...orcaMessage, id: "msg-orca-async", body: "I have started the plan." },
      ],
    });

    // Trigger the refresh via the SSE onEvent callback.
    expect(capturedOnEvent).not.toBeNull();
    capturedOnEvent!({ type: "orchestrator.message.created", goalId: "goal-1" });

    // After refresh the indicator should be gone.
    await waitFor(() => {
      expect(screen.queryByTestId("awaiting-reply")).toBeNull();
    });

    // The orchestrator reply message is visible.
    expect(screen.getByText("I have started the plan.")).toBeInTheDocument();
  });

  it("clears the thinking indicator when an async send produces a confirmation checkpoint", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });

    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-user-confirm", body: "Try again." },
      reply: null,
    });

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByPlaceholderText("Message Orca…");

    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Try again." },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByTestId("awaiting-reply")).toBeInTheDocument();

    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        id: "activity-confirm",
        status: "paused_for_input",
        sourceKind: "step_confirmation_pending",
        currentText: "The agent traced the scoring paths.\nCompleteness 95% · Correctness 90% · Ready for handoff.",
      },
    ]);
    expect(capturedOnEvent).not.toBeNull();
    capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });

    expect(await screen.findByTestId("step-confirm-continue")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("awaiting-reply")).toBeNull();
    });
  });

  const pendingMsg: OrchestratorChatMessage = {
    id: "msg-q", goalId: "goal-1", role: "orchestrator", kind: "message",
    body: "The agent needs your input.", correlationId: "c1", createdAt: now,
    pendingQuestion: {
      questionId: "q1", toolUseId: "t1",
      questions: [
        { header: "Color", question: "favorite color?", multiSelect: false,
          options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Calm" }] },
        { header: "Feat", question: "which features?", multiSelect: true,
          options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
      ],
    },
  };

  it("submits multi-question answers (radio + checkbox) and disables after", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^B/i }));
    const submit = screen.getByRole("button", { name: /send answer/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    // A message-level question is an orchestrator ask_user: the answer posts
    // back as user guidance, not to the worker-question endpoint.
    await waitFor(() =>
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "Color: Red\nFeat: A, B",
      }),
    );
    expect(submitWorkerAnswersMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled());
  });

  it("keeps Submit disabled until every question is answered", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i })); // Q2 still unanswered
    expect(screen.getByRole("button", { name: /send answer/i })).toBeDisabled();
  });

  it("shows an expired notice and re-enables Submit when the answer is rejected", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    createOrchestratorMessageMock.mockRejectedValueOnce(new Error("question_not_found"));
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A/i }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await screen.findByText("This question expired.");
    // Controls came back: Submit is enabled again (selections still satisfy the gate).
    expect(screen.getByRole("button", { name: /send answer/i })).toBeEnabled();
  });

  it("renders the permission toggle reflecting the goal's mode when a goal is selected", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[{ ...goal, workerPermissionMode: "ask" }]} selectedGoalId="goal-1" connectionStatus="open" />);
    expect(await screen.findByRole("button", { name: /Ask-in-chat/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders an Allow/Deny approval card for a message with pendingApproval", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [{
        id: "m-approve", goalId: "goal-1", role: "orchestrator", kind: "message",
        body: "The agent wants to run Bash.", correlationId: "c1", createdAt: now,
        pendingApproval: { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf build" },
      }],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    expect(await screen.findByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    expect(screen.getByText(/rm -rf build/)).toBeInTheDocument();
  });

  it("labels the starting indicator with the resolved step name", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("Step 5 · Build It");
    expect(indicator).toHaveTextContent("— starting");
  });

  it("falls back to an ordinal-only label when the template fetch fails", async () => {
    setupRunLoad();
    getWorkflowTemplateMock.mockRejectedValue(new Error("nope"));
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("Step 5 — starting");
    expect(indicator).not.toHaveTextContent("Build It");
    expect(indicator).not.toHaveTextContent("·");
  });

  it("shows the elapsed time since the step started, not the static hint", async () => {
    setupRunLoad(); // stepRun.startedAt === now ("2026-01-01T00:00:00.000Z")
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now) + 45_000);
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("starting 0:45");
    expect(indicator).not.toHaveTextContent("~30");
  });

  it("clicking Continue on a checkpoint calls confirmStep with the run id", async () => {
    const ts = new Date().toISOString();
    listActivitiesMock.mockResolvedValue([
      {
        id: "a-confirm",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        agentSessionId: "sess-1",
        turnOrdinal: 1,
        status: "paused_for_input",
        currentText: "Completeness 90% · Ready for handoff — Continue or send revisions.",
        finalSummary: null,
        sourceKind: "step_confirmation_pending",
        workCategory: null,
        confidence: null,
        createdAt: ts,
        updatedAt: ts,
        completedAt: null,
      },
    ]);
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const btn = await screen.findByTestId("step-confirm-continue");
    fireEvent.click(btn);
    await waitFor(() => expect(confirmStepMock).toHaveBeenCalledWith("run-1"));
  });

  it("does not flash a loading indicator or blank content on SSE-driven refresh once loaded", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [userMessage, orcaMessage] });

    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
        capturedOnEvent = onEvent;
        return { close: vi.fn() };
      },
    );

    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat
        goals={[{ ...goal, activeWorkflowRunId: "run-1" }]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    // Initial load settles: content visible, no loading indicator left over.
    await screen.findByText("Start with a bounded verification pass.");
    expect(screen.queryAllByText("routing")).toHaveLength(0);

    // Make the refetch triggered by the SSE event hang, so any loading state
    // that gets set would remain observable instead of resolving instantly.
    getGoalDetailMock.mockImplementation(() => new Promise(() => {}));
    listOrchestratorMessagesMock.mockImplementation(() => new Promise(() => {}));

    // Fire an SSE refresh event (the storm source during a live turn).
    expect(capturedOnEvent).not.toBeNull();
    capturedOnEvent!({ type: "workflow.step_completed", goalId: "goal-1" });

    // Wait past the 75ms debounce so the refresh has been kicked off.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Background refresh must NOT blank content nor show a "routing" loader.
    expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
    expect(screen.getByText("Start with a bounded verification pass.")).toBeInTheDocument();
    expect(screen.queryAllByText("routing")).toHaveLength(0);
  });

  it("clears the thinking indicator when an async send produces a provider recovery checkpoint", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal,
      refinement: null,
      workspaces: [],
    });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });

    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-user-recovery", body: "Continue." },
      reply: null,
    });

    // First load: no activities (so awaitingReply won't be cleared before the send)
    listActivitiesMock.mockResolvedValueOnce([]);

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByPlaceholderText("Message Orca…");
    // Wait for the initial load to complete before sending.
    await waitFor(() => expect(listActivitiesMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Continue." },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByTestId("awaiting-reply")).toBeInTheDocument();

    const recoveryActivity: Activity = {
      ...activeActivity,
      id: "activity-recovery",
      status: "paused_for_input",
      sourceKind: "provider_recovery_pending",
      currentText: "Claude Code reached its session limit. Available again at 4:20am.",
      providerRecovery: {
        id: "recovery-1",
        mode: "choose",
        failureCode: "session_limit",
        message: "Claude Code session limit reached",
        currentSessionId: "session-1",
        currentAdapterId: "claude-code",
        currentProviderName: "Claude Code",
        resetTimeText: "4:20am (America/New_York)",
        resetAt: null,
        timezone: "America/New_York",
        detectedAt: "2026-06-12T05:00:00.000Z",
        retryOutputSeq: null,
        retryKind: "preserved_session",
        replacementSessionId: null,
        replacementOutputSeq: null,
        pendingGuidance: [],
        lastError: null,
        choices: [],
      },
    };
    listActivitiesMock.mockResolvedValue([recoveryActivity]);
    expect(capturedOnEvent).not.toBeNull();
    capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });

    // The recovery card renders (Wait for Claude Code button)
    expect(await screen.findByRole("button", { name: /Wait for Claude Code/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("awaiting-reply")).toBeNull();
    });
    // The normal composer is still visible
    expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
  });

  it("does not show a thinking bubble when a recovery activity is already present", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        id: "activity-recovery-2",
        status: "paused_for_input",
        sourceKind: "provider_recovery_pending",
        currentText: "Claude Code reached its session limit.",
        providerRecovery: {
          id: "recovery-2",
          mode: "choose",
          failureCode: "session_limit",
          message: "Claude Code session limit reached",
          currentSessionId: "session-2",
          currentAdapterId: "claude-code",
          currentProviderName: "Claude Code",
          resetTimeText: null,
          resetAt: null,
          timezone: null,
          detectedAt: "2026-06-12T05:00:00.000Z",
          retryOutputSeq: null,
          retryKind: "preserved_session",
          replacementSessionId: null,
          replacementOutputSeq: null,
          pendingGuidance: [],
          lastError: null,
          choices: [],
        },
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByTestId("activity-bubble");
    expect(screen.queryByTestId("awaiting-reply")).toBeNull();
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });

  it("refreshes after provider recovery card action via onChanged", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    const providerRecovery = {
      id: "recovery-3",
      mode: "choose" as const,
      failureCode: "session_limit" as const,
      message: "Claude Code session limit reached",
      currentSessionId: "session-3",
      currentAdapterId: "claude-code",
      currentProviderName: "Claude Code",
      resetTimeText: "4:20am (America/New_York)",
      resetAt: null,
      timezone: "America/New_York",
      detectedAt: "2026-06-12T05:00:00.000Z",
      retryOutputSeq: null,
      retryKind: "preserved_session" as const,
      replacementSessionId: null,
      replacementOutputSeq: null,
      pendingGuidance: [],
      lastError: null,
      choices: [],
    };
    listActivitiesMock
      .mockResolvedValueOnce([
        {
          ...activeActivity,
          id: "activity-recovery-3",
          status: "paused_for_input",
          sourceKind: "provider_recovery_pending",
          currentText: "Claude Code reached its session limit.",
          providerRecovery,
        },
      ])
      .mockResolvedValue([]);

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByRole("button", { name: /Wait for Claude Code/ });

    fireEvent.click(screen.getByRole("button", { name: /Wait for Claude Code/ }));
    await waitFor(() => {
      expect(waitForProviderRecoveryMock).toHaveBeenCalledWith("run-1", { checkpointId: "recovery-3" });
    });
    // After onChanged fires, listActivities is called again (at least twice total).
    await waitFor(() => expect(listActivitiesMock).toHaveBeenCalledTimes(2));
  });

  // Regression: when a workflow reaches its final step, that step (e.g. "Verify"
  // in Bug Triage & Fix) must not keep showing "running" in the tracker, and the
  // chat should surface that the workflow finished. This mirrors the daemon: a
  // finished terminal step does NOT auto-complete the run — it parks the run
  // "active" with the final step "passed" awaiting completion approval (a truly
  // completed/cancelled run detaches from the goal, so this parked state is the
  // one the Orchestrator tab can actually render).
  it("does not keep the last step 'running' once the final step has passed", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/bug-triage",
        templateVersion: 1,
        status: "active",
        currentStepRunId: "step-verify",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
      },
    });
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-verify",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepTemplateId: "verify",
        ordinal: 3,
        attempt: 1,
        status: "passed",
        startedAt: now,
        finishedAt: now,
        blockedReason: null,
      },
    });
    getWorkflowTemplateMock.mockResolvedValue({
      template: {
        name: "Bug Triage & Fix",
        steps: [
          { id: "triage", ordinal: 0, name: "Triage" },
          { id: "reproduce", ordinal: 1, name: "Reproduce" },
          { id: "fix", ordinal: 2, name: "Fix" },
          { id: "verify", ordinal: 3, name: "Verify" },
        ],
      },
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // Tracker renders once the template/run load.
    await screen.findByText("Bug Triage & Fix");
    // Defect: the final "Verify" step is still flagged as actively running even
    // though the run is completed and the step passed.
    expect(screen.queryByText("running")).toBeNull();
    // And the chat must surface that the workflow finished, instead of going
    // silent after the last step.
    await screen.findByText("Workflow complete");
  });

  it("composer text goes to the orchestrator; worker questions are answered via their chat form", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "wq-1", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need your call on the approach.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "question-1", toolUseId: "tool-1", source: "worker",
            questions: [
              {
                header: "Approach",
                question: "Which approach should I use?",
                multiSelect: false,
                options: [{ label: "Use hooks", description: "x" }],
              },
            ],
          },
        },
      ],
    });
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-u2", body: "a dedicated workspaces tab" },
      reply: null,
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which approach should I use?");
    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "a dedicated workspaces tab" },
    });
    // "Send" in the composer goes to the orchestrator now (not the worker).
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "a dedicated workspaces tab",
      }),
    );
    expect(submitWorkerFreeTextMock).not.toHaveBeenCalled();
  });
});

describe("formatElapsed", () => {
  it("formats durations as M:SS and floors negatives to 0:00", async () => {
    const { formatElapsed } = await import("./OrcaChat");
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(600_000)).toBe("10:00");
    expect(formatElapsed(-1_000)).toBe("0:00");
  });
});

const workerMsg = {
  id: "m1", goalId: "g1", role: "orchestrator", kind: "message", body: "Which?",
  correlationId: null, createdAt: "2026-06-18T00:00:00.000Z",
  pendingQuestion: {
    questionId: "q1", toolUseId: "t1", source: "worker",
    questions: [{ header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }] }],
  },
} as const;

describe("ChatMessageRow worker questions", () => {
  beforeEach(() => submitWorkerAnswersMock.mockClear());

  it("submits a pending worker question to the worker endpoint", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    render(<ChatMessageRow message={workerMsg as never} goalId="g1" />);
    fireEvent.click(screen.getByLabelText("A"));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
    await waitFor(() =>
      expect(submitWorkerAnswersMock).toHaveBeenCalledWith("g1", "q1", [{ questionIndex: 0, selectedLabels: ["A"] }]),
    );
  });

  it("renders the read-only view once answered", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] } } };
    render(<ChatMessageRow message={answered as never} goalId="g1" />);
    expect(screen.getByTestId("worker-question-answered")).toBeInTheDocument();
  });
});
