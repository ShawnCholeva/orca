import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@orca/contracts";

// The terminal is exercised by SessionTerminalView's own tests; here it only
// needs to prove the view hands it the right session.
vi.mock("../../goal-detail/sessions/SessionTerminalView", () => ({
  SessionTerminalView: ({ sessionId, status, pane }: { sessionId: string; status: string; pane?: unknown }) => (
    <div data-testid="terminal" data-session={sessionId} data-status={status} data-pane={JSON.stringify(pane)} />
  ),
}));

const { StepSessionView } = await import("./StepSessionView");

const session: SessionSummary = {
  id: "sess-1",
  goalId: "goal-1",
  workspaceId: "ws-1",
  adapterId: "claude-code",
  workflowStepRunId: "step-1",
  role: "engineer",
  title: "Workflow step: step-1",
  status: "running",
  paneFixed: true,
  terminalCols: 220,
  terminalRows: 50,
  createdAt: "2026-09-08T10:00:00.000Z",
  startedAt: "2026-09-08T10:00:01.000Z",
  exitedAt: null,
};

describe("StepSessionView", () => {
  it("names the step, its agent and its status, and mounts that session's terminal", () => {
    render(<StepSessionView session={session} stepName="Build It" onBack={vi.fn()} />);

    expect(screen.getByText("Build It")).toBeInTheDocument();
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-session", "sess-1");
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-status", "running");
  });

  it("hands the terminal the pane's grid, so it is built at the right size", () => {
    // The tracker already knows the geometry; passing it in leaves no window in
    // which output could be written to a terminal of the wrong width.
    render(<StepSessionView session={session} stepName="Build It" onBack={vi.fn()} />);

    expect(screen.getByTestId("terminal")).toHaveAttribute("data-pane", '{"cols":220,"rows":50}');
  });

  it("lets a session the daemon does not size fall back to the viewer's own", () => {
    render(
      <StepSessionView
        session={{ ...session, paneFixed: false }}
        stepName="Build It"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("terminal")).toHaveAttribute("data-pane", "null");
  });

  it("goes back on request", () => {
    const onBack = vi.fn();
    render(<StepSessionView session={session} stepName="Build It" onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: /Back to orchestrator/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("still opens a session that has ended, so its transcript stays readable", () => {
    render(
      <StepSessionView
        session={{ ...session, status: "exited" }}
        stepName="Build It"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("terminal")).toHaveAttribute("data-status", "exited");
    expect(screen.getByText("exited")).toBeInTheDocument();
  });
});
