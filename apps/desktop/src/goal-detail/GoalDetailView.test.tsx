import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GoalDetailResponse, Workspace, DomainEvent } from "@orca/contracts";
import type { ConnectionStatus } from "../api";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

const goal = {
  id: "goal-1",
  title: "Ship M3",
  description: "Milestone 3 implementation",
  status: "active" as const,
  autonomyLevel: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const refinement = {
  goalId: "goal-1",
  skillId: "guided-goal-refinement",
  successCriteria: ["Detail view renders", "Workspaces show in order"],
  constraints: ["Deterministic only"],
  assumptions: ["Local daemon running"],
  refinedAt: now,
};

function makeWorkspace(id: string, name: string, attachedAt: string): Workspace {
  return {
    id,
    goalId: "goal-1",
    path: `/home/user/${name}`,
    name,
    workspaceType: "folder" as const,
    branch: null,
    isDirty: null,
    gitProbe: "not_a_repo" as const,
    attachedAt,
  };
}

const ws1 = makeWorkspace("ws-1", "alpha", "2026-01-01T00:00:01.000Z");
const ws2 = makeWorkspace("ws-2", "beta", "2026-01-01T00:00:02.000Z");

class ApiError extends Error {
  code: string | undefined;
  constructor(message: string, _cause?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function makeBaseApiMock(overrides: Record<string, unknown> = {}) {
  return {
    inspectWorkspace: vi.fn(),
    attachWorkspace: vi.fn(),
    detachWorkspace: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [] }),
    listAdapters: vi.fn().mockResolvedValue({ adapters: [] }),
    listTasks: vi.fn().mockResolvedValue({ tasks: [], generations: [] }),
    listConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
    resolveConflict: vi.fn(),
    generateTasks: vi.fn(),
    patchTask: vi.fn(),
    splitTask: vi.fn(),
    listRecommendations: vi.fn().mockResolvedValue({ recommendations: [], generations: [] }),
    getRecommendation: vi.fn().mockResolvedValue({
      recommendation: {
        id: "rec-1",
        goalId: "goal-1",
        type: "update_plan",
        status: "proposed",
        source: "deterministic_provider",
        title: "Update plan",
        rationale: "Keep the task plan current.",
        proposedAction: { kind: "update_plan", taskId: "task-1" },
        confidence: 0.8,
        sources: [],
        relatedTaskId: "task-1",
        relatedSessionId: null,
        relatedContextPackageId: null,
        relatedConflictId: null,
        generationId: null,
        fingerprint: "rec-fp",
        supersededById: null,
        createdAt: now,
        updatedAt: now,
      },
      feedback: [],
    }),
    generateRecommendations: vi.fn(),
    acceptRecommendation: vi.fn(),
    rejectRecommendation: vi.fn(),
    dismissRecommendation: vi.fn(),
    modifyRecommendation: vi.fn(),
    listGoalMemory: vi.fn().mockResolvedValue([]),
    listGoalDecisions: vi.fn().mockResolvedValue([]),
    stopSession: vi.fn(),
    openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    extractSessionMemory: vi.fn().mockResolvedValue({ id: "ext-1", status: "pending" }),
    ApiError,
    ...overrides,
  };
}

function mockDetail(detail: GoalDetailResponse) {
  vi.doMock("../api", () => ({
    getGoalDetail: vi.fn().mockResolvedValue(detail),
    ...makeBaseApiMock(),
  }));
  vi.doMock("./sessions/SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId }: { sessionId: string }) => (
      <div className="session-terminal" data-session-id={sessionId} />
    ),
  }));
}

function makeEvent(
  type: DomainEvent["type"],
  goalId: string = "goal-1",
  payload: Record<string, unknown> = {},
): DomainEvent {
  return {
    seq: 1,
    id: "evt-1",
    type,
    goalId,
    payload,
    createdAt: now,
  };
}

function setupM5EventCapture() {
  let capturedOnEvent: ((e: DomainEvent) => void) = () => {};
  let capturedOnStatus: ((s: ConnectionStatus) => void) = () => {};
  const listGoalMemoryMock = vi.fn().mockResolvedValue([]);
  const listGoalDecisionsMock = vi.fn().mockResolvedValue([]);

  vi.doMock("../api", () => ({
    getGoalDetail: vi.fn().mockResolvedValue({ goal, refinement: null, workspaces: [] }),
    ...makeBaseApiMock({
      listGoalMemory: listGoalMemoryMock,
      listGoalDecisions: listGoalDecisionsMock,
      openEventStream: vi.fn().mockImplementation(
        (handlers: { onEvent: (e: DomainEvent) => void; onStatus: (s: ConnectionStatus) => void }) => {
          capturedOnEvent = handlers.onEvent;
          capturedOnStatus = handlers.onStatus;
          return { close: vi.fn() };
        },
      ),
    }),
  }));

  vi.doMock("./sessions/SessionsPanel", () => ({
    SessionsPanel: () => <div className="sessions-panel" />,
  }));

  vi.doMock("./sessions/SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId }: { sessionId: string }) => (
      <div className="session-terminal" data-session-id={sessionId} />
    ),
  }));

  return {
    getOnEvent: () => capturedOnEvent,
    getOnStatus: () => capturedOnStatus,
    listGoalMemoryMock,
    listGoalDecisionsMock,
  };
}

function setupM7EventCapture() {
  let capturedOnEvent: ((e: DomainEvent) => void) = () => {};
  let capturedOnStatus: ((s: ConnectionStatus) => void) = () => {};
  const listTasksMock = vi.fn().mockResolvedValue({ tasks: [], generations: [] });
  const listRecommendationsMock = vi.fn().mockResolvedValue({ recommendations: [], generations: [] });
  const getRecommendationMock = vi.fn().mockResolvedValue({
    recommendation: {
      id: "rec-1",
      goalId: "goal-1",
      type: "update_plan",
      status: "modified",
      source: "deterministic_provider",
      title: "Updated recommendation",
      rationale: "Plan changed.",
      proposedAction: { kind: "update_plan", taskId: "task-1" },
      confidence: 0.8,
      sources: [],
      relatedTaskId: "task-1",
      relatedSessionId: null,
      relatedContextPackageId: null,
      relatedConflictId: null,
      generationId: null,
      fingerprint: "rec-fp",
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    },
    feedback: [],
  });
  const listConflictsMock = vi.fn().mockResolvedValue({ conflicts: [] });

  vi.doMock("../api", () => ({
    getGoalDetail: vi.fn().mockResolvedValue({ goal, refinement: null, workspaces: [] }),
    ...makeBaseApiMock({
      listTasks: listTasksMock,
      listRecommendations: listRecommendationsMock,
      getRecommendation: getRecommendationMock,
      listConflicts: listConflictsMock,
      openEventStream: vi.fn().mockImplementation(
        (handlers: { onEvent: (e: DomainEvent) => void; onStatus: (s: ConnectionStatus) => void }) => {
          capturedOnEvent = handlers.onEvent;
          capturedOnStatus = handlers.onStatus;
          return { close: vi.fn() };
        },
      ),
    }),
  }));

  vi.doMock("./sessions/SessionsPanel", () => ({
    SessionsPanel: () => <div className="sessions-panel" />,
  }));

  vi.doMock("./sessions/SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId }: { sessionId: string }) => (
      <div className="session-terminal" data-session-id={sessionId} />
    ),
  }));

  return {
    getOnEvent: () => capturedOnEvent,
    getOnStatus: () => capturedOnStatus,
    listTasksMock,
    listRecommendationsMock,
    getRecommendationMock,
    listConflictsMock,
  };
}

describe("GoalDetailView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("renders refinement section when refinement exists", async () => {
    mockDetail({ goal, refinement, workspaces: [] });
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    expect(container.querySelector(".goal-refinement")).toBeTruthy();
    expect(container.textContent).toContain("Success Criteria");
    expect(container.textContent).toContain("Detail view renders");
    expect(container.textContent).toContain("Constraints");
  });

  it("does not render refinement section when refinement is null", async () => {
    mockDetail({ goal, refinement: null, workspaces: [] });
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    expect(container.querySelector(".goal-refinement")).toBeNull();
  });

  it("renders workspaces in attach order", async () => {
    mockDetail({ goal, refinement: null, workspaces: [ws1, ws2] });
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    const items = container.querySelectorAll(".workspace-list-name");
    expect(items[0]?.textContent).toBe("alpha");
    expect(items[1]?.textContent).toBe("beta");
  });

  it("renders sessions panel", async () => {
    mockDetail({ goal, refinement: null, workspaces: [ws1] });
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    expect(container.querySelector(".sessions-panel")).toBeTruthy();
  });

  it("calls getGoalDetail again when refreshKey changes", async () => {
    const getGoalDetailMock = vi.fn().mockResolvedValue({ goal, refinement: null, workspaces: [] });
    vi.doMock("../api", () => ({
      getGoalDetail: getGoalDetailMock,
      ...makeBaseApiMock(),
    }));
    vi.doMock("./sessions/SessionTerminalView", () => ({
      SessionTerminalView: ({ sessionId }: { sessionId: string }) => (
        <div className="session-terminal" data-session-id={sessionId} />
      ),
    }));
    const { GoalDetailView } = await import("./GoalDetailView");

    let root: ReturnType<typeof createRoot>;

    await act(async () => {
      root = createRoot(container);
      root.render(<GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />);
    });

    expect(getGoalDetailMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root!.render(<GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={1} />);
    });

    expect(getGoalDetailMock).toHaveBeenCalledTimes(2);
  });
});

describe("GoalDetailView M5 live-refresh", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("memory.item.created triggers listGoalMemory refetch", async () => {
    const { getOnEvent, listGoalMemoryMock } = setupM5EventCapture();
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    const callsAfterMount = listGoalMemoryMock.mock.calls.length;
    await act(async () => {
      getOnEvent()(makeEvent("memory.item.created"));
    });

    expect(listGoalMemoryMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("decision.confirmed triggers listGoalDecisions refetch", async () => {
    const { getOnEvent, listGoalDecisionsMock } = setupM5EventCapture();
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    const callsAfterMount = listGoalDecisionsMock.mock.calls.length;
    await act(async () => {
      getOnEvent()(makeEvent("decision.confirmed"));
    });

    expect(listGoalDecisionsMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("memory.extraction.completed triggers both memory and decisions refetch", async () => {
    const { getOnEvent, listGoalMemoryMock, listGoalDecisionsMock } = setupM5EventCapture();
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    const memoryCalls = listGoalMemoryMock.mock.calls.length;
    const decisionCalls = listGoalDecisionsMock.mock.calls.length;
    await act(async () => {
      getOnEvent()(makeEvent("memory.extraction.completed"));
    });

    expect(listGoalMemoryMock.mock.calls.length).toBeGreaterThan(memoryCalls);
    expect(listGoalDecisionsMock.mock.calls.length).toBeGreaterThan(decisionCalls);
  });

  it("event for different goal does not trigger refetch", async () => {
    const { getOnEvent, listGoalMemoryMock } = setupM5EventCapture();
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    const callsAfterMount = listGoalMemoryMock.mock.calls.length;
    await act(async () => {
      getOnEvent()(makeEvent("memory.item.created", "goal-other"));
    });

    expect(listGoalMemoryMock.mock.calls.length).toBe(callsAfterMount);
  });

  it("reconnect triggers memory and decisions refetch", async () => {
    const { getOnStatus, listGoalMemoryMock, listGoalDecisionsMock } = setupM5EventCapture();
    const { GoalDetailView } = await import("./GoalDetailView");

    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });

    // first open = initial connection, no refetch
    await act(async () => {
      getOnStatus()("open");
    });

    const memoryCalls = listGoalMemoryMock.mock.calls.length;
    const decisionCalls = listGoalDecisionsMock.mock.calls.length;

    // second open = reconnect, triggers refetch
    await act(async () => {
      getOnStatus()("open");
    });

    expect(listGoalMemoryMock.mock.calls.length).toBeGreaterThan(memoryCalls);
    expect(listGoalDecisionsMock.mock.calls.length).toBeGreaterThan(decisionCalls);
  });
});

describe("GoalDetailView M7 live-refresh", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.removeChild(container);
  });

  async function renderView() {
    const { GoalDetailView } = await import("./GoalDetailView");
    await act(async () => {
      createRoot(container).render(
        <GoalDetailView goalId="goal-1" onBack={vi.fn()} refreshKey={0} />,
      );
    });
  }

  async function advanceRefresh(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await act(async () => {});
  }

  it("debounces rapid task events and keeps recommendation scope untouched", async () => {
    const { getOnEvent, listTasksMock, listRecommendationsMock } = setupM7EventCapture();
    await renderView();

    const taskCallsAfterMount = listTasksMock.mock.calls.length;
    const recommendationCallsAfterMount = listRecommendationsMock.mock.calls.length;

    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        getOnEvent()(
          makeEvent("task.created", "goal-1", {
            taskId: `task-${i}`,
            goalId: "goal-1",
            status: "open",
            role: "engineer",
            workspaceId: null,
            origin: "manual",
            generationId: null,
          }),
        );
      }
    });

    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount);
    await advanceRefresh(199);
    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount);
    await advanceRefresh(1);

    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount + 1);
    expect(listRecommendationsMock).toHaveBeenCalledTimes(recommendationCallsAfterMount);
  });

  it("updates task generation banner without list refetch until terminal event", async () => {
    const { getOnEvent, listTasksMock } = setupM7EventCapture();
    await renderView();

    const taskCallsAfterMount = listTasksMock.mock.calls.length;

    await act(async () => {
      getOnEvent()(
        makeEvent("task.generation.requested", "goal-1", {
          generationId: "task-gen-1",
          goalId: "goal-1",
          trigger: "manual",
          triggerSourceId: null,
        }),
      );
    });

    expect(container.querySelector(".task-generation-banner--pending")).toBeTruthy();
    await advanceRefresh(200);
    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount);

    await act(async () => {
      getOnEvent()(
        makeEvent("task.generated", "goal-1", {
          generationId: "task-gen-1",
          goalId: "goal-1",
          taskIds: ["task-1"],
          count: 1,
          sparse: false,
        }),
      );
    });
    await advanceRefresh(200);

    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount + 1);
  });

  it("recommendation lifecycle events refetch recommendations and task scope only when task-related", async () => {
    const { getOnEvent, listTasksMock, listRecommendationsMock } = setupM7EventCapture();
    await renderView();

    const taskCallsAfterMount = listTasksMock.mock.calls.length;
    const recommendationCallsAfterMount = listRecommendationsMock.mock.calls.length;

    await act(async () => {
      getOnEvent()(
        makeEvent("recommendation.accepted", "goal-1", {
          recommendationId: "rec-1",
          goalId: "goal-1",
          type: "update_plan",
        }),
      );
    });
    await advanceRefresh(200);

    expect(listRecommendationsMock).toHaveBeenCalledTimes(recommendationCallsAfterMount + 1);
    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount + 1);
  });

  it("user feedback event refetches only the affected recommendation detail", async () => {
    const {
      getOnEvent,
      listTasksMock,
      listRecommendationsMock,
      getRecommendationMock,
    } = setupM7EventCapture();
    await renderView();

    const taskCallsAfterMount = listTasksMock.mock.calls.length;
    const recommendationCallsAfterMount = listRecommendationsMock.mock.calls.length;

    await act(async () => {
      getOnEvent()(
        makeEvent("user.feedback.recorded", "goal-1", {
          feedbackId: "fb-1",
          goalId: "goal-1",
          recommendationId: "rec-1",
          action: "modify",
        }),
      );
    });
    await advanceRefresh(200);

    expect(getRecommendationMock).toHaveBeenCalledWith("rec-1");
    expect(listRecommendationsMock).toHaveBeenCalledTimes(recommendationCallsAfterMount);
    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount);
  });

  it("conflict events refetch only conflicts", async () => {
    const { getOnEvent, listTasksMock, listRecommendationsMock, listConflictsMock } =
      setupM7EventCapture();
    await renderView();

    const taskCallsAfterMount = listTasksMock.mock.calls.length;
    const recommendationCallsAfterMount = listRecommendationsMock.mock.calls.length;
    const conflictCallsAfterMount = listConflictsMock.mock.calls.length;

    await act(async () => {
      getOnEvent()(
        makeEvent("conflict.detected", "goal-1", {
          conflictId: "conflict-1",
          goalId: "goal-1",
          conflictType: "workspace_overlap",
          severity: "warning",
        }),
      );
    });
    await advanceRefresh(200);

    expect(listConflictsMock).toHaveBeenCalledTimes(conflictCallsAfterMount + 1);
    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterMount);
    expect(listRecommendationsMock).toHaveBeenCalledTimes(recommendationCallsAfterMount);
  });

  it("reconnect refetches M7 panels for the active goal", async () => {
    const { getOnStatus, listTasksMock, listRecommendationsMock, listConflictsMock } =
      setupM7EventCapture();
    await renderView();

    await act(async () => {
      getOnStatus()("open");
    });

    const taskCallsAfterFirstOpen = listTasksMock.mock.calls.length;
    const recommendationCallsAfterFirstOpen = listRecommendationsMock.mock.calls.length;
    const conflictCallsAfterFirstOpen = listConflictsMock.mock.calls.length;

    await act(async () => {
      getOnStatus()("open");
    });
    await advanceRefresh(200);

    expect(listTasksMock).toHaveBeenCalledTimes(taskCallsAfterFirstOpen + 1);
    expect(listRecommendationsMock).toHaveBeenCalledTimes(recommendationCallsAfterFirstOpen + 1);
    expect(listConflictsMock).toHaveBeenCalledTimes(conflictCallsAfterFirstOpen + 1);
  });
});
