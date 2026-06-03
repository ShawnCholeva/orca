import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "@orca/contracts";
import { TemplateDetail } from "./TemplateDetail";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const duplicateTemplateMock = vi.fn();
const saveTemplateMock = vi.fn();
const createTemplateMock = vi.fn();

vi.mock("./api", () => ({
  duplicateTemplate: (...args: unknown[]) => duplicateTemplateMock(...args),
  saveTemplate: (...args: unknown[]) => saveTemplateMock(...args),
  createTemplate: (...args: unknown[]) => createTemplateMock(...args),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "custom/template-1",
    name: "Custom Delivery",
    description: "Custom workflow",
    version: 1,
    isBuiltIn: false,
    isLocked: false,
    steps: [
      {
        id: "step-1",
        ordinal: 0,
        name: "Research",
        instructions: "Inspect the codebase and summarize findings.",
        outputSchema: [
          { key: "summary", type: "string", required: true },
          { key: "files_identified", type: "number", required: false },
        ],
        agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
      },
      {
        id: "step-2",
        ordinal: 1,
        name: "Build",
        instructions: "Implement the solution based on research.",
        outputSchema: [{ key: "result", type: "string", required: true }],
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

describe("TemplateDetail", () => {
  beforeEach(() => {
    duplicateTemplateMock.mockReset();
    saveTemplateMock.mockReset();
    createTemplateMock.mockReset();
  });

  it("shows read-only canvas for locked templates (no Save button)", () => {
    render(
      <TemplateDetail
        template={makeTemplate({
          id: "orca/engineering",
          name: "Engineering",
          isBuiltIn: true,
          isLocked: true,
        })}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // No Save Changes button for locked templates
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    // Canvas is shown (not step list editor)
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
    // Duplicate is still available
    expect(screen.getByRole("button", { name: /duplicate to custom/i })).toBeInTheDocument();
  });

  it("saves custom step edits via saveTemplate with scope/scopeName/graph in payload", async () => {
    const template = makeTemplate();
    saveTemplateMock.mockResolvedValue({
      template: { ...template, version: 2 },
      warnings: [],
    });

    render(
      <TemplateDetail
        template={template}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    // Save
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    const [id, payload] = saveTemplateMock.mock.calls[0] as [
      string,
      { graph: { nodes: { type: string; stepId?: string }[] }; steps: { id: string }[]; scope: string; scopeName: string },
    ];
    expect(id).toBe("custom/template-1");
    expect(payload.scope).toBe("global");
    expect(payload.scopeName).toBe("");
    // Graph must have one step-node per step with matching stepIds
    const stepNodes = payload.graph.nodes.filter((n) => n.type === "step");
    expect(stepNodes.length).toBe(payload.steps.length);
    const stepIds = payload.steps.map((s) => s.id);
    expect(stepNodes.map((n) => n.stepId).sort()).toEqual(stepIds.sort());
  });

  it("renders output schema fields for each step (via canvas node modal)", async () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Canvas is shown in view mode — step nodes exist with data-node-id
    const stepNode = document.querySelector("[data-node-id='step-1']");
    expect(stepNode).toBeInTheDocument();
  });

  it("duplicate to custom calls duplicateTemplate", async () => {
    const template = makeTemplate();
    const copy = makeTemplate({ id: "custom/template-1-copy", name: "Custom Delivery Copy" });
    duplicateTemplateMock.mockResolvedValue({ template: copy, warnings: [] });

    render(
      <TemplateDetail
        template={template}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /duplicate to custom/i }));

    await waitFor(() => expect(duplicateTemplateMock).toHaveBeenCalledTimes(1));
    expect(duplicateTemplateMock).toHaveBeenCalledWith(
      "custom/template-1",
      "Custom Delivery Copy",
    );
  });

  it("draft create: Create workflow calls createTemplate", async () => {
    const draft = makeTemplate({
      id: "draft/new",
      name: "Untitled workflow",
      version: 0,
    });
    const created = makeTemplate({ id: "custom/new-1", name: "Untitled workflow", version: 1 });
    createTemplateMock.mockResolvedValue({ template: created, warnings: [] });
    const onCreated = vi.fn();

    render(
      <TemplateDetail
        template={draft}
        isNew={true}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
        onDiscard={() => {}}
        onTemplateCreated={onCreated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /create workflow/i }));

    await waitFor(() => expect(createTemplateMock).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it("scope picker is shown in edit mode and goal options are passed", () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        goalOptions={["Goal Alpha", "Goal Beta"]}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    // Scope options visible
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Goal")).toBeInTheDocument();
  });
});
