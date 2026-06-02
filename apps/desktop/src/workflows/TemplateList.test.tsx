import { fireEvent, render, screen } from "@testing-library/react";
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

describe("TemplateList", () => {
  it("shows a lock badge for locked templates", () => {
    render(
      <TemplateList
        templates={[makeTemplate()]}
        selectedId="orca/engineering"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("locked")).toBeInTheDocument();
  });

  it("shows a scope badge for each template", () => {
    render(
      <TemplateList
        templates={[makeTemplate({ scope: "global" })]}
        selectedId="orca/engineering"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("global")).toBeInTheDocument();
  });

  it("shows step count", () => {
    render(
      <TemplateList
        templates={[makeTemplate()]}
        selectedId="orca/engineering"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  it("shows draft badge for the draftId template", () => {
    render(
      <TemplateList
        templates={[makeTemplate({ id: "draft/new", name: "Untitled workflow" })]}
        selectedId="draft/new"
        onSelect={() => {}}
        draftId="draft/new"
      />,
    );
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("calls onSelect when a template row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <TemplateList
        templates={[makeTemplate()]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("Engineering"));
    expect(onSelect).toHaveBeenCalledWith("orca/engineering");
  });
});
