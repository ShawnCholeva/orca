import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { SessionMemorySummary } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeSummary(overrides: Partial<SessionMemorySummary> = {}): SessionMemorySummary {
  return {
    id: "sum-1",
    sessionId: "sess-1",
    goalId: "goal-1",
    extractionId: "ext-1",
    headline: "Session completed the refactor task",
    summaryText: "The agent rewrote the auth module and all tests pass.",
    truncated: false,
    sourceOffsetFirst: 0,
    sourceOffsetLast: 1024,
    createdAt: now,
    ...overrides,
  };
}

describe("SessionSummaryPanel", () => {
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

  function mockApi(overrides: Record<string, unknown> = {}) {
    vi.doMock("../../api", () => ({
      getSessionSummary: vi.fn().mockResolvedValue(null),
      toErrorMessage: (err: unknown, fallback: string) =>
        err instanceof Error ? err.message : fallback,
      ...overrides,
    }));
  }

  it("renders collapsed by default", async () => {
    mockApi();
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector(".session-summary-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".session-summary-body")).toBeNull();
  });

  it("expands and shows loading then no-summary state", async () => {
    mockApi({ getSessionSummary: vi.fn().mockResolvedValue(null) });
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector<HTMLElement>(".session-summary-toggle");
    await act(async () => { toggle?.click(); });

    expect(container.querySelector(".session-summary-body")).toBeTruthy();
    expect(container.textContent).toContain("No summary available.");
  });

  it("shows headline and body when summary available", async () => {
    const summary = makeSummary();
    mockApi({ getSessionSummary: vi.fn().mockResolvedValue(summary) });
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector<HTMLElement>(".session-summary-toggle");
    await act(async () => { toggle?.click(); });

    expect(container.querySelector(".session-summary-headline")?.textContent).toContain("Session completed the refactor task");
    expect(container.querySelector(".session-summary-text")?.textContent).toContain("The agent rewrote");
  });

  it("shows truncated badge when summary.truncated is true", async () => {
    const summary = makeSummary({ truncated: true });
    mockApi({ getSessionSummary: vi.fn().mockResolvedValue(summary) });
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector<HTMLElement>(".session-summary-toggle");
    await act(async () => { toggle?.click(); });

    expect(container.querySelector(".extraction-badge--truncated")).toBeTruthy();
    expect(container.textContent).toContain("truncated");
  });

  it("shows error when getSessionSummary rejects", async () => {
    mockApi({ getSessionSummary: vi.fn().mockRejectedValue(new Error("network error")) });
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector<HTMLElement>(".session-summary-toggle");
    await act(async () => { toggle?.click(); });

    expect(container.querySelector(".form-error")).toBeTruthy();
    expect(container.textContent).toContain("network error");
  });

  it("collapses when toggle clicked again", async () => {
    mockApi({ getSessionSummary: vi.fn().mockResolvedValue(null) });
    const { SessionSummaryPanel } = await import("./SessionSummaryPanel");

    await act(async () => {
      createRoot(container).render(<SessionSummaryPanel sessionId="sess-1" />);
    });

    const toggle = container.querySelector<HTMLElement>(".session-summary-toggle");
    await act(async () => { toggle?.click(); });
    expect(container.querySelector(".session-summary-body")).toBeTruthy();

    await act(async () => { toggle?.click(); });
    expect(container.querySelector(".session-summary-body")).toBeNull();
  });
});
