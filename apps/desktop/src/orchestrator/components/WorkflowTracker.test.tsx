import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowTracker } from "./WorkflowTracker";

const steps = [
  { name: "Plan It", role: "claude-code" },
  { name: "Build It", role: "codex" },
  { name: "Review It" },
];

describe("WorkflowTracker", () => {
  it("renders nothing when there are no steps", () => {
    const { container } = render(
      <WorkflowTracker workflowName="Engineering" steps={[]} activeIndex={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the workflow name, current step position, and active step name", () => {
    render(<WorkflowTracker workflowName="Engineering" steps={steps} activeIndex={1} />);

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    // Active step surfaces its role chip and the "running" indicator.
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("marks completed steps with a check and pending steps with their number", () => {
    render(<WorkflowTracker workflowName="Engineering" steps={steps} activeIndex={1} />);

    // Done step (index 0) renders a check, not its number.
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    // Pending step (index 2) still shows its number.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not pulse 'running' when the active step is not executing", () => {
    // A terminal step that has passed parks the run awaiting completion approval:
    // it is the current step but no longer running, so it must render done.
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={2}
        activeRunning={false}
      />,
    );

    expect(screen.queryByText("running")).toBeNull();
    // The final step is the current one but, being finished, shows no number
    // (it renders a check like the other done steps).
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("shows 'Completed' instead of a step position when completed", () => {
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={2}
        activeRunning={false}
        completed
      />,
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("running")).toBeNull();
  });

  it("calls onViewWorkflows when the view button is clicked", () => {
    const onViewWorkflows = vi.fn();
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={0}
        onViewWorkflows={onViewWorkflows}
      />,
    );

    screen.getByRole("button", { name: /view workflow/i }).click();
    expect(onViewWorkflows).toHaveBeenCalledTimes(1);
  });
});
