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

  it("surfaces 'awaiting approval' for a parked terminal step instead of a finished check", () => {
    // The terminal step has passed its work but the run is parked "active"
    // awaiting completion approval (the complete_workflow_run recommendation is
    // still proposed). This is NOT the same as a genuinely completed run: the
    // tracker must communicate that approval is still required rather than
    // rendering the step as a finished green check, which reads as "done" and is
    // exactly why the user thought the goal had completed.
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={2}
        activeRunning={false}
        awaitingApproval
      />,
    );

    // Surfaces an awaiting-approval indicator.
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
    // Must not pulse running, and must not read as fully completed.
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("renders an 'approve to complete' affordance and calls onApprove when awaiting approval", () => {
    const onApprove = vi.fn();
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={2}
        activeRunning={false}
        awaitingApproval
        onApprove={onApprove}
      />,
    );

    const button = screen.getByRole("button", { name: /approve to complete/i });
    button.click();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("does not render the approve affordance unless awaiting approval", () => {
    const onApprove = vi.fn();
    render(
      <WorkflowTracker
        workflowName="Engineering"
        steps={steps}
        activeIndex={1}
        onApprove={onApprove}
      />,
    );

    expect(screen.queryByRole("button", { name: /approve to complete/i })).toBeNull();
  });

  it("marks the gate's source step 'awaiting gate' when parked at a gate (not 'approval', no inline buttons)", () => {
    render(
      <WorkflowTracker
        workflowName="Bug Triage & Fix"
        steps={steps}
        activeIndex={2}
        activeRunning={false}
        awaitingGate
      />,
    );

    // A gate park is anchored to its (finished) source step; the label says the
    // GATE is awaiting a decision — not that this done step needs approval.
    expect(screen.getByText(/awaiting gate/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
    // The approve/reject action lives in the chat thread, not the tracker.
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^reject$/i })).toBeNull();
  });

  it("renders a gate as its own node (with a 'gate' label) and counts steps only in the header", () => {
    const withGate = [
      { name: "Proposal", role: "claude-code", kind: "step" as const },
      { name: "Critique", kind: "gate" as const },
      { name: "Apply", kind: "step" as const },
    ];
    render(<WorkflowTracker workflowName="Bug Triage & Fix" steps={withGate} activeIndex={0} />);

    // The gate appears as its own node with its name and a 'gate' descriptor.
    expect(screen.getByText("Critique")).toBeInTheDocument();
    expect(screen.getByText("gate")).toBeInTheDocument();
    // The header counts steps only — the gate is not "Step N".
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  });

  it("parks 'awaiting gate' on the gate node itself, not the preceding step", () => {
    const withGate = [
      { name: "Proposal", kind: "step" as const },
      { name: "Critique", kind: "gate" as const },
      { name: "Apply", kind: "step" as const },
    ];
    render(
      <WorkflowTracker
        workflowName="Bug Triage & Fix"
        steps={withGate}
        activeIndex={1}
        activeRunning={false}
        awaitingGate
      />,
    );

    expect(screen.getByText(/awaiting gate/i)).toBeInTheDocument();
    // Parked at the gate after step 1 → header still reads the source step.
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
    // The preceding step (index 0) rendered its completed check, not an awaiting badge.
    expect(screen.getAllByTestId("tracker-done-check")).toHaveLength(1);
  });

  it("marks a step parked for Continue/Revise 'awaiting confirmation', not 'running'", () => {
    render(
      <WorkflowTracker
        workflowName="Adaptive Delivery"
        steps={steps}
        activeIndex={0}
        activeRunning={false}
        awaitingConfirm
      />,
    );

    // A step whose work is done but is parked for the human to Continue must read
    // as awaiting the human — never as a live "running" spinner over stopped work.
    expect(screen.getByText(/awaiting confirmation/i)).toBeInTheDocument();
    expect(screen.queryByText("running")).toBeNull();
    // The Continue/Revise action lives in the chat thread, not the tracker.
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("marks routed-past steps 'skipped' rather than showing them as completed", () => {
    render(
      <WorkflowTracker
        workflowName="Adaptive Delivery"
        steps={steps}
        activeIndex={2}
        skippedIndices={[1]}
      />,
    );

    // The skipped step is labelled 'skipped' and is NOT one of the completed checks.
    expect(screen.getByText(/skipped/i)).toBeInTheDocument();
    // Step 0 ran (done check), step 2 is active; only ONE check (step 0), not two —
    // the skipped step 1 must not render a completed checkmark.
    expect(screen.getAllByTestId("tracker-done-check")).toHaveLength(1);
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
