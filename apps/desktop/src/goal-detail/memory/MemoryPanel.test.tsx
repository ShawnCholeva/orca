import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { GoalMemoryItem, GoalMemoryType, GoalMemoryStatus } from "@orca/contracts";
import type { MemorySaveData } from "./MemoryEditModal";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeMemoryItem(overrides: Partial<GoalMemoryItem> = {}): GoalMemoryItem {
  return {
    id: "mem-1",
    goalId: "goal-1",
    type: "note" as GoalMemoryType,
    status: "candidate" as GoalMemoryStatus,
    content: "Test memory content",
    contentHash: "abc123",
    confidence: null,
    sourceType: "manual",
    sourceId: null,
    sourceSessionId: null,
    sourceExtractionId: null,
    sourceOffsetFirst: null,
    sourceOffsetLast: null,
    createdAt: now,
    updatedAt: now,
    promotedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listGoalMemory: vi.fn().mockResolvedValue([]),
    createGoalMemory: vi.fn().mockResolvedValue(makeMemoryItem()),
    patchMemoryItem: vi.fn().mockResolvedValue(makeMemoryItem()),
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

// Mock the modal so MemoryPanel tests don't depend on form internals.
// Exposes a "Save" button that calls onSave with fixed data, and a "Cancel" button.
function mockModal(saveData: MemorySaveData = { type: "note", content: "New item", status: "candidate" }) {
  vi.doMock("./MemoryEditModal", () => ({
    MemoryEditModal: ({
      onSave,
      onClose,
    }: {
      item: GoalMemoryItem | null;
      onSave: (data: MemorySaveData) => Promise<void>;
      onClose: () => void;
    }) => (
      <div className="memory-edit-modal">
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

describe("MemoryPanel", () => {
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

  it("renders empty state when no items", async () => {
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("No memory items yet.");
    expect(container.querySelector(".memory-item-list")).toBeNull();
  });

  it("renders memory items after load", async () => {
    const candidate = makeMemoryItem({ id: "mem-1", status: "candidate", content: "Candidate item" });
    const promoted = makeMemoryItem({
      id: "mem-2",
      status: "promoted",
      content: "Promoted item",
      promotedAt: now,
    });
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([candidate, promoted]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    const items = container.querySelectorAll(".memory-item");
    expect(items).toHaveLength(2);
    expect(container.textContent).toContain("Candidate item");
    expect(container.textContent).toContain("Promoted item");
  });

  it("shows promoted items before candidate items", async () => {
    const candidate = makeMemoryItem({ id: "mem-1", status: "candidate", content: "Candidate" });
    const promoted = makeMemoryItem({
      id: "mem-2",
      status: "promoted",
      content: "Promoted",
      promotedAt: now,
    });
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([candidate, promoted]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    const items = container.querySelectorAll(".memory-item");
    expect(items[0]?.classList.contains("memory-item--promoted")).toBe(true);
    expect(items[1]?.classList.contains("memory-item--candidate")).toBe(true);
  });

  it("shows error state and retry button on load failure", async () => {
    const listGoalMemory = vi.fn().mockRejectedValue(new Error("Network error"));
    mockApi({ listGoalMemory });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".memory-panel-error")).toBeTruthy();
    expect(container.textContent).toContain("Network error");
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();

    listGoalMemory.mockResolvedValue([]);
    await act(async () => {
      retryBtn?.click();
    });

    expect(listGoalMemory).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".memory-panel-error")).toBeNull();
    expect(container.textContent).toContain("No memory items yet.");
  });

  it("promotes a candidate item and reloads", async () => {
    const candidateItem = makeMemoryItem({ id: "mem-1", status: "candidate" });
    const promotedItem = makeMemoryItem({ id: "mem-1", status: "promoted", promotedAt: now });
    const listGoalMemory = vi
      .fn()
      .mockResolvedValueOnce([candidateItem])
      .mockResolvedValue([promotedItem]);
    const patchMemoryItem = vi.fn().mockResolvedValue(promotedItem);
    mockApi({ listGoalMemory, patchMemoryItem });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".memory-item--candidate")).toBeTruthy();
    const promoteBtn = container.querySelector<HTMLElement>(".memory-item-promote");
    expect(promoteBtn).toBeTruthy();

    await act(async () => {
      promoteBtn?.click();
    });

    expect(patchMemoryItem).toHaveBeenCalledWith("mem-1", { status: "promoted" });
    expect(container.querySelector(".memory-item--promoted")).toBeTruthy();
    expect(container.querySelector(".memory-item--candidate")).toBeNull();
  });

  it("archives a promoted item and hides it until toggle", async () => {
    const promotedItem = makeMemoryItem({ id: "mem-1", status: "promoted", promotedAt: now });
    const archivedItem = makeMemoryItem({ id: "mem-1", status: "archived", archivedAt: now });
    const listGoalMemory = vi
      .fn()
      .mockResolvedValueOnce([promotedItem])
      .mockResolvedValue([archivedItem]);
    const patchMemoryItem = vi.fn().mockResolvedValue(archivedItem);
    mockApi({ listGoalMemory, patchMemoryItem });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    const archiveBtn = container.querySelector<HTMLElement>(".memory-item-archive");
    expect(archiveBtn).toBeTruthy();

    await act(async () => {
      archiveBtn?.click();
    });

    expect(patchMemoryItem).toHaveBeenCalledWith("mem-1", { status: "archived" });
    // item hidden after archive
    expect(container.querySelector(".memory-item")).toBeNull();
    expect(container.textContent).toContain("No memory items yet.");

    // toggle reveals archived item
    const toggleBtn = container.querySelector<HTMLElement>(".memory-show-archived-toggle");
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn?.textContent).toContain("Show archived (1)");

    await act(async () => {
      toggleBtn?.click();
    });

    expect(container.querySelector(".memory-item--archived")).toBeTruthy();
    expect(
      container.querySelector<HTMLElement>(".memory-show-archived-toggle")?.textContent,
    ).toContain("Hide archived");
  });

  it("creates new memory via modal", async () => {
    const newItem = makeMemoryItem({ id: "mem-new", status: "candidate", content: "New item" });
    const listGoalMemory = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([newItem]);
    const createGoalMemory = vi.fn().mockResolvedValue(newItem);
    mockApi({ listGoalMemory, createGoalMemory });
    mockModal({ type: "note", content: "New item", status: "candidate" });
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("No memory items yet.");

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add Memory"),
    );
    await act(async () => {
      addBtn?.click();
    });

    expect(container.querySelector(".memory-edit-modal")).toBeTruthy();

    const saveBtn = container.querySelector<HTMLElement>(".modal-save-btn");
    await act(async () => {
      saveBtn?.click();
    });

    expect(createGoalMemory).toHaveBeenCalledWith(
      "goal-1",
      expect.objectContaining({ content: "New item" }),
    );
    expect(container.querySelector(".memory-edit-modal")).toBeNull();
    expect(container.querySelector(".memory-item")).toBeTruthy();
  });

  it("surfaces action error as non-blocking inline message", async () => {
    const item = makeMemoryItem({ id: "mem-1", status: "candidate" });
    const listGoalMemory = vi.fn().mockResolvedValue([item]);
    const patchMemoryItem = vi.fn().mockRejectedValue(new Error("Invalid transition"));
    mockApi({ listGoalMemory, patchMemoryItem });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    const promoteBtn = container.querySelector<HTMLElement>(".memory-item-promote");

    await act(async () => {
      promoteBtn?.click();
    });

    // error shown inline, panel still visible with items
    expect(container.querySelector(".memory-action-error")).toBeTruthy();
    expect(container.textContent).toContain("Invalid transition");
    expect(container.querySelector(".memory-item-list")).toBeTruthy();
  });

  it("closes modal on cancel without saving", async () => {
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add Memory"),
    );
    await act(async () => {
      addBtn?.click();
    });
    expect(container.querySelector(".memory-edit-modal")).toBeTruthy();

    const cancelBtn = container.querySelector<HTMLElement>(".modal-cancel-btn");
    await act(async () => {
      cancelBtn?.click();
    });
    expect(container.querySelector(".memory-edit-modal")).toBeNull();
  });

  it("shows source pointer for session-sourced items with offsets", async () => {
    const item = makeMemoryItem({
      id: "mem-1",
      sourceType: "session",
      sourceSessionId: "sess-abcdef12",
      sourceOffsetFirst: 100,
      sourceOffsetLast: 500,
    });
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([item]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("from session sess-abc");
    expect(container.textContent).toContain("bytes [100..500]");
  });

  it("shows 'source output unavailable' when session offsets are null", async () => {
    const item = makeMemoryItem({
      id: "mem-1",
      sourceType: "session",
      sourceSessionId: "sess-1",
      sourceOffsetFirst: null,
      sourceOffsetLast: null,
    });
    mockApi({ listGoalMemory: vi.fn().mockResolvedValue([item]) });
    mockModal();
    const { MemoryPanel } = await import("./MemoryPanel");

    await act(async () => {
      createRoot(container).render(<MemoryPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("source output unavailable");
  });
});

