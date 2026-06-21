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

  it("shows the closing summary when completed", () => {
    render(<AgentActivity activity={baseActivity({
      status: "completed", finalSummary: "Found the double-charge bug.",
      steps: [{ id: "1", text: "Read verifier.ts", category: "reading", status: "done", createdAt: "t" }],
    })} />);
    expect(screen.getByText("Found the double-charge bug.")).toBeTruthy();
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
});
