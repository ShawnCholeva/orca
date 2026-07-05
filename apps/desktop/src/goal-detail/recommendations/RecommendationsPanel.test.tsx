import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type {
  ProposedAction,
  Recommendation,
  RecommendationFeedback,
  RecommendationGeneration,
} from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec-1",
    goalId: "goal-1",
    type: "create_session",
    status: "proposed",
    source: "deterministic_provider",
    title: "Start implementation session",
    rationale: "Goal has a refined objective but no active sessions.",
    proposedAction: {
      kind: "create_session",
      adapterId: "claude-code",
      role: "engineer",
      objective: "Implement the feature",
    },
    confidence: 0.85,
    sources: [
      { type: "memory_item", id: "mem-1" },
      { type: "decision", id: "dec-1" },
    ],
    relatedTaskId: null,
    relatedSessionId: null,
    relatedContextPackageId: null,
    relatedConflictId: null,
    generationId: "gen-1",
    fingerprint: "rec-fp-1",
    supersededById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeGeneration(overrides: Partial<RecommendationGeneration> = {}): RecommendationGeneration {
  return {
    id: "gen-1",
    goalId: "goal-1",
    trigger: "manual",
    triggerSourceId: null,
    providerId: "orca-recommendation-provider",
    providerVersion: "1.0.0",
    inputFingerprint: "input-fp",
    requestFingerprint: "request-fp",
    status: "succeeded",
    failureCode: null,
    failureMessage: null,
    sparse: false,
    requestedAt: now,
    startedAt: now,
    finishedAt: now,
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<RecommendationFeedback> = {}): RecommendationFeedback {
  return {
    id: "fb-1",
    goalId: "goal-1",
    recommendationId: "rec-1",
    action: "accept",
    note: null,
    modifiedPayloadJson: null,
    createdAt: now,
    ...overrides,
  };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listRecommendations: vi.fn().mockResolvedValue({ recommendations: [], generations: [] }),
    generateRecommendations: vi.fn().mockResolvedValue({
      generation: makeGeneration({ status: "running", finishedAt: null }),
    }),
    acceptRecommendation: vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "create_session",
        adapterId: "claude-code",
        role: "engineer",
        objective: "Implement the feature",
      } as ProposedAction,
      feedback: makeFeedback({ action: "accept" }),
    }),
    rejectRecommendation: vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "rejected" }),
      feedback: makeFeedback({ action: "reject" }),
    }),
    dismissRecommendation: vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "dismissed" }),
      feedback: makeFeedback({ action: "dismiss" }),
    }),
    modifyRecommendation: vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "modified" }),
      feedback: makeFeedback({ action: "modify" }),
    }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    ...overrides,
  }));
}

describe("RecommendationsPanel", () => {
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

  it("renders loading state", async () => {
    mockApi({ listRecommendations: vi.fn(() => new Promise(() => undefined)) });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" />,
      );
    });

    expect(container.querySelector(".recommendations-panel-loading")).toBeTruthy();
    expect(container.textContent).toContain("Loading…");
  });

  it("renders empty state with generate CTA", async () => {
    mockApi();
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".recommendations-panel-empty")).toBeTruthy();
    expect(container.textContent).toContain("No recommendations yet.");
    expect(container.textContent).toContain("Generate recommendations");
  });

  it("renders Active section with proposed recommendation", async () => {
    const rec = makeRecommendation({ status: "proposed" });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [rec],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("Active (1)");
    expect(container.querySelector(".recommendation-card--proposed")).toBeTruthy();
    expect(container.textContent).toContain("Start implementation session");
    expect(container.textContent).toContain("create session");
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("Start engineer session");
    expect(container.textContent).toContain("1 memory · 1 decision");
  });

  it("renders Modified section as collapsible (expanded by default)", async () => {
    const rec = makeRecommendation({ status: "modified" });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [rec],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("Modified (1)");
    expect(container.querySelector(".recommendation-card--modified")).toBeTruthy();
  });

  it("collapses Modified section when toggle clicked", async () => {
    const rec = makeRecommendation({ status: "modified" });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [rec],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const toggle = Array.from(container.querySelectorAll(".recommendations-section-toggle")).find(
      (btn) => btn.textContent?.includes("Modified"),
    ) as HTMLElement;
    await act(async () => { toggle.click(); });

    expect(container.querySelector(".recommendation-card--modified")).toBeNull();
  });

  it("renders History section collapsed by default", async () => {
    const rec = makeRecommendation({ status: "accepted" });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [rec],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.textContent).toContain("History (1)");
    expect(container.querySelector(".recommendation-card--accepted")).toBeNull();
  });

  it("expands History section when toggle clicked", async () => {
    const rec = makeRecommendation({ status: "accepted", title: "Accepted rec" });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [rec],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const toggle = Array.from(container.querySelectorAll(".recommendations-section-toggle")).find(
      (btn) => btn.textContent?.includes("History"),
    ) as HTMLElement;
    await act(async () => { toggle.click(); });

    expect(container.querySelector(".recommendation-card--accepted")).toBeTruthy();
    expect(container.textContent).toContain("Accepted rec");
  });

  it("shows running generation banner and disables generate button", async () => {
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [],
        generations: [makeGeneration({ status: "running", finishedAt: null })],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".recommendation-generation-banner--running")).toBeTruthy();
    const button = container.querySelector<HTMLButtonElement>(".recommendations-generate-button");
    expect(button?.disabled).toBe(true);
  });

  it("shows failed generation banner with failure code", async () => {
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [],
        generations: [makeGeneration({ status: "failed", failureCode: "sparse_input" })],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    expect(container.querySelector(".recommendation-generation-banner--failed")).toBeTruthy();
    expect(container.textContent).toContain("failure: sparse_input");
  });

  it("calls generateRecommendations when generate button clicked", async () => {
    const generateRecommendations = vi.fn().mockResolvedValue({
      generation: makeGeneration({ status: "running", finishedAt: null }),
    });
    mockApi({ generateRecommendations });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const button = container.querySelector<HTMLButtonElement>(".recommendations-generate-button");
    await act(async () => { button?.click(); });

    expect(generateRecommendations).toHaveBeenCalledWith("goal-1");
  });

  it("calls acceptRecommendation when Accept clicked", async () => {
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "pause_work", reason: "pause", relatedTaskIds: [] } as ProposedAction,
      feedback: makeFeedback(),
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(acceptRecommendation).toHaveBeenCalledWith("rec-1", {});
  });

  it("calls rejectRecommendation when Reject clicked from overflow", async () => {
    const rejectRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "rejected" }),
      feedback: makeFeedback({ action: "reject" }),
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      rejectRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const rejectButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Reject",
    ) as HTMLElement;
    await act(async () => { rejectButton?.click(); });

    expect(rejectRecommendation).toHaveBeenCalledWith("rec-1", {});
  });

  it("calls dismissRecommendation when Dismiss clicked from overflow", async () => {
    const dismissRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "dismissed" }),
      feedback: makeFeedback({ action: "dismiss" }),
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      dismissRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const dismissButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Dismiss",
    ) as HTMLElement;
    await act(async () => { dismissButton?.click(); });

    expect(dismissRecommendation).toHaveBeenCalledWith("rec-1", {});
  });

  it("opens modify dialog when Modify clicked from overflow", async () => {
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const modifyButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Modify",
    ) as HTMLElement;
    await act(async () => { modifyButton?.click(); });

    expect(container.querySelector(".recommendation-modify-dialog")).toBeTruthy();
    expect(container.textContent).toContain("Modify Recommendation");
  });

  it("opens details drawer when Details clicked", async () => {
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-details-button")?.click();
    });

    expect(container.querySelector(".recommendation-details-drawer")).toBeTruthy();
    expect(container.textContent).toContain("Start implementation session");
    expect(container.textContent).toContain("Goal has a refined objective");
  });

  it("shows confidence badges: high for ≥0.8, med for 0.5–0.8, low for <0.5", async () => {
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [
          makeRecommendation({ id: "r1", confidence: 0.9 }),
          makeRecommendation({ id: "r2", confidence: 0.6 }),
          makeRecommendation({ id: "r3", confidence: 0.3 }),
        ],
        generations: [],
      }),
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const badges = container.querySelectorAll(".recommendation-confidence-badge");
    const texts = Array.from(badges).map((b) => b.textContent);
    expect(texts).toContain("high");
    expect(texts).toContain("med");
    expect(texts).toContain("low");
  });

  // === Per-kind prefill tests ===

  it("prefill: create_session → calls onOpenCreateSession, does NOT call createSession API", async () => {
    const createSession = vi.fn();
    const onOpenCreateSession = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "create_session",
        adapterId: "claude-code",
        role: "engineer",
        objective: "Implement the feature",
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    mockApi({ acceptRecommendation, createSession });

    const { RecommendationsPanel } = await import("./RecommendationsPanel");
    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel
          goalId="goal-1"
          onOpenCreateSession={onOpenCreateSession}
        />,
      );
    });

    // Trigger list reload with one proposed recommendation
    vi.resetModules();
    const { listRecommendations: mockList } = await import("../../api");
    void mockList; // already mocked above via doMock

    // Re-render with a recommendation
    vi.doMock("../../api", () => ({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation({ status: "proposed" })],
        generations: [],
      }),
      acceptRecommendation,
      createSession,
      generateRecommendations: vi.fn(),
      rejectRecommendation: vi.fn(),
      dismissRecommendation: vi.fn(),
      modifyRecommendation: vi.fn(),
      toErrorMessage: (err: unknown, fallback: string) =>
        err instanceof Error ? err.message : fallback,
    }));

    vi.resetModules();
    const { RecommendationsPanel: Panel2 } = await import("./RecommendationsPanel");
    container.innerHTML = "";
    await act(async () => {
      createRoot(container).render(
        <Panel2 goalId="goal-1" onOpenCreateSession={onOpenCreateSession} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(acceptRecommendation).toHaveBeenCalledWith("rec-1", {});
    expect(onOpenCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "claude-code",
        role: "engineer",
        objective: "Implement the feature",
        fromRecommendationId: "rec-1",
      }),
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("prefill: continue_session → calls onNavigateToSession", async () => {
    const onNavigateToSession = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "continue_session", sessionId: "sess-99" } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "continue_session",
      proposedAction: { kind: "continue_session", sessionId: "sess-99" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onNavigateToSession={onNavigateToSession} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onNavigateToSession).toHaveBeenCalledWith("sess-99");
  });

  it("prefill: review_output → calls onOpenCreateSession with reviewer role, does NOT call createSession API", async () => {
    const createSession = vi.fn();
    const onOpenCreateSession = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "review_output", sessionId: "sess-1", reviewerRole: "reviewer" } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "review_output",
      proposedAction: { kind: "review_output", sessionId: "sess-1", reviewerRole: "reviewer" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
      createSession,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenCreateSession={onOpenCreateSession} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ role: "reviewer" }),
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("prefill: refine_goal → calls onOpenRefinement with missing fields", async () => {
    const onOpenRefinement = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "refine_goal", missingFields: ["objective", "constraints"] } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "refine_goal",
      proposedAction: { kind: "refine_goal", missingFields: ["objective", "constraints"] },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenRefinement={onOpenRefinement} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenRefinement).toHaveBeenCalledWith(["objective", "constraints"]);
  });

  it("prefill: split_task → calls onOpenTaskSplit with taskId and suggestedChildren", async () => {
    const onOpenTaskSplit = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "split_task",
        taskId: "task-abc",
        suggestedChildren: [{ title: "Child A" }, { title: "Child B" }],
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "split_task",
      proposedAction: {
        kind: "split_task",
        taskId: "task-abc",
        suggestedChildren: [{ title: "Child A" }, { title: "Child B" }],
      },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenTaskSplit={onOpenTaskSplit} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenTaskSplit).toHaveBeenCalledWith("task-abc", [{ title: "Child A" }, { title: "Child B" }]);
  });

  it("prefill: run_validation → calls onOpenCreateSession with qa role, does NOT call createSession API", async () => {
    const createSession = vi.fn();
    const onOpenCreateSession = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "run_validation",
        taskId: "task-1",
        suggestedRole: "qa",
        objective: "Run validation suite",
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "run_validation",
      proposedAction: { kind: "run_validation", taskId: "task-1", suggestedRole: "qa", objective: "Run validation suite" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
      createSession,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenCreateSession={onOpenCreateSession} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ role: "qa", objective: "Run validation suite" }),
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("prefill: resolve_conflict → calls onOpenConflictResolve", async () => {
    const onOpenConflictResolve = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "resolve_conflict",
        conflictId: "conflict-1",
        suggestedResolutionNote: "Resolve by removing old constraint",
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "resolve_conflict",
      proposedAction: {
        kind: "resolve_conflict",
        conflictId: "conflict-1",
        suggestedResolutionNote: "Resolve by removing old constraint",
      },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenConflictResolve={onOpenConflictResolve} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenConflictResolve).toHaveBeenCalledWith("conflict-1", "Resolve by removing old constraint");
  });

  it("prefill: update_plan → calls onOpenTaskEdit with taskId and suggestedStatus", async () => {
    const onOpenTaskEdit = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "update_plan",
        taskId: "task-xyz",
        suggestedStatus: "in_progress",
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "update_plan",
      proposedAction: { kind: "update_plan", taskId: "task-xyz", suggestedStatus: "in_progress" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenTaskEdit={onOpenTaskEdit} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenTaskEdit).toHaveBeenCalledWith("task-xyz", "in_progress", undefined);
  });

  it("prefill: ask_user → calls onAskUser with question", async () => {
    const onAskUser = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "ask_user", question: "What is the priority?" } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "ask_user",
      proposedAction: { kind: "ask_user", question: "What is the priority?" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onAskUser={onAskUser} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onAskUser).toHaveBeenCalledWith("What is the priority?");
  });

  it("prefill: mark_complete → calls onOpenTaskEdit with taskId and done status", async () => {
    const onOpenTaskEdit = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: { kind: "mark_complete", taskId: "task-done" } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "mark_complete",
      proposedAction: { kind: "mark_complete", taskId: "task-done" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(
        <RecommendationsPanel goalId="goal-1" onOpenTaskEdit={onOpenTaskEdit} />,
      );
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(onOpenTaskEdit).toHaveBeenCalledWith("task-done", "done");
  });

  it("prefill: pause_work → shows toast, does NOT call createSession API", async () => {
    const createSession = vi.fn();
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "pause_work",
        reason: "Blocker detected",
        relatedTaskIds: ["task-1"],
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "pause_work",
      proposedAction: { kind: "pause_work", reason: "Blocker detected", relatedTaskIds: ["task-1"] },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
      createSession,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(container.querySelector(".recommendations-pause-toast")).toBeTruthy();
    expect(container.textContent).toContain("Work paused");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("prefill: complete_workflow_run → shows a confirmation toast (not a silent no-op)", async () => {
    const acceptRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "complete_workflow_run",
        workflowRunId: "run-1",
        workflowStepRunId: "step-1",
      } as ProposedAction,
      feedback: makeFeedback(),
    });
    const rec = makeRecommendation({
      type: "complete_workflow_run",
      proposedAction: { kind: "complete_workflow_run", workflowRunId: "run-1", workflowStepRunId: "step-1" },
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({ recommendations: [rec], generations: [] }),
      acceptRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    const acceptButton = container.querySelector<HTMLButtonElement>(".recommendation-accept-button");
    await act(async () => { acceptButton?.click(); });

    expect(acceptRecommendation).toHaveBeenCalledWith("rec-1", {});
    expect(container.querySelector(".recommendations-pause-toast")).toBeTruthy();
    expect(container.textContent).toContain("Workflow run completed");
  });

  // === Modify dialog field cap tests ===

  it("modify dialog enforces title cap", async () => {
    const modifyRecommendation = vi.fn();
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      modifyRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    // Open modify dialog
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const modifyButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Modify",
    ) as HTMLElement;
    await act(async () => { modifyButton?.click(); });

    const titleInput = container.querySelector<HTMLInputElement>("#rec-modify-title");
    await act(async () => {
      setControlValue(titleInput!, "x".repeat(257));
    });

    const saveButton = container.querySelector<HTMLButtonElement>(".recommendation-modify-dialog button[type='submit']");
    await act(async () => { saveButton?.click(); });

    expect(container.textContent).toContain("256 characters or fewer");
    expect(modifyRecommendation).not.toHaveBeenCalled();
  });

  it("modify dialog enforces rationale cap", async () => {
    const modifyRecommendation = vi.fn();
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      modifyRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const modifyButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Modify",
    ) as HTMLElement;
    await act(async () => { modifyButton?.click(); });

    const rationaleTextarea = container.querySelector<HTMLTextAreaElement>("#rec-modify-rationale");
    await act(async () => {
      setControlValue(rationaleTextarea!, "x".repeat(4097));
    });

    const saveButton = container.querySelector<HTMLButtonElement>(".recommendation-modify-dialog button[type='submit']");
    await act(async () => { saveButton?.click(); });

    expect(container.textContent).toContain("4096 characters or fewer");
    expect(modifyRecommendation).not.toHaveBeenCalled();
  });

  it("modify dialog submits modifyRecommendation on save", async () => {
    const modifyRecommendation = vi.fn().mockResolvedValue({
      recommendation: makeRecommendation({ status: "modified", title: "Updated title" }),
      feedback: makeFeedback({ action: "modify" }),
    });
    mockApi({
      listRecommendations: vi.fn().mockResolvedValue({
        recommendations: [makeRecommendation()],
        generations: [],
      }),
      modifyRecommendation,
    });
    const { RecommendationsPanel } = await import("./RecommendationsPanel");

    await act(async () => {
      createRoot(container).render(<RecommendationsPanel goalId="goal-1" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".recommendation-overflow-button")?.click();
    });
    const modifyButton = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (btn) => btn.textContent === "Modify",
    ) as HTMLElement;
    await act(async () => { modifyButton?.click(); });

    const titleInput = container.querySelector<HTMLInputElement>("#rec-modify-title");
    await act(async () => {
      setControlValue(titleInput!, "Updated title");
    });

    const saveButton = container.querySelector<HTMLButtonElement>(".recommendation-modify-dialog button[type='submit']");
    await act(async () => { saveButton?.click(); });

    expect(modifyRecommendation).toHaveBeenCalledWith(
      "rec-1",
      expect.objectContaining({ title: "Updated title" }),
    );
  });
});

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
