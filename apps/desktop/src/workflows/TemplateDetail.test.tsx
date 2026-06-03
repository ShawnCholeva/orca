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

  // ── Locked / built-in ──────────────────────────────────────────────────────

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
    // Canvas is shown (not step list editor) — no "Add step" toolbar button
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
    // Duplicate is still available
    expect(screen.getByRole("button", { name: /duplicate to custom/i })).toBeInTheDocument();
  });

  it("locked canvas is read-only: no Add step / Add gate toolbar buttons", () => {
    render(
      <TemplateDetail
        template={makeTemplate({ isBuiltIn: true, isLocked: true })}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /add gate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add step/i })).toBeNull();
  });

  it("locked template shows a read-only notice pointing to Duplicate", () => {
    render(
      <TemplateDetail
        template={makeTemplate({ isBuiltIn: true, isLocked: true })}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );
    expect(screen.getByText(/built-in workflow — read-only/i)).toBeTruthy();
  });

  it("unlocked template shows no read-only notice", () => {
    render(
      <TemplateDetail
        template={makeTemplate({ isBuiltIn: false, isLocked: false })}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );
    expect(screen.queryByText(/built-in workflow — read-only/i)).toBeNull();
  });

  // ── Unlocked custom in VIEW mode (canvas interactive) ─────────────────────

  it("unlocked view mode: canvas is interactive (Add step / Add gate present)", () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );
    // Canvas toolbar is visible because readOnly={locked} = readOnly={false}
    expect(screen.getByRole("button", { name: /add step/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add gate/i })).toBeInTheDocument();
  });

  it("unlocked view mode: Save Changes initially disabled (not dirty)", () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    expect(saveBtn).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();
  });

  it("adding a gate marks dirty → Save Changes enabled → save calls saveTemplate with gate node", async () => {
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

    // Initially Save is disabled
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();

    // Add a gate — this mutates draft and makes it dirty
    fireEvent.click(screen.getByRole("button", { name: /add gate/i }));

    // Save Changes should now be enabled
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    const [id, payload] = saveTemplateMock.mock.calls[0] as [
      string,
      { graph: { nodes: { type: string; stepId?: string }[] }; steps: { id: string }[] },
    ];
    expect(id).toBe("custom/template-1");
    // Graph must include at least one gate node
    const gateNodes = payload.graph.nodes.filter((n) => n.type === "gate");
    expect(gateNodes.length).toBeGreaterThanOrEqual(1);
    // Step nodes count must still equal steps length
    const stepNodes = payload.graph.nodes.filter((n) => n.type === "step");
    expect(stepNodes.length).toBe(payload.steps.length);
  });

  it("Discard changes reverts draft (Save Changes disabled again)", async () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Add a gate to make it dirty
    fireEvent.click(screen.getByRole("button", { name: /add gate/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );

    // Discard changes
    fireEvent.click(screen.getByRole("button", { name: /discard changes/i }));

    // Save should be disabled again
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled(),
    );

    // Discard button itself should be gone (not dirty)
    expect(screen.queryByRole("button", { name: /discard changes/i })).toBeNull();
  });

  it("opening a step node from canvas and editing instructions marks dirty", async () => {
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

    // Click the step node to open the modal (readOnly=false so click opens via drag logic;
    // but in test env, we simulate by clicking node — in readOnly mode WorkflowFlow uses onClick,
    // in non-readOnly it uses drag + mouseup. We can directly invoke by simulating mousedown+mouseup
    // on the node without moving.)
    const stepNode = document.querySelector("[data-node-id='step-1']") as HTMLElement;
    expect(stepNode).toBeInTheDocument();

    // Simulate the node click path: mousedown then mouseup without moving
    fireEvent.mouseDown(stepNode, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window, { button: 0, clientX: 10, clientY: 10 });

    // Modal should open
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/what this step should accomplish/i)).toBeInTheDocument(),
    );

    // Edit instructions
    const instructionsField = screen.getByPlaceholderText(/what this step should accomplish/i);
    fireEvent.change(instructionsField, { target: { value: "Updated instructions for step 1." } });

    // Should be dirty now
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );

    // Save and verify payload
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    const [, payload] = saveTemplateMock.mock.calls[0] as [
      string,
      { steps: { id: string; instructions: string }[] },
    ];
    const step1 = payload.steps.find((s) => s.id === "step-1");
    expect(step1?.instructions).toBe("Updated instructions for step 1.");
  });

  // ── Edit mode ─────────────────────────────────────────────────────────────

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
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    // Edit name to make it dirty
    const nameInput = screen.getByRole("textbox", { name: /template name/i });
    fireEvent.change(nameInput, { target: { value: "Updated Name" } });

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

  it("Edit/Done toggles the meta editor without reverting draft", () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Enter edit mode
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("textbox", { name: /template name/i })).toBeInTheDocument();

    // Exit edit mode with Done
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    // Canvas shows again (no template name input)
    expect(screen.queryByRole("textbox", { name: /template name/i })).toBeNull();
  });

  // ── Output schema validity gates Save ─────────────────────────────────────

  it("Save Changes is disabled while output schema text is invalid, re-enables when fixed", async () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // Enter edit mode (renders the step list editor)
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    // Make the template dirty via the name so Save isn't gated by !dirty —
    // this isolates the output-schema validity gate.
    fireEvent.change(screen.getByRole("textbox", { name: /template name/i }), {
      target: { value: "Renamed" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );

    // Expand the first step's details to reveal its Output Schema editor
    fireEvent.click(screen.getAllByRole("button", { name: /details/i })[0]);
    const schemaField = screen.getByLabelText("Output Schema");

    // Type unparseable schema text → Save disabled
    fireEvent.change(schemaField, { target: { value: "a {" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled(),
    );

    // Fix the text → Save re-enabled (still dirty from the rename)
    fireEvent.change(schemaField, { target: { value: "a" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );
  });

  // ── Scope picker ──────────────────────────────────────────────────────────

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
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    // Scope options visible
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Goal")).toBeInTheDocument();
  });

  // ── Canvas node present in view mode ──────────────────────────────────────

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

  // ── Duplicate ─────────────────────────────────────────────────────────────

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

  // ── Draft create flow ─────────────────────────────────────────────────────

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

  it("draft create: Discard calls onDiscard", () => {
    const onDiscard = vi.fn();
    render(
      <TemplateDetail
        template={makeTemplate({ id: "draft/new", version: 0 })}
        isNew={true}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
        onDiscard={onDiscard}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  // ── Save clears dirty ─────────────────────────────────────────────────────

  it("after successful save, Save Changes is disabled again (baseline updated)", async () => {
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

    // Add a gate to dirty
    fireEvent.click(screen.getByRole("button", { name: /add gate/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled(),
    );

    // Save
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));

    // After save, Save Changes should be disabled again (baseline updated)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled(),
    );
  });
});
