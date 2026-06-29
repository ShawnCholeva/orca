import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getWorkflowMetrics } from "./metrics-data";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";

const wfs = getWorkflowMetrics();

describe("StepPerformancePanel", () => {
  it("lists every step name for the workflow", () => {
    render(<StepPerformancePanel wf={wfs[0]} openStep={null} onToggleStep={() => {}} />);
    for (const s of wfs[0].steps) {
      expect(screen.getByText(s.name)).toBeInTheDocument();
    }
  });

  it("shows failure modes and the insight only for the open step", () => {
    const verify = wfs[0].steps.find((s) => s.name === "Verify Proposal")!;
    render(<StepPerformancePanel wf={wfs[0]} openStep="Verify Proposal" onToggleStep={() => {}} />);
    expect(screen.getByText(verify.failures[0].label)).toBeInTheDocument();
    expect(screen.getByText(verify.insight)).toBeInTheDocument();
  });

  it("fires onToggleStep with the clicked step name", () => {
    const onToggle = vi.fn();
    render(<StepPerformancePanel wf={wfs[0]} openStep={null} onToggleStep={onToggle} />);
    fireEvent.click(screen.getByText("Define Intent"));
    expect(onToggle).toHaveBeenCalledWith("Define Intent");
  });
});

describe("WorkflowDropdown", () => {
  it("opens the menu and selects another workflow", () => {
    const onChange = vi.fn();
    render(<WorkflowDropdown workflows={wfs} value={wfs[0].id} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Brainstorm/ }));
    fireEvent.click(screen.getByText("Review gate"));
    expect(onChange).toHaveBeenCalledWith("wf-review");
  });
});
