import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { type Conflict } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeConflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: "conflict-1",
    goalId: "goal-1",
    conflictType: "workspace_overlap",
    severity: "warning",
    status: "open",
    title: "Workspace overlap",
    description: "Two active tasks are targeting the same workspace.",
    sources: [
      { type: "workspace", id: "ws-1" },
      { type: "task", id: "task-1" },
    ],
    fingerprint: "conflict-fp-1",
    resolutionNote: null,
    detectedAt: now,
    resolvedAt: null,
    ...overrides,
  };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
    resolveConflict: vi.fn().mockResolvedValue({
      conflict: makeConflict({ status: "resolved", resolvedAt: now }),
    }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    ...overrides,
  }));
}

describe("ConflictsBanner", () => {
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

  it("stays hidden when there are no open conflicts", async () => {
    mockApi({
      listConflicts: vi.fn().mockResolvedValue({
        conflicts: [makeConflict({ id: "conflict-closed", status: "resolved", resolvedAt: now })],
      }),
    });
    const { ConflictsBanner } = await import("./ConflictsBanner");

    await act(async () => {
      createRoot(container).render(<ConflictsBanner goalId="goal-1" />);
    });

    expect(container.querySelector(".conflicts-banner")).toBeNull();
    expect(container.querySelector(".conflicts-drawer")).toBeNull();
  });

  it("shows the banner when at least one open conflict exists", async () => {
    mockApi({
      listConflicts: vi.fn().mockResolvedValue({
        conflicts: [makeConflict(), makeConflict({ id: "conflict-2", severity: "blocker" })],
      }),
    });
    const { ConflictsBanner } = await import("./ConflictsBanner");

    await act(async () => {
      createRoot(container).render(<ConflictsBanner goalId="goal-1" />);
    });

    expect(container.querySelector(".conflicts-banner")).toBeTruthy();
    expect(container.textContent).toContain("2 conflicts need review");
  });

  it("resolves a conflict, reloads the list, and hides when no open conflicts remain", async () => {
    const listConflicts = vi
      .fn()
      .mockResolvedValueOnce({ conflicts: [makeConflict()] })
      .mockResolvedValueOnce({ conflicts: [] });
    const resolveConflict = vi.fn().mockResolvedValue({
      conflict: makeConflict({
        status: "resolved",
        resolutionNote: "Handled manually",
        resolvedAt: now,
      }),
    });
    mockApi({ listConflicts, resolveConflict });
    const { ConflictsBanner } = await import("./ConflictsBanner");

    await act(async () => {
      createRoot(container).render(<ConflictsBanner goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".conflicts-banner")?.click();
    });

    expect(container.querySelector(".conflicts-drawer")).toBeTruthy();
    expect(container.textContent).toContain("linked recommendation");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".conflict-row-actions button")?.click();
    });

    const note = container.querySelector<HTMLTextAreaElement>("#conflict-note-conflict-1");
    await act(async () => {
      setControlValue(note!, "Handled manually");
    });

    const submit = container.querySelector<HTMLButtonElement>(
      ".conflict-resolve-dialog button[type='submit']",
    );
    await act(async () => {
      submit?.click();
    });

    expect(resolveConflict).toHaveBeenCalledWith("conflict-1", {
      resolution: "resolved",
      note: "Handled manually",
    });
    expect(listConflicts).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".conflicts-banner")).toBeNull();
    expect(container.querySelector(".conflicts-drawer")).toBeNull();
  });

  it("dismisses a conflict and reloads the list", async () => {
    const listConflicts = vi
      .fn()
      .mockResolvedValueOnce({ conflicts: [makeConflict()] })
      .mockResolvedValueOnce({ conflicts: [] });
    const resolveConflict = vi.fn().mockResolvedValue({
      conflict: makeConflict({
        status: "dismissed",
        resolutionNote: null,
        resolvedAt: now,
      }),
    });
    mockApi({ listConflicts, resolveConflict });
    const { ConflictsBanner } = await import("./ConflictsBanner");

    await act(async () => {
      createRoot(container).render(<ConflictsBanner goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".conflicts-banner")?.click();
    });

    const dismissButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".conflict-row-actions button"),
    ).find((button) => button.textContent === "Dismiss");

    await act(async () => {
      dismissButton?.click();
    });

    expect(resolveConflict).toHaveBeenCalledWith("conflict-1", {
      resolution: "dismissed",
    });
    expect(listConflicts).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".conflicts-banner")).toBeNull();
  });
});

function setControlValue(control: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
