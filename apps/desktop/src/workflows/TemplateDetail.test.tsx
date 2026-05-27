import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "@orca/contracts";
import { TemplateDetail } from "./TemplateDetail";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const duplicateTemplateMock = vi.fn();
const saveTemplateMock = vi.fn();

vi.mock("./api", () => ({
  duplicateTemplate: (...args: unknown[]) => duplicateTemplateMock(...args),
  saveTemplate: (...args: unknown[]) => saveTemplateMock(...args),
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
      },
      {
        id: "step-2",
        ordinal: 1,
        name: "Build",
        instructions: "Implement the solution based on research.",
        outputSchema: [
          { key: "result", type: "string", required: true },
        ],
      },
    ],
    guardrails: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("TemplateDetail", () => {
  beforeEach(() => {
    duplicateTemplateMock.mockReset();
    saveTemplateMock.mockReset();
  });

  it("disables editing for locked templates", () => {
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

    expect(screen.getByLabelText("Template Name")).toBeDisabled();
    expect(screen.getByLabelText("Description")).toBeDisabled();
    expect(screen.getByLabelText("Step 1 Name")).toBeDisabled();
  });

  it("saves custom step edits through the typed API wrapper and supports add/remove/reorder", async () => {
    const template = makeTemplate();
    saveTemplateMock.mockResolvedValue({
      ...template,
      version: 2,
    });

    const { container } = render(
      <TemplateDetail
        template={template}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Step" }));
    let stepCards = Array.from(
      container.querySelectorAll(".workflow-step-card"),
    ) as HTMLElement[];
    const addedStepCard = stepCards[2];
    if (!addedStepCard) throw new Error("added step card missing");

    fireEvent.change(within(addedStepCard).getByLabelText("Step 3 Name"), {
      target: { value: "QA" },
    });
    fireEvent.click(within(addedStepCard).getByRole("button", { name: "Move Up" }));

    stepCards = Array.from(container.querySelectorAll(".workflow-step-card")) as HTMLElement[];
    fireEvent.click(within(stepCards[2]).getByRole("button", { name: "Remove Step" }));

    // Edit the instructions of the first step
    const firstStepCard = (Array.from(container.querySelectorAll(".workflow-step-card")) as HTMLElement[])[0];
    fireEvent.change(within(firstStepCard).getByLabelText("Instructions"), {
      target: { value: "Updated instructions for research step." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    expect(saveTemplateMock).toHaveBeenCalledWith(
      "custom/template-1",
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: "step-1",
            instructions: "Updated instructions for research step.",
          }),
          expect.objectContaining({
            id: "step-3",
            name: "QA",
          }),
        ],
      }),
    );
  });

  it("renders output schema fields for each step", () => {
    render(
      <TemplateDetail
        template={makeTemplate()}
        onTemplateSaved={() => {}}
        onTemplateDuplicated={() => {}}
      />,
    );

    // The first step has 2 schema fields; confirm the key inputs are present
    const keyInputs = screen.getAllByPlaceholderText("key");
    expect(keyInputs.length).toBeGreaterThanOrEqual(2);
  });
});
