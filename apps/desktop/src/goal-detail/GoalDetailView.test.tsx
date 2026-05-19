import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GoalDetailResponse, Workspace } from "@orca/contracts";

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

function mockDetail(detail: GoalDetailResponse) {
  vi.doMock("../api", () => ({
    getGoalDetail: vi.fn().mockResolvedValue(detail),
    inspectWorkspace: vi.fn(),
    attachWorkspace: vi.fn(),
    detachWorkspace: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listAdapters: vi.fn().mockResolvedValue({ adapters: [] }),
    stopSession: vi.fn(),
    openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
  }));
  vi.doMock("./sessions/SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId }: { sessionId: string }) => (
      <div className="session-terminal" data-session-id={sessionId} />
    ),
  }));
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
      inspectWorkspace: vi.fn(),
      attachWorkspace: vi.fn(),
      detachWorkspace: vi.fn(),
      listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listAdapters: vi.fn().mockResolvedValue({ adapters: [] }),
      stopSession: vi.fn(),
      openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
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
