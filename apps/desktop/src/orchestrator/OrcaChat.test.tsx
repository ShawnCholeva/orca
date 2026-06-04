import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, OrchestratorChatMessage } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const createOrchestratorMessageMock = vi.fn();
const getGoalDetailMock = vi.fn();
const getWorkflowRunMock = vi.fn();
const getWorkflowStepRunMock = vi.fn();
const listOrchestratorMessagesMock = vi.fn();
const listWorkflowDecisionsMock = vi.fn();
const listWorkflowRunArtifactsMock = vi.fn();
const openEventStreamMock = vi.fn();
const requestNextOrchestratorDecisionMock = vi.fn();
const listWorkflowTemplatesMock = vi.fn();
const startWorkflowRunMock = vi.fn();
const submitWorkerAnswersMock = vi.fn();
const submitPermissionDecisionMock = vi.fn();
const setWorkerPermissionModeMock = vi.fn();

vi.mock("../api", () => ({
  createOrchestratorMessage: (...args: unknown[]) => createOrchestratorMessageMock(...args),
  getGoalDetail: (...args: unknown[]) => getGoalDetailMock(...args),
  getWorkflowRun: (...args: unknown[]) => getWorkflowRunMock(...args),
  getWorkflowStepRun: (...args: unknown[]) => getWorkflowStepRunMock(...args),
  listOrchestratorMessages: (...args: unknown[]) => listOrchestratorMessagesMock(...args),
  listWorkflowDecisions: (...args: unknown[]) => listWorkflowDecisionsMock(...args),
  listWorkflowRunArtifacts: (...args: unknown[]) => listWorkflowRunArtifactsMock(...args),
  openEventStream: (...args: unknown[]) => openEventStreamMock(...args),
  requestNextOrchestratorDecision: (...args: unknown[]) => requestNextOrchestratorDecisionMock(...args),
  listWorkflowTemplates: (...args: unknown[]) => listWorkflowTemplatesMock(...args),
  startWorkflowRun: (...args: unknown[]) => startWorkflowRunMock(...args),
  submitWorkerAnswers: (...args: unknown[]) => submitWorkerAnswersMock(...args),
  submitPermissionDecision: (...args: unknown[]) => submitPermissionDecisionMock(...args),
  setWorkerPermissionMode: (...args: unknown[]) => setWorkerPermissionModeMock(...args),
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
    createOrchestratorMessageMock.mockReset();
    getGoalDetailMock.mockReset();
    getWorkflowRunMock.mockReset();
    getWorkflowStepRunMock.mockReset();
    listOrchestratorMessagesMock.mockReset();
    listWorkflowDecisionsMock.mockReset();
    listWorkflowRunArtifactsMock.mockReset();
    requestNextOrchestratorDecisionMock.mockReset();
    listWorkflowTemplatesMock.mockReset();
    listWorkflowTemplatesMock.mockResolvedValue({ templates: [] });
    startWorkflowRunMock.mockReset();
    submitWorkerAnswersMock.mockReset();
    submitWorkerAnswersMock.mockResolvedValue(undefined);
    submitPermissionDecisionMock.mockReset();
    submitPermissionDecisionMock.mockResolvedValue(undefined);
    setWorkerPermissionModeMock.mockReset();
    setWorkerPermissionModeMock.mockResolvedValue(undefined);
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

  it("shows the selected goal SystemCard and composer when a goal is selected", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");

    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    expect(await screen.findByText("Ship Engineering workflow chat")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
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

  it("renders an internal-thought row from the message list", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "msg-thought",
          goalId: "goal-1",
          role: "internal_thought",
          kind: "message",
          body: "Starting Intake",
          correlationId: null,
          internalKind: "step_started",
          createdAt: now,
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByText(/Starting Intake/)).toBeInTheDocument();
  });

  it("renders an agent-paraphrased message with the raw transcript hidden by default", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "msg-paraphrased",
          goalId: "goal-1",
          role: "agent_paraphrased",
          kind: "message",
          body: "I asked the user to confirm the rollout scope.",
          rawAgentText: "RAW transcript that should stay hidden",
          correlationId: null,
          createdAt: now,
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(
      await screen.findByText("I asked the user to confirm the rollout scope."),
    ).toBeInTheDocument();
    expect(screen.queryByText("RAW transcript that should stay hidden")).toBeNull();

    // Toggling the disclosure reveals the raw transcript.
    fireEvent.click(screen.getByText(/Show raw agent transcript/));
    expect(
      await screen.findByText("RAW transcript that should stay hidden"),
    ).toBeInTheDocument();
  });

  it("renders the MarkDoneConfirmCard when the last message signals mark_done_ready", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "msg-done",
          goalId: "goal-1",
          role: "internal_thought",
          kind: "message",
          body: "All steps complete.",
          correlationId: null,
          internalKind: "mark_done_ready",
          createdAt: now,
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByText(/Confirm done/)).toBeInTheDocument();
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
    const submit = screen.getByRole("button", { name: /submit/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(submitWorkerAnswersMock).toHaveBeenCalledWith("goal-1", "q1", [
      { questionIndex: 0, selectedLabels: ["Red"] },
      { questionIndex: 1, selectedLabels: ["A", "B"] },
    ]));
    await waitFor(() => expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled());
  });

  it("keeps Submit disabled until every question is answered", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i })); // Q2 still unanswered
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("shows an expired notice and re-enables Submit when the answer is rejected", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    submitWorkerAnswersMock.mockRejectedValueOnce(new Error("question_not_found"));
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A/i }));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    await screen.findByText("This question expired.");
    // Controls came back: Submit is enabled again (selections still satisfy the gate).
    expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
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
    expect(screen.getByText("Ship Engineering workflow chat")).toBeInTheDocument();
    expect(screen.getByText("Start with a bounded verification pass.")).toBeInTheDocument();
    expect(screen.queryAllByText("routing")).toHaveLength(0);
  });
});
