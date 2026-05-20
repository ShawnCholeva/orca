import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GoalDecision, GoalDecisionStatus, DecisionSourceType } from "@orca/contracts";
import type { DecisionSaveData } from "./DecisionEditModal";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeDecision(overrides: Partial<GoalDecision> = {}): GoalDecision {
  return {
    id: "dec-1",
    goalId: "goal-1",
    title: "Use SQLite for storage",
    decisionText: "All state stored in SQLite",
    rationale: null,
    status: "proposed" as GoalDecisionStatus,
    confirmationRequired: false,
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

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listGoalDecisions: vi.fn().mockResolvedValue([]),
    createGoalDecision: vi.fn().mockResolvedValue(makeDecision()),
    patchDecision: vi.fn().mockResolvedValue(makeDecision()),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    ApiError: class ApiError extends Error {
      code: string | undefined;
      constructor(message: string, _cause?: unknown, code?: string) {
        super(message);
        this.name = "ApiError";
        this.code = code;
      }
    },
    ...overrides,
  }));
}

function mockModal(
  saveData: DecisionSaveData = {
    title: "New Decision",
    decisionText: "Decision text",
    rationale: "",
    status: "proposed",
    confirmationRequired: false,
  },
) {
  vi.doMock("./DecisionEditModal", () => ({
    DecisionEditModal: ({
      onSave,
      onClose,
    }: {
      item: GoalDecision | null;
      onSave: (data: DecisionSaveData) => Promise<void>;
      onClose: () => void;
    }) => (
      <div className="decision-edit-modal">
        <button
          type="button"
          className="modal-save-btn"
          onClick={() => void onSave(saveData)}
        >
          Save
        </button>
        <button type="button" className="modal-cancel-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    ),
  }));
}

describe("DecisionsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("renders empty state when no decisions", async () => {
    mockApi({ listGoalDecisions: vi.fn().mockResolvedValue([]) });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("No decisions yet.");
    expect(container.querySelector(".decision-item-list")).toBeNull();
  });

  it("renders decision items after load", async () => {
    const proposed = makeDecision({ id: "dec-1", title: "First decision" });
    const confirmed = makeDecision({ id: "dec-2", title: "Second decision", status: "confirmed", confirmedAt: now });
    mockApi({ listGoalDecisions: vi.fn().mockResolvedValue([proposed, confirmed]) });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    const items = container.querySelectorAll(".decision-item");
    expect(items).toHaveLength(2);
    expect(container.textContent).toContain("First decision");
    expect(container.textContent).toContain("Second decision");
  });

  it("confirms a proposed decision — moves to confirmed group", async () => {
    const proposedItem = makeDecision({ id: "dec-1", status: "proposed" });
    const confirmedItem = makeDecision({ id: "dec-1", status: "confirmed", confirmedAt: now });
    const listGoalDecisions = vi
      .fn()
      .mockResolvedValueOnce([proposedItem])
      .mockResolvedValue([confirmedItem]);
    const patchDecision = vi.fn().mockResolvedValue(confirmedItem);
    mockApi({ listGoalDecisions, patchDecision });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".decision-item--proposed")).toBeTruthy();
    const confirmBtn = container.querySelector<HTMLElement>(".decision-item-confirm");
    expect(confirmBtn).toBeTruthy();

    await act(async () => {
      confirmBtn?.click();
    });

    expect(patchDecision).toHaveBeenCalledWith("dec-1", { status: "confirmed" });
    expect(container.querySelector(".decision-item--confirmed")).toBeTruthy();
    expect(container.querySelector(".decision-item--proposed")).toBeNull();
  });

  it("archives proposed decision — hidden until toggle", async () => {
    const proposedItem = makeDecision({ id: "dec-1", status: "proposed" });
    const archivedItem = makeDecision({ id: "dec-1", status: "archived", archivedAt: now });
    const listGoalDecisions = vi
      .fn()
      .mockResolvedValueOnce([proposedItem])
      .mockResolvedValue([archivedItem]);
    const patchDecision = vi.fn().mockResolvedValue(archivedItem);
    mockApi({ listGoalDecisions, patchDecision });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    const archiveBtn = container.querySelector<HTMLElement>(".decision-item-archive");
    expect(archiveBtn).toBeTruthy();

    await act(async () => {
      archiveBtn?.click();
    });

    expect(patchDecision).toHaveBeenCalledWith("dec-1", { status: "archived" });
    expect(container.querySelector(".decision-item")).toBeNull();
    expect(container.textContent).toContain("No decisions yet.");

    const toggleBtn = container.querySelector<HTMLElement>(".decisions-show-archived-toggle");
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn?.textContent).toContain("Show archived (1)");

    await act(async () => {
      toggleBtn?.click();
    });

    expect(container.querySelector(".decision-item--archived")).toBeTruthy();
    expect(
      container.querySelector<HTMLElement>(".decisions-show-archived-toggle")?.textContent,
    ).toContain("Hide archived");
  });

  it("archives confirmed decision — hidden until toggle", async () => {
    const confirmedItem = makeDecision({ id: "dec-1", status: "confirmed", confirmedAt: now });
    const archivedItem = makeDecision({ id: "dec-1", status: "archived", archivedAt: now });
    const listGoalDecisions = vi
      .fn()
      .mockResolvedValueOnce([confirmedItem])
      .mockResolvedValue([archivedItem]);
    const patchDecision = vi.fn().mockResolvedValue(archivedItem);
    mockApi({ listGoalDecisions, patchDecision });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    const archiveBtn = container.querySelector<HTMLElement>(".decision-item-archive");
    expect(archiveBtn).toBeTruthy();

    await act(async () => {
      archiveBtn?.click();
    });

    expect(patchDecision).toHaveBeenCalledWith("dec-1", { status: "archived" });
    expect(container.querySelector(".decision-item--confirmed")).toBeNull();

    const toggleBtn = container.querySelector<HTMLElement>(".decisions-show-archived-toggle");
    await act(async () => {
      toggleBtn?.click();
    });

    expect(container.querySelector(".decision-item--archived")).toBeTruthy();
  });

  it("creates decision via modal", async () => {
    const newItem = makeDecision({ id: "dec-new", title: "New Decision" });
    const listGoalDecisions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([newItem]);
    const createGoalDecision = vi.fn().mockResolvedValue(newItem);
    mockApi({ listGoalDecisions, createGoalDecision });
    mockModal({ title: "New Decision", decisionText: "Decision text", rationale: "", status: "proposed", confirmationRequired: false });
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("No decisions yet.");

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add Decision"),
    );
    await act(async () => {
      addBtn?.click();
    });

    expect(container.querySelector(".decision-edit-modal")).toBeTruthy();

    const saveBtn = container.querySelector<HTMLElement>(".modal-save-btn");
    await act(async () => {
      saveBtn?.click();
    });

    expect(createGoalDecision).toHaveBeenCalledWith(
      "goal-1",
      expect.objectContaining({ title: "New Decision" }),
    );
    expect(container.querySelector(".decision-edit-modal")).toBeNull();
    expect(container.querySelector(".decision-item")).toBeTruthy();
  });

  it("shows confirmationRequired decision in 'needs confirmation' group even after edits that do not change status", async () => {
    const highImpact = makeDecision({
      id: "dec-1",
      status: "proposed",
      confirmationRequired: true,
      title: "High-impact decision",
    });
    const afterEdit = makeDecision({
      id: "dec-1",
      status: "proposed",
      confirmationRequired: true,
      title: "High-impact decision (edited)",
    });
    const listGoalDecisions = vi
      .fn()
      .mockResolvedValueOnce([highImpact])
      .mockResolvedValue([afterEdit]);
    const patchDecision = vi.fn().mockResolvedValue(afterEdit);
    mockApi({ listGoalDecisions, patchDecision });
    mockModal({
      title: "High-impact decision (edited)",
      decisionText: "All state stored in SQLite",
      rationale: "",
      status: "proposed",
      confirmationRequired: true,
    });
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".decisions-group--needs-confirmation")).toBeTruthy();
    expect(container.textContent).toContain("Needs Confirmation");

    const editBtn = container.querySelector<HTMLElement>(".decision-item-edit");
    await act(async () => {
      editBtn?.click();
    });

    const saveBtn = container.querySelector<HTMLElement>(".modal-save-btn");
    await act(async () => {
      saveBtn?.click();
    });

    // still in needs-confirmation group after edit
    expect(container.querySelector(".decisions-group--needs-confirmation")).toBeTruthy();
    expect(container.textContent).toContain("Needs Confirmation");
    expect(container.textContent).toContain("High-impact decision (edited)");
  });

  it("shows error state and retry button on load failure", async () => {
    const listGoalDecisions = vi.fn().mockRejectedValue(new Error("Network error"));
    mockApi({ listGoalDecisions });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".decisions-panel-error")).toBeTruthy();
    expect(container.textContent).toContain("Network error");
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();

    listGoalDecisions.mockResolvedValue([]);
    await act(async () => {
      retryBtn?.click();
    });

    expect(listGoalDecisions).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".decisions-panel-error")).toBeNull();
    expect(container.textContent).toContain("No decisions yet.");
  });

  it("invalid action surfaces non-blocking inline error", async () => {
    const item = makeDecision({ id: "dec-1", status: "proposed" });
    const listGoalDecisions = vi.fn().mockResolvedValue([item]);
    const patchDecision = vi.fn().mockRejectedValue(new Error("Invalid transition"));
    mockApi({ listGoalDecisions, patchDecision });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    const archiveBtn = container.querySelector<HTMLElement>(".decision-item-archive");

    await act(async () => {
      archiveBtn?.click();
    });

    expect(container.querySelector(".decisions-action-error")).toBeTruthy();
    expect(container.textContent).toContain("Invalid transition");
    expect(container.querySelector(".decision-item-list")).toBeTruthy();
  });

  it("places needs-confirmation group before proposed group", async () => {
    const highImpact = makeDecision({
      id: "dec-1",
      status: "proposed",
      confirmationRequired: true,
      title: "High Impact",
    });
    const normal = makeDecision({
      id: "dec-2",
      status: "proposed",
      confirmationRequired: false,
      title: "Normal Proposed",
    });
    mockApi({ listGoalDecisions: vi.fn().mockResolvedValue([highImpact, normal]) });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    const groups = container.querySelectorAll(".decisions-group");
    expect(groups[0]?.classList.contains("decisions-group--needs-confirmation")).toBe(true);
    expect(groups[1]?.classList.contains("decisions-group--proposed")).toBe(true);
  });

  it("confirmed decisions have no confirm button", async () => {
    const confirmed = makeDecision({ id: "dec-1", status: "confirmed", confirmedAt: now });
    mockApi({ listGoalDecisions: vi.fn().mockResolvedValue([confirmed]) });
    mockModal();
    const { DecisionsPanel } = await import("./DecisionsPanel");

    await act(async () => {
      createRoot(container).render(<DecisionsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".decision-item-confirm")).toBeNull();
    expect(container.querySelector(".decision-item-archive")).toBeTruthy();
  });
});
