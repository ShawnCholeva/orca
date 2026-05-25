import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "@orca/contracts";
import { TemplateList } from "./TemplateList";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
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

describe("TemplateList", () => {
  it("shows a lock badge for built-in templates", () => {
    render(
      <TemplateList
        templates={[makeTemplate()]}
        selectedId="orca/engineering"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("Locked")).toBeInTheDocument();
  });
});
