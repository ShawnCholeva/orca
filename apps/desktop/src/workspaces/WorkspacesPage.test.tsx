import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary, Workspace, WorkspaceGoalView } from "@orca/contracts";
import { WorkspacesPage } from "./WorkspacesPage";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue("/repo/a") }));

const listWorkspacesMock = vi.fn();
const getWorkspaceMock = vi.fn();
const createWorkspaceMock = vi.fn();
const updateWorkspaceMock = vi.fn();
const inspectWorkspaceMock = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  return {
    ...mod,
    listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
    getWorkspace: (...a: unknown[]) => getWorkspaceMock(...a),
    createWorkspace: (...a: unknown[]) => createWorkspaceMock(...a),
    updateWorkspace: (...a: unknown[]) => updateWorkspaceMock(...a),
    inspectWorkspace: (...a: unknown[]) => inspectWorkspaceMock(...a),
    openEventStream: () => ({ close() {} }),
  };
});

const NOW = "2026-01-01T00:00:00.000Z";

function makeWorkspaceSummary(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-1",
    path: "/repo/platform",
    name: "platform",
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
    exists: true,
    goalCounts: { active: 1, completed: 0, archived: 0 },
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    path: "/repo/platform",
    name: "platform",
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<WorkspaceGoalView> = {}): WorkspaceGoalView {
  return {
    id: "goal-1",
    title: "Migrate billing",
    description: "Replace legacy /v1 billing endpoints",
    status: "active",
    createdAt: NOW,
    progress: 0.4,
    ...overrides,
  };
}

describe("WorkspacesPage", () => {
  beforeEach(() => {
    listWorkspacesMock.mockReset();
    getWorkspaceMock.mockReset();
    createWorkspaceMock.mockReset();
    updateWorkspaceMock.mockReset();
    inspectWorkspaceMock.mockReset();
  });

  it("renders empty state when listWorkspaces resolves []", async () => {
    listWorkspacesMock.mockResolvedValue([]);

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Create your first workspace." })).toBeInTheDocument();
  });

  it("empty state: clicking 'Add a folder' opens the create modal", async () => {
    listWorkspacesMock.mockResolvedValue([]);

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    await screen.findByRole("heading", { name: "Create your first workspace." });
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/i }));

    expect(screen.getByText("Choose a folder")).toBeInTheDocument();
  });

  it("renders workspace rows from listWorkspaces and shows count", async () => {
    const ws1 = makeWorkspaceSummary({ id: "ws-1", name: "platform" });
    const ws2 = makeWorkspaceSummary({ id: "ws-2", name: "docs", path: "/repo/docs" });
    listWorkspacesMock.mockResolvedValue([ws1, ws2]);
    getWorkspaceMock.mockResolvedValue({ workspace: makeWorkspace(), goals: [] });

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getAllByText("platform").length).toBeGreaterThan(0);
    expect(screen.getAllByText("docs").length).toBeGreaterThan(0);
  });

  it("selecting a workspace row calls getWorkspace and renders its goals grouped by status", async () => {
    const ws1 = makeWorkspaceSummary({ id: "ws-1", name: "platform" });
    const ws2 = makeWorkspaceSummary({ id: "ws-2", name: "docs", path: "/repo/docs", goalCounts: { active: 0, completed: 1, archived: 0 } });
    const activeGoal = makeGoal({ id: "g-1", title: "Migrate billing", status: "active" });
    const completedGoal = makeGoal({ id: "g-2", title: "Hybrid search MVP", status: "completed", progress: null });

    listWorkspacesMock.mockResolvedValue([ws1, ws2]);
    // First call: platform workspace
    getWorkspaceMock.mockResolvedValueOnce({ workspace: makeWorkspace(), goals: [activeGoal] });
    // Second call: docs workspace
    getWorkspaceMock.mockResolvedValueOnce({
      workspace: makeWorkspace({ id: "ws-2", name: "docs", path: "/repo/docs" }),
      goals: [completedGoal],
    });

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    // First workspace is auto-selected — shows platform's active goal
    expect(await screen.findByText("Migrate billing")).toBeInTheDocument();

    // Switch to docs
    fireEvent.click(screen.getByText("docs"));
    expect(await screen.findByText("Hybrid search MVP")).toBeInTheDocument();
    expect(screen.queryByText("Migrate billing")).not.toBeInTheDocument();

    // Completed group label appears
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);

    expect(getWorkspaceMock).toHaveBeenCalledWith("ws-2");
  });

  it("progress bar shows the active goal's percent and a full 100% bar for a completed goal", async () => {
    const ws = makeWorkspaceSummary();
    const activeGoal = makeGoal({ id: "g-active", title: "Active task", status: "active", progress: 0.5 });
    const completedGoal = makeGoal({ id: "g-done", title: "Done task", status: "completed", progress: 1 });

    listWorkspacesMock.mockResolvedValue([ws]);
    getWorkspaceMock.mockResolvedValue({ workspace: makeWorkspace(), goals: [activeGoal, completedGoal] });

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    await screen.findByText("Active task");
    await screen.findByText("Done task");

    // Active goal shows its in-progress percentage…
    expect(screen.getByText("50%")).toBeInTheDocument();
    // …and the completed goal shows a full 100% bar.
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("create: Browse triggers dialog → inspectWorkspace resolves preview → submit calls createWorkspace", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const openMock = vi.mocked(open);
    openMock.mockResolvedValue("/repo/a");

    const existingWs = makeWorkspaceSummary();
    const newWs = makeWorkspaceSummary({ id: "ws-new", name: "a", path: "/repo/a" });

    listWorkspacesMock.mockResolvedValue([existingWs]);
    getWorkspaceMock.mockResolvedValue({ workspace: makeWorkspace(), goals: [] });
    inspectWorkspaceMock.mockResolvedValue({
      preview: {
        path: "/repo/a",
        name: "a",
        workspaceType: "repo",
        branch: "main",
        isDirty: false,
        gitProbe: "ok",
      },
    });
    createWorkspaceMock.mockResolvedValue(newWs);
    // After create, listWorkspaces refetches
    listWorkspacesMock.mockResolvedValueOnce([existingWs]).mockResolvedValue([existingWs, newWs]);
    getWorkspaceMock.mockResolvedValue({ workspace: makeWorkspace({ id: "ws-new", name: "a", path: "/repo/a" }), goals: [] });

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    await screen.findByRole("heading", { name: "Workspaces" });

    // Open create modal via "New workspace" button
    fireEvent.click(screen.getByTitle("New workspace"));
    expect(screen.getByText("Choose a folder")).toBeInTheDocument();

    // Click Browse
    fireEvent.click(screen.getByRole("button", { name: /Browse/i }));

    // Wait for inspect to complete and preview to show
    await screen.findByText("/repo/a");

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Add workspace/i }));

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputPath: "/repo/a" }),
      );
    });
  });

  it("duplicate path error surfaces inline error in create modal", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const openMock = vi.mocked(open);
    openMock.mockResolvedValue("/repo/a");

    const existingWs = makeWorkspaceSummary();
    listWorkspacesMock.mockResolvedValue([existingWs]);
    getWorkspaceMock.mockResolvedValue({ workspace: makeWorkspace(), goals: [] });
    inspectWorkspaceMock.mockResolvedValue({
      preview: {
        path: "/repo/a",
        name: "a",
        workspaceType: "repo",
        branch: "main",
        isDirty: false,
        gitProbe: "ok",
      },
    });

    // Import ApiError from the real (un-mocked) module via importOriginal pattern
    const { ApiError } = await vi.importActual<typeof import("../api")>("../api");
    const dupError = new ApiError("Workspace already exists", undefined, "workspace_duplicate");
    createWorkspaceMock.mockRejectedValue(dupError);

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);
    await screen.findByRole("heading", { name: "Workspaces" });

    fireEvent.click(screen.getByTitle("New workspace"));
    fireEvent.click(screen.getByRole("button", { name: /Browse/i }));
    await screen.findByText("/repo/a");

    fireEvent.click(screen.getByRole("button", { name: /Add workspace/i }));

    await screen.findByText("This folder has already been added.");
  });

  it("manage: opening Manage modal and saving calls updateWorkspace", async () => {
    const ws = makeWorkspaceSummary({ name: "platform", description: "Our main repo" });
    const wsDetail = makeWorkspace({ name: "platform", description: "Our main repo" });
    const goals: WorkspaceGoalView[] = [];
    const renamedWsDetail = makeWorkspace({ name: "platform-renamed", description: "Our main repo" });

    // First calls return original data, subsequent calls return updated data
    listWorkspacesMock
      .mockResolvedValueOnce([ws])
      .mockResolvedValue([{ ...ws, name: "platform-renamed" }]);
    getWorkspaceMock
      .mockResolvedValueOnce({ workspace: wsDetail, goals })
      .mockResolvedValue({ workspace: renamedWsDetail, goals });
    updateWorkspaceMock.mockResolvedValue(renamedWsDetail);

    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    // Wait for detail pane to load
    await screen.findByRole("heading", { name: "platform" });

    // Open Manage modal
    fireEvent.click(screen.getByRole("button", { name: /Manage/i }));
    expect(screen.getByText("Manage workspace")).toBeInTheDocument();

    // Change the name
    const nameInput = screen.getByPlaceholderText("Workspace name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "platform-renamed" } });

    // Save
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(updateWorkspaceMock).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ name: "platform-renamed" }),
      );
    });
  });
});
