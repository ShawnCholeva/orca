import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacesPage } from "./WorkspacesPage";

declare global {
  // eslint-disable-next-line no-var
  var __forceEmptyWorkspaces: boolean | undefined;
}

afterEach(() => {
  delete (window as unknown as { __forceEmptyWorkspaces?: boolean }).__forceEmptyWorkspaces;
});

describe("WorkspacesPage", () => {
  it("renders the populated two-pane view with the first workspace selected", () => {
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    // List header with count + the seeded workspace rows.
    expect(screen.getByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
    // platform is first and owns four repos → its goals show in the detail pane.
    expect(screen.getByRole("heading", { name: "platform" })).toBeInTheDocument();
    expect(screen.getByText("Migrate billing to Stripe v3")).toBeInTheDocument();
    // Status group dividers appear only for non-empty groups (the label also
    // shows on each goal's status pill, so there is more than one match).
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
  });

  it("derives goal membership by repo intersection when switching workspaces", () => {
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    fireEvent.click(screen.getByText("docs"));

    // docs owns docs/site + search/index → only the hybrid-search goal.
    expect(screen.getByText("Hybrid search MVP for docs")).toBeInTheDocument();
    expect(screen.queryByText("Migrate billing to Stripe v3")).not.toBeInTheDocument();
    // That goal is completed → shown under the Completed group.
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
  });

  it("shows the empty state behind the preview flag without losing the seed list", () => {
    (window as unknown as { __forceEmptyWorkspaces?: boolean }).__forceEmptyWorkspaces = true;
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Create your first workspace" })).toBeInTheDocument();

    // Opening the picker still lists the seeded folders.
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));
    expect(screen.getByText("Choose a folder")).toBeInTheDocument();
  });

  it("creates a workspace from a folder and selects it", () => {
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    fireEvent.click(screen.getByText("web-app"));
    fireEvent.click(screen.getByRole("button", { name: /Add workspace/ }));

    // New workspace becomes the selected detail pane (org "local").
    expect(screen.getByRole("heading", { name: "web-app" })).toBeInTheDocument();
    expect(screen.getByText("local / workspace")).toBeInTheDocument();
  });

  it("blocks a manage rename that collides with another workspace slug", () => {
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Manage/ }));
    const dialogName = screen.getByPlaceholderText("Workspace name") as HTMLInputElement;
    fireEvent.change(dialogName, { target: { value: "edge" } });

    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("truncates goal summaries (2-line clamp styling applied)", () => {
    render(<WorkspacesPage onCreateGoal={vi.fn()} />);

    // happy-dom drops the vendor-prefixed -webkit-box / -webkit-line-clamp from
    // the serialized inline style, so assert the overflow guards that do apply.
    const summary = screen.getByText(/Replace legacy \/v1 billing endpoints/);
    expect(summary).toHaveStyle({ overflow: "hidden", textOverflow: "ellipsis" });
  });
});
