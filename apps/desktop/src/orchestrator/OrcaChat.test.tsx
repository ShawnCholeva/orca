import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Goal, OrchestratorChatMessage } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

// OrcaMark reads the theme; tests don't mount a ThemeProvider, so stub it.
vi.mock("../theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: { mode: "dark" } }),
}));

const confirmSplitMock = vi.fn();
const confirmStepMock = vi.fn();
const createOrchestratorMessageMock = vi.fn();
const runGoalCommandMock = vi.fn();
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
const submitOrchestratorAnswerMock = vi.fn();
const submitPermissionDecisionMock = vi.fn();
const setWorkerPermissionModeMock = vi.fn();
const waitForProviderRecoveryMock = vi.fn();
const retryProviderRecoveryMock = vi.fn();
const refreshProviderRecoveryMock = vi.fn();
const switchProviderRecoveryMock = vi.fn();
const requestStepRevisionMock = vi.fn();
const submitStepRevisionMock = vi.fn();
const listRecommendationsMock = vi.fn();
const acceptRecommendationMock = vi.fn();
const listWorkflowRunsMock = vi.fn();
const listWorkflowStepRunsMock = vi.fn();
const resumeWorkflowRunMock = vi.fn();

vi.mock("../api", () => ({
  confirmSplit: (...args: unknown[]) => confirmSplitMock(...args),
  confirmStep: (...args: unknown[]) => confirmStepMock(...args),
  createOrchestratorMessage: (...args: unknown[]) => createOrchestratorMessageMock(...args),
  runGoalCommand: (...args: unknown[]) => runGoalCommandMock(...args),
  getGoalDetail: (...args: unknown[]) => getGoalDetailMock(...args),
  getWorkflowRun: (...args: unknown[]) => getWorkflowRunMock(...args),
  listWorkflowRuns: (...args: unknown[]) => listWorkflowRunsMock(...args),
  listWorkflowStepRuns: (...args: unknown[]) => listWorkflowStepRunsMock(...args),
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
  submitOrchestratorAnswer: (...args: unknown[]) => submitOrchestratorAnswerMock(...args),
  submitPermissionDecision: (...args: unknown[]) => submitPermissionDecisionMock(...args),
  setWorkerPermissionMode: (...args: unknown[]) => setWorkerPermissionModeMock(...args),
  waitForProviderRecovery: (...args: unknown[]) => waitForProviderRecoveryMock(...args),
  retryProviderRecovery: (...args: unknown[]) => retryProviderRecoveryMock(...args),
  refreshProviderRecovery: (...args: unknown[]) => refreshProviderRecoveryMock(...args),
  switchProviderRecovery: (...args: unknown[]) => switchProviderRecoveryMock(...args),
  requestStepRevision: (...args: unknown[]) => requestStepRevisionMock(...args),
  submitStepRevision: (...args: unknown[]) => submitStepRevisionMock(...args),
  listRecommendations: (...args: unknown[]) => listRecommendationsMock(...args),
  acceptRecommendation: (...args: unknown[]) => acceptRecommendationMock(...args),
  resumeWorkflowRun: (...args: unknown[]) => resumeWorkflowRunMock(...args),
  toErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

const now = "2026-01-01T00:00:00.000Z";

const goal: Goal = {
  id: "goal-1",
  title: "Ship Engineering workflow chat",
  intent: "Goal description",
  successCriteria: [],
  status: "active",
  autonomyLevel: 1,
  workerPermissionMode: "ask",
  operatingMode: "human_review",
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
    confirmSplitMock.mockReset();
    confirmSplitMock.mockResolvedValue(undefined);
    confirmStepMock.mockReset();
    confirmStepMock.mockResolvedValue(undefined);
    createOrchestratorMessageMock.mockReset();
    runGoalCommandMock.mockReset();
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
    submitOrchestratorAnswerMock.mockReset();
    submitOrchestratorAnswerMock.mockResolvedValue(undefined);
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
    requestStepRevisionMock.mockReset();
    requestStepRevisionMock.mockResolvedValue(undefined);
    submitStepRevisionMock.mockReset();
    submitStepRevisionMock.mockResolvedValue(undefined);
    listRecommendationsMock.mockReset();
    listRecommendationsMock.mockResolvedValue({ recommendations: [], generations: [] });
    acceptRecommendationMock.mockReset();
    acceptRecommendationMock.mockResolvedValue({});
    listWorkflowRunsMock.mockReset();
    listWorkflowRunsMock.mockResolvedValue({ runs: [] });
    listWorkflowStepRunsMock.mockReset();
    listWorkflowStepRunsMock.mockResolvedValue({ stepRuns: [] });
    resumeWorkflowRunMock.mockReset();
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

  it("shows the starting indicator while the run's first step (ordinal 0) is starting", async () => {
    setupRunLoad();
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 0, attempt: 1, status: "active", startedAt: now, finishedAt: null, blockedReason: null,
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

    const indicator = await screen.findByTestId("step-starting");
    expect(indicator).toHaveTextContent("Starting workflow");
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

  it("shows an honest 'reviewing' status (not starting/working) during the judge window", async () => {
    setupRunLoad();
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 4, attempt: 1, status: "active", startedAt: now, finishedAt: null,
        blockedReason: null, orchestratorPhase: "reviewing",
      },
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const row = await screen.findByTestId("orchestrator-review");
    expect(row).toHaveTextContent("Reviewing the step output…");
    expect(screen.queryByTestId("step-starting")).toBeNull();
    expect(screen.queryByTestId("step-working")).toBeNull();
  });

  it("shows 'Running an independent check…' during the refute phase", async () => {
    setupRunLoad();
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 4, attempt: 1, status: "active", startedAt: now, finishedAt: null,
        blockedReason: null, orchestratorPhase: "independent_check",
      },
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("orchestrator-review")).toHaveTextContent(
      "Running an independent check…",
    );
  });

  it("does not show 'Working on {step}' when the step's evaluation timed out and is awaiting a retry", async () => {
    setupRunLoad();
    // Worker finished, judge failed (shadow timeout) → output stashed, step still
    // active but stalled on the human; the status must not claim it is working.
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 4, attempt: 1, status: "active", startedAt: now, finishedAt: null,
        blockedReason: null, judgePending: true,
      },
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByPlaceholderText("Message Orca…")).toBeInTheDocument();
    expect(screen.queryByTestId("step-working")).toBeNull();
  });

  it("does not also pulse a worker activity while the orchestrator review runs (one live indicator)", async () => {
    setupRunLoad();
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 4, attempt: 1, status: "active", startedAt: now, finishedAt: null,
        blockedReason: null, orchestratorPhase: "independent_check",
      },
    });
    // The worker's last turn is still marked active (its completion can lag the
    // phase update); it must not keep pulsing once the orchestrator has taken over.
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity, id: "act-read", status: "active", currentText: "Read calc.js",
        steps: [{ id: "s1", text: "Read calc.js", category: "reading", status: "active", createdAt: now }],
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // The orchestrator review is the single honest live indicator…
    expect(await screen.findByTestId("orchestrator-review")).toHaveTextContent("Running an independent check…");
    // …and the worker step is not still pulsing next to it.
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  it("hides the orchestrator review indicator once the step has parked for confirmation", async () => {
    setupRunLoad();
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 4, attempt: 1, status: "active", startedAt: now, finishedAt: null,
        blockedReason: null, orchestratorPhase: "independent_check",
      },
    });
    // The step parked for confirmation (Continue/Revise card up) — the review is
    // over and awaiting the human, so the "independent check" bubble must be gone.
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity, id: "act-confirm", status: "paused_for_input",
        sourceKind: "step_confirmation_pending", currentText: "Step complete — review and Continue.",
        confirmationSummary: null,
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByPlaceholderText("Message Orca…");
    expect(screen.queryByTestId("orchestrator-review")).toBeNull();
  });

  it("hides the orchestrator-review status when there is no phase (parked/idle)", async () => {
    setupRunLoad();
    // A genuine first step (ordinal 0) so the starting row is expected.
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 0, attempt: 1, status: "active", startedAt: now, finishedAt: null, blockedReason: null,
      },
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("step-starting")).toBeInTheDocument();
    expect(screen.queryByTestId("orchestrator-review")).toBeNull();
  });

  it("does not show 'Starting workflow' for a later step; shows 'Working on {step}' instead", async () => {
    setupRunLoad(); // default stepRun is ordinal 4 — a mid-run step, not the first
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("step-working")).toHaveTextContent("Working on Build It…");
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });

  it("fills the between-turn gap: 'Working on {step}' shows while a step is active with only a completed (non-live) card", async () => {
    setupRunLoad(); // active step, no live activity, no phase
    listActivitiesMock.mockResolvedValue([
      { ...activeActivity, id: "act-done", status: "completed", sourceKind: "turn_completed", finalSummary: "Ran a check." },
    ]);
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // The worker emitted a completed card and is thinking for its next turn: the
    // status must not go dead — "Working on {step}" fills the gap.
    expect(await screen.findByTestId("step-working")).toBeInTheDocument();
  });

  it("suppresses 'Working on {step}' while the step is parked on an unanswered worker question", async () => {
    setupRunLoad(); // active mid-run step "Build It", no live activity
    // The worker asked a question and ended its turn — the step is parked
    // waiting on the human, so the status must NOT claim it is working.
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "wq-park", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need your input before continuing.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "question-park", toolUseId: "tool-park", source: "worker",
            questions: [
              {
                header: "Interface",
                question: "What interface should the user drive the app through?",
                multiSelect: false,
                options: [
                  { label: "Local web app", description: "A small local server + browser UI." },
                  { label: "CLI", description: "Command-line commands." },
                ],
              },
            ],
          },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // The question card is answerable...
    await screen.findByText("What interface should the user drive the app through?");
    // ...and no dishonest "Working on {step}" indicator sits under it.
    expect(screen.queryByTestId("step-working")).toBeNull();
  });

  it("suppresses 'Working on {step}' while parked on an ORCHESTRATOR-source question too", async () => {
    setupRunLoad(); // active mid-run step "Build It", no live activity
    // A step's AskUserQuestion can surface with source "orchestrator" (observed
    // live). The step is just as parked-on-the-human as a worker-source question,
    // so the "Working on {step}…" status must be suppressed for it as well.
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "oq-park", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "I need your input before continuing.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "question-orch", toolUseId: "tool-orch", source: "orchestrator",
            questions: [
              {
                header: "Signal style",
                question: "How should divide(a, b) signal a divide-by-zero?",
                multiSelect: false,
                options: [
                  { label: "Throw", description: "Throw a RangeError." },
                  { label: "Result object", description: "Return a tagged result." },
                ],
              },
            ],
          },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("How should divide(a, b) signal a divide-by-zero?");
    expect(screen.queryByTestId("step-working")).toBeNull();
  });

  it("surfaces a blocked run with its reason and suppresses the working spinner", async () => {
    setupRunLoad();
    // The run halted at the splitter and was blocked with a reason.
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "blocked",
        currentStepRunId: "step-1",
        startedAt: now,
        finishedAt: null,
        blockedReason: "splitter route evaluation failed: orchestrator returned no routing decision",
      },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const blocked = await screen.findByTestId("run-blocked");
    expect(blocked.textContent).toContain("splitter route evaluation failed");
    // Honest status: no "starting"/"awaiting" spinner over a halted run.
    expect(screen.queryByTestId("step-starting")).toBeNull();
    expect(screen.queryByTestId("awaiting-reply")).toBeNull();
  });

  function setupBlockedRun() {
    setupRunLoad();
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "blocked",
        currentStepRunId: "step-1",
        startedAt: now,
        finishedAt: null,
        blockedReason: "hasn't made progress after 3 restarts. I've stopped the run here — pick it back up when you're ready.",
      },
    });
  }

  it("shows a Resume run control only when the run is blocked", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");
    const firstRender = render(
      <OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />,
    );
    await screen.findByPlaceholderText("Message Orca…");
    expect(screen.queryByRole("button", { name: /resume run/i })).toBeNull();
    firstRender.unmount();

    setupBlockedRun();
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByRole("button", { name: /resume run/i })).toBeTruthy();
  });

  it("resuming a blocked run calls the resume client with the goal and run ids", async () => {
    setupBlockedRun();
    resumeWorkflowRunMock.mockResolvedValue({
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
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const resumeButton = await screen.findByRole("button", { name: /resume run/i });
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(resumeWorkflowRunMock).toHaveBeenCalledWith("goal-1", "run-1");
    });
  });

  it("disables the Resume run button while the request is in flight", async () => {
    setupBlockedRun();
    let releaseResume!: () => void;
    resumeWorkflowRunMock.mockReturnValue(
      new Promise((resolve) => {
        releaseResume = () => resolve({
          run: {
            id: "run-1", goalId: "goal-1", templateId: "orca/engineering", templateVersion: 1,
            status: "active", currentStepRunId: "step-2", startedAt: now, finishedAt: null, blockedReason: null,
          },
        });
      }),
    );
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const resumeButton = await screen.findByRole("button", { name: /resume run/i });
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resume run/i })).toBeDisabled();
    });

    await act(async () => {
      releaseResume();
      await Promise.resolve();
    });
  });

  it("shows plain-language copy (not the raw server error) when resume fails", async () => {
    setupBlockedRun();
    resumeWorkflowRunMock.mockRejectedValue(
      new Error("SQLITE_CONSTRAINT: FOREIGN KEY constraint failed at workflow_runs.current_step_run_id"),
    );
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const resumeButton = await screen.findByRole("button", { name: /resume run/i });
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(resumeWorkflowRunMock).toHaveBeenCalled();
    });
    const errorEl = await screen.findByTestId("resume-run-error");
    expect(errorEl.textContent).not.toContain("SQLITE_CONSTRAINT");
    expect(errorEl.textContent).not.toContain("FOREIGN KEY");
    expect(errorEl.textContent?.length).toBeGreaterThan(0);
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

  it("shows the completed workflow tracker for a completed goal whose run has detached", async () => {
    // A completed run detaches from the goal (active_workflow_run_id nulled), so
    // goal.activeWorkflowRunId is null but goal.status is "completed". The view
    // must load the most-recent (completed) run and show the finished tracker
    // instead of the misleading "No workflow running / Start Workflow" empty state.
    const completedRun = {
      id: "run-1",
      goalId: "goal-1",
      templateId: "orca/engineering",
      templateVersion: 1,
      status: "completed",
      currentStepRunId: null,
      startedAt: now,
      finishedAt: now,
      blockedReason: null,
    };
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, status: "completed", activeWorkflowRunId: null },
      refinement: null,
      workspaces: [],
    });
    listWorkflowRunsMock.mockResolvedValue({ runs: [completedRun] });
    getWorkflowRunMock.mockResolvedValue({ run: completedRun });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[{ ...goal, status: "completed" }]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByText("Workflow complete")).toBeInTheDocument();
    expect(screen.queryByText("No workflow running")).toBeNull();
  });

  it("shows 'awaiting confirmation' (not 'running') when a step is parked for Continue/Revise", async () => {
    setupRunLoad();
    // The active step has produced its output and parked for the human to confirm.
    listActivitiesMock.mockResolvedValue([
      { ...activeActivity, id: "act-confirm", status: "paused_for_input", sourceKind: "step_confirmation_pending" },
    ]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByText(/awaiting confirmation/i)).toBeInTheDocument();
    // Honest status: no live "running" spinner over a step that has stopped.
    expect(screen.queryByText("running")).toBeNull();
  });

  it("renders routed-past design steps as 'skipped' (approach_only) rather than completed", async () => {
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1", goalId: "goal-1", templateId: "orca/adaptive-delivery", templateVersion: 1,
        status: "active", currentStepRunId: "sr-proposal", startedAt: now, finishedAt: null, blockedReason: null,
      },
    });
    getWorkflowTemplateMock.mockResolvedValue({
      template: {
        steps: [
          { id: "triage", ordinal: 0, name: "Triage" },
          { id: "clarify", ordinal: 1, name: "Clarify" },
          { id: "research", ordinal: 2, name: "Research" },
          { id: "proposal", ordinal: 3, name: "Proposal" },
        ],
      },
    });
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: { id: "sr-proposal", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "proposal", ordinal: 3, attempt: 1, status: "active", startedAt: now, finishedAt: null, blockedReason: null },
    });
    // Only Triage and Proposal actually ran — Clarify/Research were routed past.
    listWorkflowStepRunsMock.mockResolvedValue({
      stepRuns: [
        { id: "sr-triage", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "triage", ordinal: 0, attempt: 1, status: "passed", startedAt: now, finishedAt: now, blockedReason: null },
        { id: "sr-proposal", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "proposal", ordinal: 3, attempt: 1, status: "active", startedAt: now, finishedAt: null, blockedReason: null },
      ],
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // Clarify + Research show a 'skipped' marker (two of them); they did not run.
    await waitFor(() => expect(screen.getAllByText(/skipped/i).length).toBeGreaterThanOrEqual(2));
    // Triage actually ran → it is one of the completed checks (not skipped).
    expect(screen.getAllByTestId("tracker-done-check").length).toBeGreaterThanOrEqual(1);
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

  it("sends /stuck as a command instead of a chat message", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    runGoalCommandMock.mockResolvedValue({ ok: true, message: "Thanks — restarting the agent on this step." });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "/stuck going in circles" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(runGoalCommandMock).toHaveBeenCalledWith("goal-1", {
      command: "stuck",
      args: "going in circles",
    }));
    expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
  });

  it("sends /stuck as a command even while a revision card is open, not as revision feedback", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "msg-rev", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "Here is the step result.", correlationId: "c1", createdAt: now,
          pendingRevision: { workflowRunId: "r1" },
        },
      ],
    });
    runGoalCommandMock.mockResolvedValue({ ok: true, message: "Thanks — restarting the agent on this step." });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const input = await screen.findByPlaceholderText("Message Orca…");
    fireEvent.change(input, { target: { value: "/stuck going in circles" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(runGoalCommandMock).toHaveBeenCalledWith("goal-1", {
      command: "stuck",
      args: "going in circles",
    }));
    expect(submitStepRevisionMock).not.toHaveBeenCalled();
  });

  it("sends an unknown slash command as an ordinary message", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    createOrchestratorMessageMock.mockResolvedValue({
      message: { ...userMessage, id: "msg-user-3", body: "/nope" },
      reply: null,
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(createOrchestratorMessageMock).toHaveBeenCalled());
    expect(runGoalCommandMock).not.toHaveBeenCalled();
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
    getWorkflowStepRunMock.mockResolvedValue({
      stepRun: {
        id: "step-1", goalId: "goal-1", workflowRunId: "run-1", stepTemplateId: "execution",
        ordinal: 0, attempt: 1, status: "active", startedAt: now, finishedAt: null, blockedReason: null,
      },
    });
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
    const select = await screen.findByRole("combobox", { name: /Choose workflow/ });
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

  it("shows a per-step working indicator for a running step that has not emitted activity yet", async () => {
    setupRunLoad();
    // Orca has already spoken (so the first-step "Starting workflow" hint is
    // suppressed) and the current step run is active with no activity yet — the
    // opening generation gap of a routed step. The UI must still show work.
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [orcaMessage] });
    listActivitiesMock.mockResolvedValue([]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const working = await screen.findByTestId("step-working");
    expect(working.textContent).toContain("Working on Build It");
    expect(screen.queryByTestId("step-starting")).toBeNull();
  });

  it("retires the per-step working row while a live activity thread is streaming", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [orcaMessage] });
    // The current step run (step-1) has a LIVE (streaming) activity — its own
    // pulsing thread carries the "working" signal, so the generic row must hide.
    // (A *completed* thread would leave a gap the working row must fill — see the
    // between-turn-gap test above.)
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        status: "active",
        steps: [{ id: "s1", text: "Read App.tsx", category: "reading", status: "active", createdAt: now }],
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByTestId("agent-activity")).toBeInTheDocument();
    expect(screen.queryByTestId("step-working")).toBeNull();
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

  it("renders a withdrawn (superseded) question as retracted, not answerable", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "wq-withdrawn", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "A choice of which blue to use is needed.", correlationId: null, createdAt: now,
          pendingQuestion: {
            questionId: "q-withdrawn", toolUseId: "t-withdrawn", source: "orchestrator", withdrawn: true,
            questions: [
              {
                header: "Active blue", question: "Which blue?", multiSelect: false,
                options: [{ label: "info", description: "sky" }],
              },
            ],
          },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText(/withdrawn/i);
    // A withdrawn question is not answerable: no option control, no send button.
    expect(screen.queryByRole("radio", { name: /info/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send answer/i })).toBeNull();
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

    // Free text is ambiguous (an answer, or a question about the options), so it
    // goes to chat for the orchestrator to resolve — not straight to the worker.
    await waitFor(() =>
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "a dedicated workspaces tab",
      }),
    );
    expect(submitWorkerFreeTextMock).not.toHaveBeenCalled();
    // The question stays live until the orchestrator says the text settled it.
    expect(screen.getByRole("radio", { name: "Use hooks" })).not.toBeDisabled();
  });

  it("answers an orchestrator ask_user via the orchestrator-answer endpoint, with no user bubble and a Thinking row", async () => {
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
      expect(submitOrchestratorAnswerMock).toHaveBeenCalledWith("goal-1", "oq-1", {
        answers: [{ questionIndex: 0, selectedLabels: ["Active / Archived"] }],
      }),
    );
    // No echoed user chat message; the Thinking row shows instead.
    expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
    expect(submitWorkerAnswersMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId("answer-thinking")).toBeInTheDocument();
  });

  it("offers 'Something else' on an orchestrator ask_user question and submits free text", async () => {
    setupRunLoad();
    const askMessage: OrchestratorChatMessage = {
      id: "msg-ask2",
      goalId: "goal-1",
      role: "orchestrator",
      kind: "message",
      body: "Step 1 agent needs a decision.",
      correlationId: "corr-ask2",
      createdAt: now,
      pendingQuestion: {
        questionId: "oq-2",
        toolUseId: "ot-2",
        questions: [
          {
            header: "Surface",
            question: "Which part of Orca?",
            multiSelect: false,
            options: [{ label: "Desktop UI", description: "the app" }],
          },
        ],
      },
    };
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [askMessage] });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which part of Orca?");
    fireEvent.click(screen.getByRole("radio", { name: /something else/i }));
    fireEvent.change(screen.getByPlaceholderText(/your own answer/i), {
      target: { value: "the workflows tab" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() =>
      expect(submitOrchestratorAnswerMock).toHaveBeenCalledWith("goal-1", "oq-2", {
        freeText: "the workflows tab",
      }),
    );
    expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
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
    // A message-level question is an orchestrator ask_user: the answer persists
    // on the question and forwards to the mediator — not the worker endpoint and
    // not a separate user chat message.
    await waitFor(() =>
      expect(submitOrchestratorAnswerMock).toHaveBeenCalledWith("goal-1", "q1", {
        answers: [
          { questionIndex: 0, selectedLabels: ["Red"] },
          { questionIndex: 1, selectedLabels: ["A", "B"] },
        ],
      }),
    );
    expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
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

  it("shows a retryable error and re-enables Submit when the answer submit fails", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [pendingMsg] });
    submitOrchestratorAnswerMock.mockRejectedValueOnce(new Error("network_error"));
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("favorite color?");
    fireEvent.click(screen.getByRole("radio", { name: /Red/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A/i }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await screen.findByText("Couldn't send your answer. Please try again.");
    // Controls came back: Submit is enabled again (selections still satisfy the gate).
    expect(screen.getByRole("button", { name: /send answer/i })).toBeEnabled();
  });

  it("renders the permission dropdown reflecting the goal's mode when a goal is selected", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[{ ...goal, workerPermissionMode: "ask" }]} selectedGoalId="goal-1" connectionStatus="open" />);
    const select = await screen.findByRole("combobox", { name: /Worker tool permissions/ });
    expect((select as HTMLSelectElement).value).toBe("ask");
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

  it("clicking Continue at a splitter park calls confirmSplit, not confirmStep", async () => {
    const ts = new Date().toISOString();
    listActivitiesMock.mockResolvedValue([
      {
        id: "a-confirm-split",
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
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: null,
        currentNodeKind: "splitter",
        currentNodeId: "splitter-1",
        startedAt: ts,
        finishedAt: null,
        blockedReason: null,
      },
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });

    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat
        goals={[{ ...goal, activeWorkflowRunId: "run-1" }]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );

    const btn = await screen.findByTestId("step-confirm-continue");
    fireEvent.click(btn);
    await waitFor(() => expect(confirmSplitMock).toHaveBeenCalledWith("run-1"));
    expect(confirmStepMock).not.toHaveBeenCalled();
  });

  it("renders a human routing choice and routes to the picked branch via confirmSplit", async () => {
    const ts = new Date().toISOString();
    listActivitiesMock.mockResolvedValue([]);
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: null,
        currentNodeKind: "splitter",
        currentNodeId: "route",
        startedAt: ts,
        finishedAt: null,
        blockedReason: null,
        pendingSplitChoice: {
          splitterNodeId: "route",
          prompt: "Couldn't determine routing for \"Route\" — choose the next step.",
          options: [
            { branch: "ground_and_design", label: "Research" },
            { branch: "approach_only", label: "Proposal" },
          ],
        },
      },
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });

    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat goals={[{ ...goal, activeWorkflowRunId: "run-1" }]} selectedGoalId="goal-1" connectionStatus="open" />,
    );

    expect(await screen.findByTestId("split-choice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Proposal" }));
    await waitFor(() => expect(confirmSplitMock).toHaveBeenCalledWith("run-1", "approach_only"));
  });

  it("shows a single 'Working on <gate>…' bubble while a gate reviewer runs", async () => {
    const ts = new Date().toISOString();
    listActivitiesMock.mockResolvedValue([]);
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: null,
        currentNodeKind: "gate",
        currentNodeId: "critique",
        startedAt: ts,
        finishedAt: null,
        blockedReason: null,
        pendingGateReview: null,
      },
    });
    getWorkflowTemplateMock.mockResolvedValue({
      template: {
        steps: [{ id: "design", ordinal: 0, name: "Design" }],
        graph: {
          nodes: [
            { id: "design", type: "step", name: "Design" },
            { id: "critique", type: "gate", name: "Critique" },
          ],
          edges: [{ from: "design", to: "critique" }],
          positions: {},
        },
      },
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });

    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat goals={[{ ...goal, activeWorkflowRunId: "run-1" }]} selectedGoalId="goal-1" connectionStatus="open" />,
    );

    const bubbles = await screen.findAllByText(/Working on Critique…/);
    expect(bubbles).toHaveLength(1);
    expect(screen.queryByTestId("gate-decision")).not.toBeInTheDocument();
    // Single-bubble invariant: the step-working bubble is not also present.
    expect(screen.queryByTestId("step-working")).not.toBeInTheDocument();
    // Single-bubble invariant: the generic answer-thinking row must yield to the
    // gate-specific bubble while parked at a gate.
    expect(screen.queryByTestId("answer-thinking")).not.toBeInTheDocument();
  });

  it("yields the answer-thinking bubble to gate-working when Continue parks the run at a gate", async () => {
    const ts = new Date().toISOString();
    listActivitiesMock.mockResolvedValueOnce([
      {
        id: "a-confirm-gate",
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
    // Once Continue confirms the step, the daemon parks the run at the gate
    // and the step's pending confirmation activity is gone — this is what
    // lets hasLiveActivity clear so showGateWorking can take the tail.
    listActivitiesMock.mockResolvedValue([]);
    getGoalDetailMock.mockResolvedValue({
      goal: { ...goal, activeWorkflowRunId: "run-1" },
      refinement: null,
      workspaces: [],
    });
    getWorkflowRunMock.mockResolvedValueOnce({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: "step-1",
        currentNodeKind: "step",
        currentNodeId: "design",
        startedAt: ts,
        finishedAt: null,
        blockedReason: null,
      },
    });
    getWorkflowRunMock.mockResolvedValue({
      run: {
        id: "run-1",
        goalId: "goal-1",
        templateId: "orca/engineering",
        templateVersion: 1,
        status: "active",
        currentStepRunId: null,
        currentNodeKind: "gate",
        currentNodeId: "critique",
        startedAt: ts,
        finishedAt: null,
        blockedReason: null,
        pendingGateReview: null,
      },
    });
    getWorkflowTemplateMock.mockResolvedValue({
      template: {
        steps: [{ id: "design", ordinal: 0, name: "Design" }],
        graph: {
          nodes: [
            { id: "design", type: "step", name: "Design" },
            { id: "critique", type: "gate", name: "Critique" },
          ],
          edges: [{ from: "design", to: "critique" }],
          positions: {},
        },
      },
    });
    listWorkflowDecisionsMock.mockResolvedValue({ decisions: [] });
    listWorkflowRunArtifactsMock.mockResolvedValue({ artifacts: [] });

    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat goals={[{ ...goal, activeWorkflowRunId: "run-1" }]} selectedGoalId="goal-1" connectionStatus="open" />,
    );

    const btn = await screen.findByTestId("step-confirm-continue");
    fireEvent.click(btn);
    await waitFor(() => expect(confirmStepMock).toHaveBeenCalledWith("run-1"));

    // markAnswerPending() fires synchronously on click, before the refetch
    // resolves the next node as a gate — exercising the exact overlap window
    // from the review. Once settled, exactly one tail ThinkingRow renders.
    await waitFor(() => expect(screen.getAllByText(/Working on Critique…/)).toHaveLength(1));
    expect(screen.queryByTestId("answer-thinking")).not.toBeInTheDocument();
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

  // The real parked-terminal state (per the daemon): the final step stays
  // status='active' with finished_at set, awaiting acceptance of the proposed
  // complete_workflow_run recommendation. The tracker must surface an "Approve
  // to complete" affordance that accepts that recommendation so the run + goal
  // flip to 'completed' via the existing completeWorkflowRun path.
  it("surfaces an approve-to-complete affordance and accepts the complete_workflow_run recommendation", async () => {
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
        // Parked: work finished but the run is not complete — awaiting approval.
        status: "active",
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
    // The daemon persists a mark_done_pending activity carrying the rec id —
    // the component derives awaitingApproval + completionRecId from it directly.
    listActivitiesMock.mockResolvedValue([{
      ...activeActivity,
      id: "a-mark-done-1",
      workflowRunId: "run-1",
      stepRunId: "step-verify",
      status: "paused_for_input",
      currentText: "Approve to complete the run.",
      sourceKind: "mark_done_pending",
      workCategory: null,
      confidence: null,
      recommendationId: "rec-complete-1",
    }]);

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Bug Triage & Fix");
    // The parked terminal step must not read as running.
    expect(screen.queryByText("running")).toBeNull();

    // The approve-to-complete affordance appears once the activity loads.
    const approve = await screen.findByRole("button", { name: /approve to complete/i });
    fireEvent.click(approve);

    await waitFor(() =>
      expect(acceptRecommendationMock).toHaveBeenCalledWith("rec-complete-1", {}),
    );
  });

  it("composer reroutes to submitStepRevision when a pendingRevision message is present", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "msg-rev", goalId: "goal-1", role: "orchestrator", kind: "message",
          body: "Here is the step result.", correlationId: "c1", createdAt: now,
          pendingRevision: { workflowRunId: "r1" },
        },
      ],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByPlaceholderText("Message Orca…");
    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Please add more tests." },
    });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(submitStepRevisionMock).toHaveBeenCalledWith("r1", "Please add more tests."),
    );
    expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
  });

  it("clicking the Revise button on a step-confirmation-pending activity calls requestStepRevision", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    listActivitiesMock.mockResolvedValue([
      {
        ...activeActivity,
        id: "a-confirm-revise",
        workflowRunId: "r1",
        status: "paused_for_input",
        sourceKind: "step_confirmation_pending",
        currentText: "Completeness 90% · Ready for handoff.",
      },
    ]);
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    const btn = await screen.findByTestId("step-confirm-revise");
    fireEvent.click(btn);

    await waitFor(() =>
      expect(requestStepRevisionMock).toHaveBeenCalledWith("r1"),
    );
  });

  it("sends composer text to the orchestrator instead of consuming the open worker question", async () => {
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
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which approach should I use?");
    // The orchestrator replies asynchronously while a run is active (reply: null).
    createOrchestratorMessageMock.mockResolvedValue({
      message: {
        id: "msg-user-1", goalId: "goal-1", role: "user", kind: "message",
        body: "Can you explain these options more?", correlationId: null, createdAt: now,
      },
      reply: null,
    });

    // "Can you explain these options more?" must not be swallowed as the answer:
    // an open question no longer hijacks the composer, so the text reaches the
    // orchestrator, which decides whether it settles the question.
    fireEvent.change(screen.getByPlaceholderText("Message Orca…"), {
      target: { value: "Can you explain these options more?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(createOrchestratorMessageMock).toHaveBeenCalledWith("goal-1", {
        body: "Can you explain these options more?",
      }),
    );
    expect(submitWorkerFreeTextMock).not.toHaveBeenCalled();
    // The question stays answerable while the orchestrator replies.
    expect(screen.getByRole("radio", { name: "Use hooks" })).not.toBeDisabled();
  });

  it("keeps the Thinking… row when an invisible activity lands, and clears it only once a visible card arrives", async () => {
    setupRunLoad();
    listActivitiesMock.mockResolvedValue([]);
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

    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
        capturedOnEvent = onEvent;
        return { close: vi.fn() };
      },
    );

    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    await screen.findByText("Which approach should I use?");
    await waitFor(() => expect(listActivitiesMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("radio", { name: "Use hooks" }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(await screen.findByTestId("answer-thinking")).toBeInTheDocument();

    // The agent resumes and creates a fresh turn that has no steps yet: it is
    // neither a timeline card nor a live activity, so nothing visible has
    // replaced the Thinking row — it must stay up rather than blank out.
    const invisibleTurn: Activity = {
      ...activeActivity,
      id: "activity-resumed",
      status: "active",
      sourceKind: "tool_use",
      steps: [],
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    listActivitiesMock.mockResolvedValue([invisibleTurn]);
    act(() => {
      capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });
    });

    await waitFor(() => expect(listActivitiesMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("answer-thinking")).toBeInTheDocument();

    // Once the turn accumulates a step it becomes a visible agent-activity card,
    // which is what should retire the Thinking row.
    const visibleCard: Activity = {
      ...invisibleTurn,
      steps: [{ id: "s1", text: "Wiring up the hook...", category: "editing", status: "active", createdAt: "2099-01-01T00:00:00.000Z" }],
    };
    listActivitiesMock.mockResolvedValue([visibleCard]);
    act(() => {
      capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });
    });

    expect(await screen.findByText("Wiring up the hook...")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("answer-thinking")).toBeNull());
  });

  it("derives the approve-to-complete affordance from the mark_done_pending activity", async () => {
    setupRunLoad();
    listActivitiesMock.mockResolvedValue([{
      ...activeActivity,
      id: "a-mark-done",
      status: "paused_for_input",
      currentText: "Approve to complete the run.",
      sourceKind: "mark_done_pending",
      workCategory: null,
      confidence: null,
      recommendationId: "rec-42",
    }]);
    const { OrcaChat } = await import("./OrcaChat");
    render(
      <OrcaChat
        goals={[goal]}
        selectedGoalId="goal-1"
        connectionStatus="open"
      />,
    );
    const approve = await screen.findByRole("button", { name: /approve/i });
    fireEvent.click(approve);
    await waitFor(() => expect(acceptRecommendationMock).toHaveBeenCalledWith("rec-42", {}));
    expect(listRecommendationsMock).not.toHaveBeenCalled();
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

  it("renders an answered question read-only: chosen option marked, button shows Sent", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] } } };
    render(<ChatMessageRow message={answered as never} goalId="g1" />);
    // The ✓ renders in its own .orca-chat-option-check span (colored green), so
    // it and the label are separate DOM text nodes — assert the chosen label's
    // combined text still reads "✓ A".
    const chosenLabel = document.querySelector(".orca-chat-option-row--chosen .orca-chat-option-label");
    expect(chosenLabel?.textContent).toMatch(/✓\s*A/);
    const sent = screen.getByRole("button", { name: "Sent" });
    expect(sent).toBeDisabled();
    // 'Something else' stays listed (unchecked) so the offered options are complete.
    expect(screen.getByRole("radio", { name: /something else/i })).not.toBeChecked();
  });

  it("marks the chosen option's row distinctly on an answered card, but not the unchosen rows", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    // A two-option answered question: the disabled radio greys out (no filled dot
    // in WKWebView), so the chosen row must carry its own selected treatment.
    const twoOpt = {
      ...workerMsg,
      pendingQuestion: {
        ...workerMsg.pendingQuestion,
        questions: [{ header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
        answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] },
      },
    };
    render(<ChatMessageRow message={twoOpt as never} goalId="g1" />);
    const chosenRow = screen.getByLabelText("A").closest("label")!;
    const otherRow = screen.getByLabelText("B").closest("label")!;
    expect(chosenRow.className).toMatch(/orca-chat-option-row--chosen/);
    expect(otherRow.className).not.toMatch(/orca-chat-option-row--chosen/);
  });

  it("shows the inline free-text answer when answered with 'Something else'", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { freeText: "do it my way" } } };
    render(<ChatMessageRow message={answered as never} goalId="g1" />);
    expect(screen.getByDisplayValue("do it my way")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
  });

  it("shows an answered-in-chat note when answered via the composer", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { viaChat: true } } };
    render(<ChatMessageRow message={answered as never} goalId="g1" />);
    expect(screen.getByText(/answered in chat/i)).toBeInTheDocument();
  });

  it("flips to read-only when a persisted answer lands on the same question message", async () => {
    const { ChatMessageRow } = await import("./OrcaChat");
    const { rerender } = render(<ChatMessageRow message={workerMsg as never} goalId="g1" />);
    // Pending: still selectable, no Sent button yet.
    expect(screen.getByRole("button", { name: /send answer/i })).toBeInTheDocument();
    // The composer answer persists {viaChat:true} on the same message id.
    const answered = { ...workerMsg, pendingQuestion: { ...workerMsg.pendingQuestion, answer: { viaChat: true } } };
    rerender(<ChatMessageRow message={answered as never} goalId="g1" />);
    expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "A" })).toBeDisabled();
  });

  // jsdom does no layout, so simulate an overflowing, scrollable viewport with a
  // backing store for scrollTop (jsdom's own scrollTop setter is a no-op).
  function instrumentScroller(scroller: HTMLElement, scrollHeight: () => number) {
    let scrollTopVal = 0;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: scrollHeight });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => { scrollTopVal = v; },
    });
    return { get scrollTop() { return scrollTopVal; }, set scrollTop(v: number) { scrollTopVal = v; } };
  }

  const streamingActivity = (steps: { id: string; text: string; status: "done" | "active" }[]): Activity => ({
    ...activeActivity,
    id: "stream-card",
    status: "active",
    currentText: "Working…",
    steps: steps.map((s) => ({ ...s, createdAt: now, category: "reading" as const })),
  });

  it("follows streaming activity steps to the bottom while pinned", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });
    listActivitiesMock.mockResolvedValue([streamingActivity([{ id: "s1", text: "Read file A", status: "done" }])]);

    const { OrcaChat } = await import("./OrcaChat");
    const { container } = render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByText("Read file A");

    const scroller = container.querySelector(".orca-chat-scroll") as HTMLElement;
    let height = 200;
    const view = instrumentScroller(scroller, () => height);
    view.scrollTop = 0; // user is sitting at the bottom (no scroll-up event fired)

    // A new step streams into the SAME activity id — content grows past the fold.
    listActivitiesMock.mockResolvedValue([
      streamingActivity([
        { id: "s1", text: "Read file A", status: "done" },
        { id: "s2", text: "Read file B", status: "done" },
        { id: "s3", text: "Editing file C", status: "active" },
      ]),
    ]);
    height = 600;
    capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });

    await screen.findByText("Read file B");
    await waitFor(() => expect(view.scrollTop).toBe(600));
  });

  it("does not follow streaming steps when the user has scrolled up", async () => {
    getGoalDetailMock.mockResolvedValue({ goal, refinement: null, workspaces: [] });
    listOrchestratorMessagesMock.mockResolvedValue({ messages: [] });
    let capturedOnEvent: ((event: { type: string; goalId: string }) => void) | null = null;
    openEventStreamMock.mockImplementation(({ onEvent }: { onEvent: (event: { type: string; goalId: string }) => void }) => {
      capturedOnEvent = onEvent;
      return { close: vi.fn() };
    });
    listActivitiesMock.mockResolvedValue([streamingActivity([{ id: "s1", text: "Read file A", status: "done" }])]);

    const { OrcaChat } = await import("./OrcaChat");
    const { container } = render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    await screen.findByText("Read file A");

    const scroller = container.querySelector(".orca-chat-scroll") as HTMLElement;
    let height = 600;
    const view = instrumentScroller(scroller, () => height);
    // User scrolls up to read history: far from the bottom.
    view.scrollTop = 0;
    fireEvent.scroll(scroller);

    listActivitiesMock.mockResolvedValue([
      streamingActivity([
        { id: "s1", text: "Read file A", status: "done" },
        { id: "s2", text: "Read file B", status: "done" },
      ]),
    ]);
    height = 1200;
    capturedOnEvent!({ type: "activity.changed", goalId: "goal-1" });

    await screen.findByText("Read file B");
    // The follow effect must leave the scrolled-up reader where they are.
    expect(view.scrollTop).toBe(0);
  });
});
