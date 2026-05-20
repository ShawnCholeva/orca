import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { DecisionSourceType, GoalDecision, GoalDecisionStatus } from "@orca/contracts";
import { DecisionEditModal } from "./DecisionEditModal";

const now = "2026-01-01T00:00:00.000Z";

function makeDecision(overrides: Partial<GoalDecision> = {}): GoalDecision {
  return {
    id: "dec-1",
    goalId: "goal-1",
    title: "Use SQLite for storage",
    decisionText: "All state stored in SQLite",
    rationale: null,
    status: "proposed" as GoalDecisionStatus,
    confirmationRequired: true,
    confidence: null,
    sourceType: "manual" as DecisionSourceType,
    sourceId: null,
    sourceSessionId: null,
    sourceExtractionId: null,
    sourceOffsetFirst: null,
    sourceOffsetLast: null,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("DecisionEditModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it("shows confirmation required control when creating a decision", async () => {
    await act(async () => {
      root.render(
        <DecisionEditModal item={null} onSave={vi.fn()} onClose={vi.fn()} />
      );
    });

    expect(container.textContent).toContain("Requires confirmation");
    expect(container.querySelector<HTMLInputElement>("input[type='checkbox']")).toBeTruthy();
  });

  it("does not show confirmation required control when editing a decision", async () => {
    await act(async () => {
      root.render(
        <DecisionEditModal item={makeDecision()} onSave={vi.fn()} onClose={vi.fn()} />
      );
    });

    expect(container.textContent).not.toContain("Requires confirmation");
    expect(container.querySelector<HTMLInputElement>("input[type='checkbox']")).toBeNull();
  });
});
