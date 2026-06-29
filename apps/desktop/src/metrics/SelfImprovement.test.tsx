import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getWorkflowMetrics } from "./metrics-data";
import { SelfImprovementRail } from "./SelfImprovement";

const wf = getWorkflowMetrics()[0]; // Brainstorm — has proposals + degraded step

describe("SelfImprovementRail", () => {
  it("renders an improvement card per step with a proposal", () => {
    render(<SelfImprovementRail wf={wf} />);
    expect(screen.getByText("Inject failed-constraint feedback into the retry prompt")).toBeInTheDocument();
    expect(screen.getByText("Require per-constraint evidence and cap retries at 2")).toBeInTheDocument();
  });

  it("opens the proposal modal with before/after when Review is clicked", () => {
    render(<SelfImprovementRail wf={wf} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]);
    expect(screen.getByText("Current instruction")).toBeInTheDocument();
    expect(screen.getByText("Orca proposes")).toBeInTheDocument();
  });

  it("renders the learning log timeline", () => {
    render(<SelfImprovementRail wf={wf} />);
    expect(screen.getByText(/duplicate writes/)).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
  });
});
