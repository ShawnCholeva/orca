import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@orca/contracts";
import { WorkspacePickerModal } from "./WorkspacePickerModal";

const listWorkspacesMock = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api")>();
  return {
    ...mod,
    listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a),
  };
});

const NOW = "2026-01-01T00:00:00.000Z";
function ws(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-1", path: "/repo/platform", name: "platform", description: "",
    createdAt: NOW, updatedAt: NOW,
    goalCounts: { active: 0, completed: 0, archived: 0 },
    ...overrides,
  };
}

describe("WorkspacePickerModal", () => {
  beforeEach(() => listWorkspacesMock.mockReset());

  it("lists registered workspaces and calls onPick with the chosen one", async () => {
    listWorkspacesMock.mockResolvedValue([
      ws({ id: "ws-1", name: "platform", path: "/repo/platform" }),
      ws({ id: "ws-2", name: "billing", path: "/repo/billing" }),
    ]);
    const onPick = vi.fn();
    render(<WorkspacePickerModal existingPaths={[]} onPick={onPick} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("billing")).toBeInTheDocument());
    fireEvent.click(screen.getByText("billing"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-2", path: "/repo/billing" }));
  });

  it("marks an already-added workspace as added and does not pick it", async () => {
    listWorkspacesMock.mockResolvedValue([ws({ id: "ws-1", name: "platform", path: "/repo/platform" })]);
    const onPick = vi.fn();
    render(
      <WorkspacePickerModal existingPaths={["/repo/platform"]} onPick={onPick} onClose={() => {}} />
    );

    await waitFor(() => expect(screen.getByText("platform")).toBeInTheDocument());
    expect(screen.getByText(/added/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText("platform"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows an empty state with a link to the Workspaces tab", async () => {
    listWorkspacesMock.mockResolvedValue([]);
    const onNavigate = vi.fn();
    render(
      <WorkspacePickerModal
        existingPaths={[]}
        onPick={() => {}}
        onClose={() => {}}
        onNavigateToWorkspaces={onNavigate}
      />
    );

    await waitFor(() => expect(screen.getByText(/no registered workspaces/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /workspaces/i }));
    expect(onNavigate).toHaveBeenCalled();
  });
});
