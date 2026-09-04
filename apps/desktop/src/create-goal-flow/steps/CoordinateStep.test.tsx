import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowState, FlowAction } from "../state";
import { CoordinateStep } from "./CoordinateStep";

const listModelProvidersMock = vi.fn();
const listWorkflowTemplatesMock = vi.fn();
const listWorkspacesMock = vi.fn();
const inspectWorkspaceMock = vi.fn();
const isTauriMock = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
  invoke: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api")>();
  return {
    ...mod,
    listModelProviders: (...a: unknown[]) => listModelProvidersMock(...a),
    listWorkflowTemplates: (...a: unknown[]) => listWorkflowTemplatesMock(...a),
    listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
    inspectWorkspace: (...a: unknown[]) => inspectWorkspaceMock(...a),
  };
});

const NOW = "2026-01-01T00:00:00.000Z";

function coordinateState(): Extract<FlowState, { phase: "coordinate" }> {
  return {
    phase: "coordinate",
    title: "Goal",
    intent: "",
    successCriteria: ["ship it"],
    pendingWorkspaces: [],
    pendingDocuments: [],
    orchestratorModel: null,
    workflowTemplateId: null,
  };
}

describe("CoordinateStep — registry picker", () => {
  beforeEach(() => {
    listModelProvidersMock.mockResolvedValue([]);
    listWorkflowTemplatesMock.mockResolvedValue({ templates: [] });
    listWorkspacesMock.mockReset();
    inspectWorkspaceMock.mockReset();
  });

  it("picking a registered workspace inspects it and dispatches inspectSucceeded", async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: "ws-2", path: "/repo/billing", name: "billing", description: "",
        createdAt: NOW, updatedAt: NOW, exists: true,
        goalCounts: { active: 0, completed: 0, archived: 0 },
      },
    ]);
    inspectWorkspaceMock.mockResolvedValue({
      preview: {
        path: "/repo/billing", name: "billing", workspaceType: "git",
        branch: "main", isDirty: false, gitProbe: "ok",
      },
    });
    const dispatch = vi.fn<(a: FlowAction) => void>();

    render(<CoordinateStep state={coordinateState()} dispatch={dispatch} />);

    // The picker loads the registry up-front, so wait for the trigger's label,
    // then open the inline dropdown and pick the workspace by name. (Target the
    // visible text rather than the accessible name — the wrapping Field <label>
    // pollutes the sibling Browse button's accessible name.)
    fireEvent.click(await screen.findByText("Pick from registered"));
    fireEvent.click(await screen.findByText("billing"));

    await waitFor(() => expect(inspectWorkspaceMock).toHaveBeenCalledWith({ inputPath: "/repo/billing" }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "inspectSucceeded", inputPath: "/repo/billing", name: "billing" })
      )
    );
  });

  it("excludes a registered workspace whose folder no longer exists on disk", async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: "ws-gone", path: "/repo/deleted", name: "deleted-repo", description: "",
        createdAt: NOW, updatedAt: NOW, exists: false,
        goalCounts: { active: 0, completed: 0, archived: 0 },
      },
    ]);
    const dispatch = vi.fn<(a: FlowAction) => void>();

    render(<CoordinateStep state={coordinateState()} dispatch={dispatch} />);

    // With every registered workspace missing, the picker has nothing to offer
    // and must not surface the stale entry.
    await screen.findByText("All registered added");
    expect(screen.queryByText("deleted-repo")).toBeNull();
  });
});

// D1: `Browse…` called the Tauri dialog unconditionally. Under `dev:browser` the
// IPC bridge is absent, so it threw `Cannot read properties of undefined (reading
// 'invoke')` into the console and the button silently did nothing — the worst
// failure shape, because the control looks available and reports nothing when it
// isn't. `WorkspacesPage.tsx` already had the right pattern: gate on isTauri() and
// offer a typed path instead.
describe("CoordinateStep — browser mode has no Tauri dialog", () => {
  beforeEach(() => {
    listModelProvidersMock.mockResolvedValue([]);
    listWorkflowTemplatesMock.mockResolvedValue({ templates: [] });
    listWorkspacesMock.mockResolvedValue([]);
    inspectWorkspaceMock.mockReset();
  });

  it("offers a typed path instead of a dead Browse button when Tauri is absent", async () => {
    isTauriMock.mockReturnValue(false);
    inspectWorkspaceMock.mockResolvedValue({ preview: { name: "repo", path: "/tmp/repo" } });
    const dispatch = vi.fn();
    render(<CoordinateStep state={coordinateState()} dispatch={dispatch} onNavigateToWorkspaces={() => {}} />);

    expect(screen.queryByRole("button", { name: /Browse/ })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Workspace folder path/i), { target: { value: "/tmp/repo" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add folder$/ }));
    await waitFor(() => expect(inspectWorkspaceMock).toHaveBeenCalledWith({ inputPath: "/tmp/repo" }));
  });

  it("keeps the native picker when Tauri is present", async () => {
    isTauriMock.mockReturnValue(true);
    render(<CoordinateStep state={coordinateState()} dispatch={vi.fn()} onNavigateToWorkspaces={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Browse/ }).length).toBeGreaterThan(0));
    expect(screen.queryByLabelText(/Workspace folder path/i)).toBeNull();
  });
});
