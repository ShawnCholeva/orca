import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Activity } from "@orca/contracts";
import { AgentActivity, CodeChangeCard } from "./AgentActivity";

const baseActivity = (over: Partial<Activity>): Activity => ({
  id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
  turnOrdinal: 0, status: "active", currentText: "", finalSummary: null,
  sourceKind: "tool_use", workCategory: null, confidence: null, stepName: "Root Cause",
  steps: [], createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z",
  completedAt: null, ...over,
});

describe("AgentActivity", () => {
  it("renders done steps with a check and the active step as a pulse", () => {
    render(<AgentActivity activity={baseActivity({
      steps: [
        { id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" },
        { id: "2", text: "Ran tests: pnpm test", category: "testing", status: "active", createdAt: "t" },
      ],
    })} />);
    expect(screen.getByText("Read verifier.ts")).toBeTruthy();
    expect(screen.getByTestId("agent-activity-active").textContent).toContain("Ran tests: pnpm test");
  });

  it("keeps pulsing between tool calls, when no step is active but the turn is live", () => {
    // The dead window: every row checked, the turn still running, and nothing on
    // screen saying so. OrcaChat's fallback row cannot cover this either — it is
    // suppressed precisely because this activity is active.
    render(<AgentActivity activity={baseActivity({
      status: "active",
      steps: [{ id: "1", text: "Edited .gitignore", category: "editing", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.getByTestId("agent-activity-active").textContent).toContain("Working…");
  });

  it("does not repeat the step name on the live line when rows already sit under that header", () => {
    render(<AgentActivity activity={baseActivity({
      status: "active", stepName: "Root Cause",
      steps: [{ id: "1", text: "Edited .gitignore", category: "editing", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.getByTestId("agent-activity-active").textContent).not.toContain("Root Cause");
  });

  it("still names the step on the live line for a turn that has produced nothing yet", () => {
    render(<AgentActivity activity={baseActivity({ status: "active", stepName: "Root Cause", steps: [] })} />);
    expect(screen.getByTestId("agent-activity-active").textContent).toContain("Root Cause");
  });

  it("gives no pulse to a segment that does not own the tail", () => {
    render(<AgentActivity showTail={false} activity={baseActivity({
      status: "active",
      steps: [{ id: "1", text: "Edited .gitignore", category: "editing", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  it("renders nothing for a segment with no header, no rows and no tail", () => {
    const { container } = render(
      <AgentActivity showHead={false} showTail={false} activity={baseActivity({ status: "active", steps: [] })} />
    );
    expect(container.querySelector(".agent-activity")).toBeNull();
  });

  it("shows the closing summary when completed", () => {
    render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Found the double-charge bug.",
      steps: [{ id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.getByText("Found the double-charge bug.")).toBeTruthy();
  });

  it("drops the summary's top divider when there are no steps above it (no floating divider)", () => {
    const { container } = render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Approving with scoring.", stepName: undefined, steps: [],
    })} />);
    const summary = container.querySelector(".agent-activity-summary");
    expect(summary).not.toBeNull();
    expect(summary!.className).toContain("agent-activity-summary--flush");
  });

  it("keeps the summary divider when there are steps above it", () => {
    const { container } = render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Done.",
      steps: [{ id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" }],
    })} />);
    const summary = container.querySelector(".agent-activity-summary");
    expect(summary!.className).not.toContain("agent-activity-summary--flush");
  });

  it("renders a cut-short step as interrupted (paused), not a check, when the activity finished while still active", () => {
    render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Interrupted — send a correction to resume.",
      steps: [
        { id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" },
        { id: "2", text: "Editing file", category: "editing", status: "active", createdAt: "t" },
      ],
    })} />);
    const interrupted = screen.getByTestId("agent-activity-interrupted");
    expect(interrupted.textContent).toContain("Editing file");
    // The cut step must NOT pulse and must NOT be rendered as a running/active row.
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  it("renders the active step as interrupted (no pulse) when the run halted, even on an active activity", () => {
    render(<AgentActivity tail="halted" activity={baseActivity({
      status: "active",
      steps: [
        { id: "1", text: "Read App.tsx", category: "reading", status: "done", createdAt: "t" },
        { id: "2", text: "Working on the step...", category: "other", status: "active", createdAt: "t" },
      ],
    })} />);
    expect(screen.getByTestId("agent-activity-interrupted").textContent).toContain("Working on the step...");
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  // A settled tail is the orchestrator-review window: the worker's turn ENDED
  // (that is what triggered the review), so its last tool call is finished. It
  // must read as done, never as a pause — a pause claims the work was halted,
  // and the daemon flips the very same step to a check moments later.
  it("renders the active step as done (check), not paused, when the turn settled for review", () => {
    render(<AgentActivity tail="settled" activity={baseActivity({
      status: "active",
      steps: [
        { id: "1", text: "Read App.tsx", category: "reading", status: "done", createdAt: "t" },
        { id: "2", text: "Ran the migration", category: "other", status: "active", createdAt: "t" },
      ],
    })} />);
    const done = screen.getAllByTestId("agent-activity-done");
    expect(done.map((row) => row.textContent)).toContain("Ran the migration");
    expect(screen.queryByTestId("agent-activity-interrupted")).toBeNull();
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  it("shows no live pulse on a settled step-less activity (review is not the worker working)", () => {
    render(<AgentActivity tail="settled" activity={baseActivity({ status: "active", steps: [] })} />);
    expect(screen.queryByTestId("agent-activity-active")).toBeNull();
  });

  it("no longer renders diffs inside the activity card (they are external cards now)", () => {
    render(<AgentActivity activity={baseActivity({
      steps: [{ id: "1", text: "Edited verifier.ts", category: "editing", status: "done", createdAt: "t",
        diff: { filePath: "verifier.ts", additions: 1, deletions: 1, hunks: [{ oldStart: 42, newStart: 42,
          lines: [{ kind: "remove", text: "old()" }, { kind: "add", text: "new()" }] }] } }] as never,
    })} />);
    expect(screen.getByText("Edited verifier.ts")).toBeTruthy();
    expect(screen.queryByTestId("agent-activity-diff-toggle")).toBeNull();
    expect(screen.queryByTestId("code-change-card")).toBeNull();
  });
});

it("renders a completed card's summary with all steps always expanded (no toggle)", () => {
  const completed = {
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
    turnOrdinal: 0, status: "completed", currentText: "", finalSummary: "Did the thing",
    sourceKind: "turn_completed", workCategory: null, confidence: null,
    createdAt: "t", updatedAt: "t", completedAt: "t",
    steps: [
      { id: "st1", text: "edited a.ts", category: "editing", status: "done", createdAt: "t" },
      { id: "st2", text: "ran tests", category: "running", status: "done", createdAt: "t" },
    ],
  };
  render(<AgentActivity activity={completed as any} />);
  expect(screen.getByText("Did the thing")).toBeInTheDocument();
  expect(screen.getByText("edited a.ts")).toBeInTheDocument(); // always expanded
  expect(screen.getByText("ran tests")).toBeInTheDocument();
  expect(screen.queryByTestId("agent-activity-toggle")).toBeNull(); // no collapse button
});

describe("CodeChangeCard", () => {
  it("renders the file, stats, caption, and diff lines pre-expanded", () => {
    render(
      <CodeChangeCard
        caption="Edited verifier.ts"
        diff={{
          filePath: "verifier.ts",
          additions: 1,
          deletions: 1,
          hunks: [{ oldStart: 42, newStart: 42, lines: [
            { kind: "remove", text: "old()" },
            { kind: "add", text: "new()" },
          ] }],
        }}
      />,
    );
    const card = screen.getByTestId("code-change-card");
    expect(card).toHaveTextContent("verifier.ts");
    expect(card).toHaveTextContent("Edited verifier.ts");
    // diff body is shown without any toggle
    expect(screen.getByText("old()")).toBeTruthy();
    expect(screen.getByText("new()")).toBeTruthy();
  });

  it("renders a finished generic step in the past tense, never as work in progress", () => {
    // "✓ Working on the step..." on an ended turn described something not happening.
    render(
      <AgentActivity
        tail="settled"
        activity={baseActivity({
          status: "expired",
          steps: [
            { id: "1", text: "Working on the step...", category: "other", status: "done", createdAt: "t" },
            { id: "2", text: "Ran npm test", category: "testing", status: "done", createdAt: "t" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Worked on the step")).toBeInTheDocument();
    expect(screen.queryByText("Working on the step...")).toBeNull();
    // A tool's own past-tense narration is left alone.
    expect(screen.getByText("Ran npm test")).toBeInTheDocument();
  });
});
