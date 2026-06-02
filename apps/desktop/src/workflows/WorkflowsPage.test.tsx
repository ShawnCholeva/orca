import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "@orca/contracts";
import { WorkflowsPage } from "./WorkflowsPage";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const createTemplateMock = vi.fn();
const listTemplatesMock = vi.fn();
const duplicateTemplateMock = vi.fn();
const saveTemplateMock = vi.fn();

vi.mock("./api", () => ({
  createTemplate: (...args: unknown[]) => createTemplateMock(...args),
  duplicateTemplate: (...args: unknown[]) => duplicateTemplateMock(...args),
  listTemplates: (...args: unknown[]) => listTemplatesMock(...args),
  saveTemplate: (...args: unknown[]) => saveTemplateMock(...args),
}));

const listGoalsMock = vi.fn();
vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  return {
    ...mod,
    listGoals: (...args: unknown[]) => listGoalsMock(...args),
  };
});

const now = "2026-01-01T00:00:00.000Z";

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "orca/engineering",
    name: "Engineering",
    description: "Built-in workflow",
    version: 1,
    isBuiltIn: true,
    isLocked: true,
    steps: [
      {
        id: "intake",
        ordinal: 0,
        name: "Intake",
        instructions: "Clarify work with the user.",
        outputSchema: [{ key: "goal_brief", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
      },
    ],
    guardrails: [],
    createdAt: now,
    updatedAt: now,
    scope: "global",
    scopeName: "",
    graph: null,
    ...overrides,
  };
}

describe("WorkflowsPage", () => {
  beforeEach(() => {
    createTemplateMock.mockReset();
    duplicateTemplateMock.mockReset();
    listTemplatesMock.mockReset();
    saveTemplateMock.mockReset();
    listGoalsMock.mockReset();
    listGoalsMock.mockResolvedValue({ goals: [] });
  });

  it("renders an empty state when there are no templates", async () => {
    listTemplatesMock.mockResolvedValue({ templates: [] });

    render(<WorkflowsPage />);

    expect(await screen.findByText("No workflows in this scope.")).toBeInTheDocument();
  });

  it("scope filter narrows the list; counts shown", async () => {
    const global = makeTemplate({ id: "t1", name: "Global Wf", scope: "global", isBuiltIn: false, isLocked: false });
    const workspace = makeTemplate({ id: "t2", name: "Workspace Wf", scope: "workspace", scopeName: "myrepo", isBuiltIn: false, isLocked: false });
    listTemplatesMock.mockResolvedValue({ templates: [global, workspace] });

    render(<WorkflowsPage />);
    // wait for load by waiting for sidebar to populate
    const sidebar = await screen.findByRole("heading", { name: "Workflows" });
    const sidebarContainer = sidebar.closest(".workflows-page__sidebar")!;

    // Both visible under "all"
    expect(within(sidebarContainer as HTMLElement).getByText("Global Wf")).toBeInTheDocument();
    expect(within(sidebarContainer as HTMLElement).getByText("Workspace Wf")).toBeInTheDocument();

    // Click "Workspace" filter (the button in the sidebar)
    fireEvent.click(within(sidebarContainer as HTMLElement).getByRole("button", { name: /workspace/i }));
    expect(within(sidebarContainer as HTMLElement).queryByText("Global Wf")).toBeNull();
    expect(within(sidebarContainer as HTMLElement).getByText("Workspace Wf")).toBeInTheDocument();
  });

  it("duplicates the built-in template into a custom copy", async () => {
    const builtIn = makeTemplate();
    const copy = makeTemplate({
      id: "custom/engineering-copy",
      name: "Engineering Copy",
      isBuiltIn: false,
      isLocked: false,
    });

    listTemplatesMock.mockResolvedValue({ templates: [builtIn] });
    duplicateTemplateMock.mockResolvedValue({ template: copy, warnings: [] });

    render(<WorkflowsPage />);

    // wait for load
    await screen.findByRole("heading", { name: "Workflows" });
    // Duplicate button is in the detail panel
    const detail = document.querySelector(".workflows-page__detail")!;
    await waitFor(() => expect(within(detail as HTMLElement).queryByRole("button", { name: /duplicate to custom/i })).not.toBeNull());
    fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: /duplicate to custom/i }));

    await waitFor(() =>
      expect(duplicateTemplateMock).toHaveBeenCalledWith("orca/engineering", "Engineering Copy"),
    );
    // After duplicate, the copy appears in the sidebar
    const sidebar = document.querySelector(".workflows-page__sidebar")!;
    await waitFor(() =>
      expect(within(sidebar as HTMLElement).queryByText("Engineering Copy")).not.toBeNull(),
    );
  });

  it("+ creates a local draft; Discard removes it", async () => {
    listTemplatesMock.mockResolvedValue({ templates: [] });

    render(<WorkflowsPage />);
    await screen.findByText("No workflows in this scope.");

    fireEvent.click(screen.getByTitle("New workflow"));

    // Draft badge visible in sidebar and "Create workflow" button in detail
    const sidebar = document.querySelector(".workflows-page__sidebar")!;
    expect(within(sidebar as HTMLElement).getByText("draft")).toBeInTheDocument();

    const detail = document.querySelector(".workflows-page__detail")!;
    expect(within(detail as HTMLElement).getByRole("button", { name: /create workflow/i })).toBeInTheDocument();

    // Discard
    fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: /discard/i }));
    expect(within(sidebar as HTMLElement).queryByText("draft")).toBeNull();
    expect(await screen.findByText("No workflows in this scope.")).toBeInTheDocument();
  });

  it("draft Create calls createTemplate and replaces draft", async () => {
    listTemplatesMock.mockResolvedValue({ templates: [] });
    const created = makeTemplate({
      id: "custom/new-1",
      name: "Untitled workflow",
      isBuiltIn: false,
      isLocked: false,
    });
    createTemplateMock.mockResolvedValue({ template: created, warnings: [] });

    render(<WorkflowsPage />);
    await screen.findByText("No workflows in this scope.");

    fireEvent.click(screen.getByTitle("New workflow"));
    const detail = document.querySelector(".workflows-page__detail")!;
    fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: /create workflow/i }));

    await waitFor(() => expect(createTemplateMock).toHaveBeenCalledTimes(1));
    // draft badge gone
    const sidebar = document.querySelector(".workflows-page__sidebar")!;
    expect(within(sidebar as HTMLElement).queryByText("draft")).toBeNull();
    // created template in sidebar
    await waitFor(() =>
      expect(within(sidebar as HTMLElement).queryByText("Untitled workflow")).not.toBeNull(),
    );
  });

  it("ScopePicker goal options come from listGoals", async () => {
    listTemplatesMock.mockResolvedValue({ templates: [] });
    listGoalsMock.mockResolvedValue({
      goals: [
        {
          id: "g1",
          title: "Alpha Goal",
          description: "",
          status: "active",
          autonomyLevel: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
      ],
    });

    render(<WorkflowsPage />);
    await screen.findByText("No workflows in this scope.");

    // Create a draft — it opens in edit mode by default
    fireEvent.click(screen.getByTitle("New workflow"));

    const detail = document.querySelector(".workflows-page__detail")!;
    // Scope section visible — click "Goal" option in the scope picker
    await waitFor(() =>
      expect(within(detail as HTMLElement).getAllByText("Goal").length).toBeGreaterThan(0),
    );
    // Click the "Goal" scope option inside the ScopePicker
    const goalOptions = within(detail as HTMLElement).getAllByText("Goal");
    // The ScopePicker option (not the ScopeFilter button) — find the one that's a radio-like div
    fireEvent.click(goalOptions[goalOptions.length - 1]!);

    // Goal option from listGoals should be available
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Goal" })).toBeInTheDocument();
    });
  });

  it("custom template: Edit → Save calls saveTemplate with scope/scopeName/graph", async () => {
    const template = makeTemplate({
      id: "custom/t1",
      name: "My Custom",
      isBuiltIn: false,
      isLocked: false,
    });
    listTemplatesMock.mockResolvedValue({ templates: [template] });
    saveTemplateMock.mockResolvedValue({ template: { ...template, version: 2 }, warnings: [] });

    render(<WorkflowsPage />);
    const detail = document.querySelector(".workflows-page__detail")!;
    await waitFor(() =>
      expect(within(detail as HTMLElement).queryByRole("button", { name: /edit/i })).not.toBeNull(),
    );

    fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: /edit/i }));
    fireEvent.click(within(detail as HTMLElement).getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    const [id, payload] = saveTemplateMock.mock.calls[0] as [string, unknown];
    expect(id).toBe("custom/t1");
    expect(payload).toMatchObject({
      scope: "global",
      graph: expect.objectContaining({ nodes: expect.any(Array) }),
    });
  });
});
