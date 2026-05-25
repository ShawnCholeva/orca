import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        purpose: "Clarify work.",
        requiredInputs: [],
        requiredOutputs: ["goal_brief"],
        gateType: "human-input",
        recommendedCapabilities: [],
        validationExpectations: [],
        exitCriteria: ["goal brief captured"],
        recommendedOperatorIds: [],
      },
    ],
    guardrails: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("WorkflowsPage", () => {
  beforeEach(() => {
    createTemplateMock.mockReset();
    duplicateTemplateMock.mockReset();
    listTemplatesMock.mockReset();
    saveTemplateMock.mockReset();
  });

  it("renders an empty state when there are no templates", async () => {
    listTemplatesMock.mockResolvedValue({ templates: [] });

    render(<WorkflowsPage />);

    expect(await screen.findByText("No workflow templates available yet.")).toBeInTheDocument();
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
    duplicateTemplateMock.mockResolvedValue(copy);

    render(<WorkflowsPage />);

    await screen.findByRole("heading", { name: "Engineering" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate to Custom" }));

    await waitFor(() => expect(duplicateTemplateMock).toHaveBeenCalledWith("orca/engineering", "Engineering Copy"));
    expect(await screen.findByText("Custom Workflows")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Engineering Copy" })).toBeInTheDocument();
  });
});
