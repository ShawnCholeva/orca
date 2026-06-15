import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Goal } from "@orca/contracts";
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

const fetchHealthMock = vi.fn();
const listAgentsMock = vi.fn();
const listGoalsMock = vi.fn();
const listPluginsMock = vi.fn();
const listSkillsMock = vi.fn();
const openEventStreamMock = vi.fn();

vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return {
    ...mod,
    fetchHealth: (...args: unknown[]) => fetchHealthMock(...args),
    listAgents: (...args: unknown[]) => listAgentsMock(...args),
    listGoals: (...args: unknown[]) => listGoalsMock(...args),
    listPlugins: (...args: unknown[]) => listPluginsMock(...args),
    listSkills: (...args: unknown[]) => listSkillsMock(...args),
    openEventStream: (...args: unknown[]) => openEventStreamMock(...args),
  };
});

const now = "2026-01-01T00:00:00.000Z";

function makeGoal(): Goal {
  return {
    id: "goal-1",
    title: "Existing Goal",
    description: "An existing goal",
    status: "active",
    autonomyLevel: 1,
    workerPermissionMode: "ask",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
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
    listPluginsMock.mockReset();
    listSkillsMock.mockReset();
    openEventStreamMock.mockReset();

    fetchHealthMock.mockResolvedValue({ status: "ok" });
    listAgentsMock.mockResolvedValue([makeAgent()]);
    listGoalsMock.mockResolvedValue({ goals: [] });
    listPluginsMock.mockResolvedValue([]);
    listSkillsMock.mockResolvedValue([]);
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

    expect(
      screen.getByRole("button", { name: /create your first goal/i }),
    ).toBeInTheDocument();
  });

  it("switches to the Workflows pane when the Workflows tab is clicked", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("tab", { name: /Workflows/ }));

    expect(await screen.findByTestId("workflows-stub")).toBeInTheDocument();
  });

  it("switches to Runtime Diagnostics when the Metrics tab is clicked", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("tab", { name: /Metrics/ }));

    expect(await screen.findByText("Runtime Diagnostics")).toBeInTheDocument();
  });
});

describe("App goal loading on daemon connect", () => {
  beforeEach(() => {
    fetchHealthMock.mockReset();
    listAgentsMock.mockReset();
    listGoalsMock.mockReset();
    listPluginsMock.mockReset();
    listSkillsMock.mockReset();
    openEventStreamMock.mockReset();

    listAgentsMock.mockResolvedValue([makeAgent()]);
    listPluginsMock.mockResolvedValue([]);
    listSkillsMock.mockResolvedValue([]);
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
