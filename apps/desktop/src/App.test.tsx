import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, GoalListItem } from "@orca/contracts";
import type { ConnectionStatus } from "./api";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

// Keep the heavy panes light — they never need to render real terminals/graphs here.
vi.mock("./orchestrator/OrcaChat", () => ({
  OrcaChat: () => <div data-testid="orca-chat-stub">OrcaChat</div>,
}));

vi.mock("./workflows/WorkflowsPage", () => ({
  WorkflowsPage: () => <div data-testid="workflows-stub">WorkflowsPage</div>,
}));

vi.mock("./workspaces/WorkspacesPage", () => ({
  WorkspacesPage: () => <div data-testid="workspaces-stub">WorkspacesPage</div>,
}));

const fetchHealthMock = vi.fn();
const listAgentsMock = vi.fn();
const listGoalsMock = vi.fn();
const openEventStreamMock = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return {
    ...mod,
    fetchHealth: (...args: unknown[]) => fetchHealthMock(...args),
    listAgents: (...args: unknown[]) => listAgentsMock(...args),
    listGoals: (...args: unknown[]) => listGoalsMock(...args),
    openEventStream: (...args: unknown[]) => openEventStreamMock(...args),
  };
});

const now = "2026-01-01T00:00:00.000Z";

function makeGoal(overrides: Partial<GoalListItem> = {}): GoalListItem {
  return {
    id: "goal-1",
    title: "Existing Goal",
    intent: "An existing goal",
    status: "active",
    autonomyLevel: 1,
    workerPermissionMode: "ask",
    operatingMode: "human_review",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    workspaces: [],
    ...overrides,
  };
}

function makeAgent(): Agent {
  return {
    id: "claude-code",
    name: "Claude Code",
    shortLabel: "Claude",
    description: "Claude Code agent",
    swatch: "#000000",
    recommended: true,
    connected: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("App tab visibility with zero goals", () => {
  beforeEach(() => {
    fetchHealthMock.mockReset();
    listAgentsMock.mockReset();
    listGoalsMock.mockReset();
    openEventStreamMock.mockReset();

    fetchHealthMock.mockResolvedValue({ status: "ok" });
    listAgentsMock.mockResolvedValue([makeAgent()]);
    listGoalsMock.mockResolvedValue({ goals: [] });
    openEventStreamMock.mockReturnValue({ close: vi.fn() });
  });

  async function renderApp() {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    // Wait for onboarding to complete (agent is connected) and tabs to render.
    return waitFor(() =>
      expect(screen.getByRole("tab", { name: /Orchestrator/ })).toBeInTheDocument(),
    );
  }

  it("renders the three workspace tabs with zero goals", async () => {
    await renderApp();

    expect(screen.getByRole("tab", { name: /Orchestrator/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Workflows/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Metrics/ })).toBeInTheDocument();
  });

  it("shows the create-goal empty state in the Orchestrator pane", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("tab", { name: /Orchestrator/ }));

    expect(
      screen.getByRole("button", { name: /create your first goal/i }),
    ).toBeInTheDocument();
  });

  it("switches to the Workflows pane when the Workflows tab is clicked", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("tab", { name: /Workflows/ }));

    expect(await screen.findByTestId("workflows-stub")).toBeInTheDocument();
  });

  it("switches to Metrics when the Metrics tab is clicked", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("tab", { name: /Metrics/ }));

    expect(await screen.findByText("Workflow health")).toBeInTheDocument();
  });
});

describe("App goal loading on daemon connect", () => {
  beforeEach(() => {
    fetchHealthMock.mockReset();
    listAgentsMock.mockReset();
    listGoalsMock.mockReset();
    openEventStreamMock.mockReset();

    listAgentsMock.mockResolvedValue([makeAgent()]);
  });

  // Regression: when the app starts before the daemon's HTTP server is
  // reachable, the mount-time goal fetch fails. The list must refetch once the
  // connection opens — not stay empty until an unrelated goal event arrives.
  it("loads goals once the daemon connection opens, without a goal event", async () => {
    let daemonUp = false;
    const goalRequest = () =>
      daemonUp
        ? Promise.resolve({ goals: [makeGoal()] })
        : Promise.reject(new Error("ECONNREFUSED"));

    fetchHealthMock.mockImplementation(() =>
      daemonUp ? Promise.resolve({ status: "ok" }) : Promise.reject(new Error("ECONNREFUSED")),
    );
    listGoalsMock.mockImplementation(goalRequest);

    let streamStatus: ((status: ConnectionStatus) => void) | undefined;
    openEventStreamMock.mockImplementation(
      (handlers: { onStatus: (status: ConnectionStatus) => void }) => {
        streamStatus = handlers.onStatus;
        return { close: vi.fn() };
      },
    );

    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    // Daemon is up now; the event stream reports the connection is open.
    daemonUp = true;
    await waitFor(() => expect(streamStatus).toBeDefined());
    act(() => streamStatus!("open"));

    expect(await screen.findByText("Existing Goal")).toBeInTheDocument();
  });
});

describe("Goals rail workspace filter", () => {
  const alpha = { id: "ws-alpha", name: "Alpha" };
  const beta = { id: "ws-beta", name: "Beta" };

  // A goal in Alpha, a goal in both Alpha+Beta, and a goal with no workspace.
  const goals: GoalListItem[] = [
    makeGoal({ id: "g-alpha", title: "Alpha Goal", workspaces: [alpha] }),
    makeGoal({ id: "g-both", title: "Both Goal", workspaces: [alpha, beta] }),
    makeGoal({ id: "g-none", title: "Loose Goal", workspaces: [] }),
  ];

  beforeEach(() => {
    fetchHealthMock.mockReset();
    listAgentsMock.mockReset();
    listGoalsMock.mockReset();
    openEventStreamMock.mockReset();

    fetchHealthMock.mockResolvedValue({ status: "ok" });
    listAgentsMock.mockResolvedValue([makeAgent()]);
    listGoalsMock.mockResolvedValue({ goals });
    openEventStreamMock.mockReturnValue({ close: vi.fn() });
  });

  // The goals rail is the <aside aria-label="Goals"> (role "complementary").
  // Scope queries to it so a goal title in the breadcrumb doesn't leak matches.
  async function renderApp() {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    const rail = await screen.findByRole("complementary", { name: "Goals" });
    await within(rail).findByText("Alpha Goal");
    const select = within(rail).getByRole("combobox", { name: /filter goals by workspace/i });
    return { rail, select };
  }

  it("shows every goal under the default 'All workspaces' option", async () => {
    const { rail } = await renderApp();

    expect(within(rail).getByText("Alpha Goal")).toBeInTheDocument();
    expect(within(rail).getByText("Both Goal")).toBeInTheDocument();
    expect(within(rail).getByText("Loose Goal")).toBeInTheDocument();
  });

  it("derives filter options from the loaded goals' workspaces", async () => {
    const { select } = await renderApp();

    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["All workspaces", "Alpha", "Beta"]);
  });

  it("narrows to a workspace's goals, including a multi-workspace goal", async () => {
    const { rail, select } = await renderApp();

    fireEvent.change(select, { target: { value: "ws-beta" } });

    // Only the goal attached to Beta remains; the Alpha-only and no-workspace goals drop out.
    expect(within(rail).getByText("Both Goal")).toBeInTheDocument();
    expect(within(rail).queryByText("Alpha Goal")).not.toBeInTheDocument();
    expect(within(rail).queryByText("Loose Goal")).not.toBeInTheDocument();
  });

  it("keeps a no-workspace goal visible only under 'All workspaces'", async () => {
    const { rail, select } = await renderApp();

    fireEvent.change(select, { target: { value: "ws-alpha" } });
    expect(within(rail).queryByText("Loose Goal")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "all" } });
    expect(within(rail).getByText("Loose Goal")).toBeInTheDocument();
  });

  it("resets a dangling filter to 'All workspaces' when its workspace disappears", async () => {
    // Capture the event-stream handler so we can simulate a live goal-list refresh.
    let onEvent: ((event: { type: string; goalId: string | null }) => void) | undefined;
    openEventStreamMock.mockImplementation(
      (handlers: { onEvent: (event: { type: string; goalId: string | null }) => void }) => {
        onEvent = handlers.onEvent;
        return { close: vi.fn() };
      },
    );

    const { rail, select } = await renderApp();
    fireEvent.change(select, { target: { value: "ws-beta" } });
    expect(within(rail).queryByText("Alpha Goal")).not.toBeInTheDocument();

    // The only Beta goal loses its workspace; a live refresh returns goals
    // where Beta no longer appears, so the filter must fall back to "all".
    listGoalsMock.mockResolvedValue({
      goals: [
        makeGoal({ id: "g-alpha", title: "Alpha Goal", workspaces: [alpha] }),
        makeGoal({ id: "g-both", title: "Both Goal", workspaces: [alpha] }),
        makeGoal({ id: "g-none", title: "Loose Goal", workspaces: [] }),
      ],
    });

    await act(async () => {
      onEvent!({ type: "workspace.removed", goalId: "g-both" });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect((select as HTMLSelectElement).value).toBe("all"),
    );
    // Beta is gone from the options; every remaining goal is visible again.
    expect(within(rail).getByText("Alpha Goal")).toBeInTheDocument();
    expect(within(rail).getByText("Loose Goal")).toBeInTheDocument();
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["All workspaces", "Alpha"]);
  });
});
