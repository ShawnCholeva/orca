import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AdapterId, ContextAssembly, ContextPackage, SessionSummary } from "@orca/contracts";
import { getContextBadgeState } from "../sessions/SessionContextBadge";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

// No surviving adapter delivers context directly (all are preview-only), but the
// badge logic still supports a non-preview adapter; exercise it with a synthetic id.
const directAdapter = "direct-context-adapter" as unknown as AdapterId;

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    goalId: "goal-1",
    workspaceId: "ws-1",
    adapterId: "claude-code" as AdapterId,
    contextPackageId: null,
    role: null,
    title: "claude-code session",
    status: "running" as const,
    createdAt: now,
    startedAt: null,
    exitedAt: null,
    ...overrides,
  };
}

function makePkg(overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    id: "pkg-1",
    goalId: "goal-1",
    supersedesPackageId: null,
    adapterId: "claude-code" as AdapterId,
    workspaceId: "ws-1",
    role: "engineer",
    objective: "test objective",
    status: "ready",
    renderedContext: "# Test\nsome content\n",
    renderedBytes: 19,
    estimatedTokens: 5,
    truncated: false,
    sparse: false,
    sourceCount: 2,
    sources: [
      { type: "goal", id: "goal-1", sourceSessionId: null, label: "Goal", reason: "required", marker: "[S1]" },
      { type: "memory_item", id: "mem-1", sourceSessionId: null, label: "Memory", reason: "high_confidence", marker: "[S2]" },
    ],
    warnings: [],
    sourceFingerprint: "fp-1",
    assemblerVersion: "0.1.0",
    createdAt: now,
    ...overrides,
  };
}

const workspace = {
  id: "ws-1",
  path: "/tmp/repo",
  name: "repo",
  description: "",
  createdAt: now,
  updatedAt: now,
};

const adapters = [
  { id: "claude-code" as AdapterId, title: "Claude Code", availability: "available" as const },
];

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [] }),
    listAdapters: vi.fn().mockResolvedValue({ adapters }),
    createSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    extractSessionMemory: vi.fn(),
    getContextPackage: vi.fn(),
    openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
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
  vi.doMock("../sessions/SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId, status }: { sessionId: string; status: string }) => (
      <div className="session-terminal" data-session-id={sessionId} data-status={status} />
    ),
  }));
  vi.doMock("../sessions/SessionSummaryPanel", () => ({
    SessionSummaryPanel: ({ sessionId }: { sessionId: string }) => (
      <div className="session-summary-panel" data-session-id={sessionId} />
    ),
  }));
}

// ── Unit tests for getContextBadgeState ─────────────────────────────────────

describe("getContextBadgeState", () => {
  it("returns none when session has no contextPackageId", () => {
    const session = makeSession({ contextPackageId: null });
    expect(getContextBadgeState(session, undefined)).toBe("none");
  });

  it("returns failed when pkg is null (fetch failed)", () => {
    const session = makeSession({ contextPackageId: "pkg-1" });
    expect(getContextBadgeState(session, null)).toBe("failed");
  });

  it("returns none when pkg is undefined (loading)", () => {
    const session = makeSession({ contextPackageId: "pkg-1" });
    expect(getContextBadgeState(session, undefined)).toBe("none");
  });

  it("returns preview-only for claude-code adapter", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: "claude-code" as AdapterId });
    const pkg = makePkg({ adapterId: "claude-code" as AdapterId });
    expect(getContextBadgeState(session, pkg)).toBe("preview-only");
  });

  it("returns preview-only for codex adapter", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: "codex" as AdapterId });
    const pkg = makePkg({ adapterId: "codex" as AdapterId });
    expect(getContextBadgeState(session, pkg)).toBe("preview-only");
  });

  it("returns sparse for a context-delivering adapter with a sparse package", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: directAdapter });
    const pkg = makePkg({ adapterId: directAdapter, sparse: true, truncated: false });
    expect(getContextBadgeState(session, pkg)).toBe("sparse");
  });

  it("returns truncated for a context-delivering adapter with a truncated package", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: directAdapter });
    const pkg = makePkg({ adapterId: directAdapter, sparse: false, truncated: true });
    expect(getContextBadgeState(session, pkg)).toBe("truncated");
  });

  it("returns ready for a context-delivering adapter with a non-sparse non-truncated package", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: directAdapter });
    const pkg = makePkg({ adapterId: directAdapter, sparse: false, truncated: false });
    expect(getContextBadgeState(session, pkg)).toBe("ready");
  });

  it("preview-only takes precedence over sparse", () => {
    const session = makeSession({ contextPackageId: "pkg-1", adapterId: "claude-code" as AdapterId });
    const pkg = makePkg({ adapterId: "claude-code" as AdapterId, sparse: true });
    expect(getContextBadgeState(session, pkg)).toBe("preview-only");
  });
});

// ── Integration tests: badge in SessionsPanel ────────────────────────────────

describe("SessionContextBadge in SessionsPanel", () => {
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

  it("renders ready badge with KiB and source count for session with context package", async () => {
    const pkg = makePkg({ adapterId: directAdapter, renderedBytes: 12698, sourceCount: 9 });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: "pkg-1" })],
      }),
      listContextPackages: vi.fn().mockResolvedValue({ packages: [pkg], assemblies: [] }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const badge = container.querySelector(".session-context-badge--ready");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain("ready");
    expect(badge?.textContent).toContain("KiB");
    expect(badge?.textContent).toContain("9 sources");
  });

  it("renders sparse badge for sparse package", async () => {
    const pkg = makePkg({ adapterId: directAdapter, sparse: true });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: "pkg-1" })],
      }),
      listContextPackages: vi.fn().mockResolvedValue({ packages: [pkg], assemblies: [] }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".session-context-badge--sparse")).toBeTruthy();
  });

  it("renders truncated badge for truncated package", async () => {
    const pkg = makePkg({ adapterId: directAdapter, truncated: true });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: "pkg-1" })],
      }),
      listContextPackages: vi.fn().mockResolvedValue({ packages: [pkg], assemblies: [] }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".session-context-badge--truncated")).toBeTruthy();
  });

  it("renders preview-only badge for claude-code session", async () => {
    const pkg = makePkg({ adapterId: "claude-code" as AdapterId });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: "pkg-1", adapterId: "claude-code" as AdapterId })],
      }),
      listContextPackages: vi.fn().mockResolvedValue({ packages: [pkg], assemblies: [] }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".session-context-badge--preview-only")).toBeTruthy();
  });

  it("renders no badge for session without context package", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: null })],
      }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".session-context-badge")).toBeNull();
  });

  it("clicking badge opens context preview panel", async () => {
    const pkg = makePkg();
    const assembly: ContextAssembly = {
      id: "asm-1",
      goalId: "goal-1",
      packageId: "pkg-1",
      replacePackageId: null,
      adapterId: "claude-code",
      workspaceId: "ws-1",
      role: "engineer",
      objectiveHash: "hash",
      sourceFingerprint: "fp-1",
      assemblerVersion: "0.1.0",
      requestFingerprint: "req-fp-1",
      status: "succeeded",
      trigger: "prepare",
      failureCode: null,
      failureMessage: null,
      requestedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ contextPackageId: "pkg-1" })],
      }),
      listContextPackages: vi.fn().mockResolvedValue({ packages: [pkg], assemblies: [assembly] }),
      openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const badge = container.querySelector<HTMLButtonElement>(".session-context-badge");
    expect(badge).toBeTruthy();

    await act(async () => {
      badge?.click();
    });

    // Session context panel should now be open and show the context preview body
    expect(container.querySelector(".session-context-panel")).toBeTruthy();
    expect(container.querySelector(".session-context-panel-body")).toBeTruthy();
  });

  it("reconnect refetches sessions and packages", async () => {
    let capturedStatus: ((status: string) => void) | null = null;
    const openEventStream = vi.fn().mockImplementation(
      (handlers: { onEvent: (e: unknown) => void; onStatus: (s: string) => void }) => {
        capturedStatus = handlers.onStatus;
        return { close: vi.fn() };
      }
    );
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const listContextPackages = vi.fn().mockResolvedValue({ packages: [], assemblies: [] });
    mockApi({ openEventStream, listSessions, listContextPackages });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} sessionsRefreshKey={0} />,
      );
    });

    expect(listContextPackages).toHaveBeenCalledTimes(1);

    // Simulate reconnect by incrementing sessionsRefreshKey (GoalDetailView behavior)
    const { SessionsPanel: SessionsPanel2 } = await import("../sessions/SessionsPanel");
    await act(async () => {
      createRoot(container).render(
        <SessionsPanel2 goalId="goal-1" workspaces={[workspace]} sessionsRefreshKey={1} />,
      );
    });

    expect(listContextPackages).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("shows daemon restart banner when assembly has daemon_restart failure", async () => {
    const assembly: ContextAssembly = {
      id: "asm-failed",
      goalId: "goal-1",
      packageId: null,
      replacePackageId: null,
      adapterId: "claude-code",
      workspaceId: "ws-1",
      role: "engineer",
      objectiveHash: "hash",
      sourceFingerprint: "fp-1",
      assemblerVersion: "0.1.0",
      requestFingerprint: "req-fp-1",
      status: "failed",
      trigger: "prepare",
      failureCode: "daemon_restart",
      failureMessage: "Interrupted by restart",
      requestedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    mockApi({
      listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [assembly] }),
    });
    const { SessionsPanel } = await import("../sessions/SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".context-restart-banner")).toBeTruthy();
    expect(container.textContent).toContain("interrupted by a daemon restart");
  });
});
