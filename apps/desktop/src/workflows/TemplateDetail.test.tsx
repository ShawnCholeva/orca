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
        purpose: "Inspect code.",
        requiredInputs: ["goal_brief"],
        requiredOutputs: ["research_summary"],
        gateType: "human-approval",
        recommendedCapabilities: ["analysis"],
        validationExpectations: [],
        exitCriteria: ["files identified"],
        recommendedOperatorIds: ["human"],
      },
      {
        id: "step-2",
        ordinal: 1,
        name: "Build",
        purpose: "Implement code.",
        requiredInputs: ["research_summary"],
        requiredOutputs: ["implementation_result"],
        gateType: "human-approval",
        recommendedCapabilities: ["coding"],
        validationExpectations: ["run unit tests"],
        exitCriteria: ["code merged"],
        recommendedOperatorIds: ["agent:codex"],
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

    const firstStepCard = (Array.from(container.querySelectorAll(".workflow-step-card")) as HTMLElement[])[0];
    const outputsFieldset = within(firstStepCard).getByText("Required Outputs").closest("fieldset") as HTMLElement;
    fireEvent.click(within(outputsFieldset).getByLabelText("qa_report"));

    const validationSection = within(firstStepCard).getByText("Validation Expectations").closest(".workflow-array-field") as HTMLElement;
    fireEvent.click(within(validationSection).getByRole("button", { name: "Add Validation Expectation" }));
    fireEvent.change(within(validationSection).getByRole("textbox"), {
      target: { value: "run smoke tests" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(saveTemplateMock).toHaveBeenCalledTimes(1));
    expect(saveTemplateMock).toHaveBeenCalledWith(
      "custom/template-1",
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: "step-1",
            requiredOutputs: expect.arrayContaining(["research_summary", "qa_report"]),
            validationExpectations: ["run smoke tests"],
          }),
          expect.objectContaining({
            id: "step-3",
            name: "QA",
          }),
        ],
      }),
    );
  });
});
