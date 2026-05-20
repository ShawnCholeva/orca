import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AdapterId, SessionSummary, Workspace } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

const workspace: Workspace = {
  id: "ws-1",
  goalId: "goal-1",
  path: "/tmp/repo",
  name: "repo",
  workspaceType: "folder" as const,
  branch: null,
  isDirty: null,
  gitProbe: "not_a_repo" as const,
  attachedAt: now,
};

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    goalId: "goal-1",
    workspaceId: "ws-1",
    adapterId: "shell-manual" as AdapterId,
    role: null,
    title: "shell-manual session",
    status: "created" as const,
    createdAt: now,
    startedAt: null,
    exitedAt: null,
    ...overrides,
  };
}

const adapters = [
  { id: "shell-manual" as AdapterId, title: "Shell / Manual", availability: "available" as const },
  { id: "claude-code" as AdapterId, title: "Claude Code", availability: "unavailable" as const, detail: "not in PATH; set ORCA_CLAUDE_CODE_BIN" },
  { id: "opencode" as AdapterId, title: "opencode", availability: "unavailable" as const, detail: "not in PATH; set ORCA_OPENCODE_BIN" },
  { id: "codex" as AdapterId, title: "Codex", availability: "unavailable" as const, detail: "not in PATH; set ORCA_CODEX_BIN" },
];

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [] }),
    listAdapters: vi.fn().mockResolvedValue({ adapters }),
    createSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    extractSessionMemory: vi.fn().mockResolvedValue({ id: "ext-1", status: "pending" }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
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
  vi.doMock("./SessionTerminalView", () => ({
    SessionTerminalView: ({ sessionId, status }: { sessionId: string; status: string }) => (
      <div className="session-terminal" data-session-id={sessionId} data-status={status} />
    ),
  }));
  vi.doMock("./SessionSummaryPanel", () => ({
    SessionSummaryPanel: ({ sessionId }: { sessionId: string }) => (
      <div className="session-summary-panel" data-session-id={sessionId} />
    ),
  }));
}

describe("SessionsPanel", () => {
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

  it("renders empty state when no sessions", async () => {
    mockApi();
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.textContent).toContain("No sessions yet.");
  });

  it("renders session list when sessions exist", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          makeSession({ id: "sess-1", status: "running" }),
          makeSession({ id: "sess-2", status: "exited" }),
        ],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const items = container.querySelectorAll(".session-list-item");
    expect(items).toHaveLength(2);
  });

  it("renders the terminal for the selected session", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "running" })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".session-list-item")?.click();
    });

    const terminal = container.querySelector<HTMLElement>(".session-terminal");
    expect(terminal?.dataset.sessionId).toBe("sess-1");
    expect(terminal?.dataset.status).toBe("running");
  });

  it("shows stop button only for running/starting sessions", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          makeSession({ id: "sess-running", status: "running" }),
          makeSession({ id: "sess-exited", status: "exited" }),
        ],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const stopButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Stop"),
    );
    expect(stopButtons).toHaveLength(1);
  });

  it("calls stopSession when stop button clicked", async () => {
    const stopSession = vi.fn().mockResolvedValue({
      session: makeSession({ status: "stopped" }),
    });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "running" })],
      }),
      stopSession,
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Stop",
    );

    await act(async () => {
      stopButton?.click();
    });

    expect(stopSession).toHaveBeenCalledWith("sess-1");
  });

  it("disables new session button when no workspaces", async () => {
    mockApi();
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[]} />,
      );
    });

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("New Session"),
    );
    expect(btn?.disabled).toBe(true);
  });

  it("shows create dialog when new session button clicked", async () => {
    mockApi();
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("New Session"),
    );
    await act(async () => { btn?.click(); });

    expect(container.querySelector(".create-session-dialog")).toBeTruthy();
  });

  it("subscribes to event stream and refreshes on session lifecycle events", async () => {
    let capturedHandler: ((event: { type: string; goalId: string | null }) => void) | null = null;
    const openEventStream = vi.fn().mockImplementation((handlers: { onEvent: (e: { type: string; goalId: string | null }) => void }) => {
      capturedHandler = handlers.onEvent;
      return { close: vi.fn() };
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    mockApi({ openEventStream, listSessions });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedHandler?.({ type: "session.created", goalId: "goal-1" });
    });

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("does not refresh on session events for other goals", async () => {
    let capturedHandler: ((event: { type: string; goalId: string | null }) => void) | null = null;
    const openEventStream = vi.fn().mockImplementation((handlers: { onEvent: (e: { type: string; goalId: string | null }) => void }) => {
      capturedHandler = handlers.onEvent;
      return { close: vi.fn() };
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    mockApi({ openEventStream, listSessions });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    await act(async () => {
      capturedHandler?.({ type: "session.created", goalId: "goal-other" });
    });

    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("shows extraction badge 'no extraction' when latestExtraction absent", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "exited" })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".extraction-badge--none")).toBeTruthy();
    expect(container.textContent).toContain("no extraction");
  });

  it("shows pending extraction badge", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "pending", requestedAt: now,
            finishedAt: null, failureCode: null, truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".extraction-badge--busy")).toBeTruthy();
    expect(container.textContent).toContain("extraction pending");
  });

  it("shows running extraction badge", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "running", requestedAt: now,
            finishedAt: null, failureCode: null, truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".extraction-badge--busy")).toBeTruthy();
    expect(container.textContent).toContain("extracting");
  });

  it("shows succeeded extraction badge", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "succeeded", requestedAt: now,
            finishedAt: now, failureCode: null, truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(container.querySelector(".extraction-badge--succeeded")).toBeTruthy();
    expect(container.textContent).toContain("extracted");
  });

  it("shows succeeded+truncated extraction badge with tooltip", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "succeeded", requestedAt: now,
            finishedAt: now, failureCode: null, truncated: true,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const badge = container.querySelector(".extraction-badge--succeeded");
    expect(badge?.textContent).toContain("extracted (truncated)");
    expect(badge?.getAttribute("title")).toContain("truncated");
  });

  it("shows failed extraction badge with failureCode tooltip", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "failed", requestedAt: now,
            finishedAt: now, failureCode: "output_unavailable", truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const badge = container.querySelector(".extraction-badge--failed");
    expect(badge?.textContent).toContain("extraction failed");
    expect(badge?.getAttribute("title")).toBe("output_unavailable");
  });

  it("shows Extract now button for terminal session without extraction", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "exited" })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const extractBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Extract now"),
    );
    expect(extractBtn).toBeTruthy();
    expect(extractBtn?.disabled).toBe(false);
  });

  it("shows Retry extraction button for failed extraction", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "failed", requestedAt: now,
            finishedAt: now, failureCode: "internal_error", truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Retry extraction"),
    );
    expect(retryBtn).toBeTruthy();
  });

  it("extract button disabled while extraction pending", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({
          id: "sess-1",
          status: "exited",
          latestExtraction: {
            id: "ext-1", status: "pending", requestedAt: now,
            finishedAt: null, failureCode: null, truncated: false,
          },
        })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const extractBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Extract now"),
    );
    expect(extractBtn?.disabled).toBe(true);
  });

  it("no extract button for non-terminal session", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "running" })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const extractBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Extract now") || b.textContent?.includes("Retry"),
    );
    expect(extractBtn).toBeUndefined();
  });

  it("calls extractSessionMemory when extract button clicked", async () => {
    const extractSessionMemory = vi.fn().mockResolvedValue({ id: "ext-new", status: "pending" });
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "exited" })],
      }),
      extractSessionMemory,
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    const extractBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Extract now"),
    );
    await act(async () => { extractBtn?.click(); });

    expect(extractSessionMemory).toHaveBeenCalledWith("sess-1");
  });

  it("refreshes on extraction events for this goal", async () => {
    let capturedHandler: ((event: { type: string; goalId: string | null }) => void) | null = null;
    const openEventStream = vi.fn().mockImplementation((handlers: { onEvent: (e: { type: string; goalId: string | null }) => void }) => {
      capturedHandler = handlers.onEvent;
      return { close: vi.fn() };
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    mockApi({ openEventStream, listSessions });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedHandler?.({ type: "memory.extraction.completed", goalId: "goal-1" });
    });

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("mounts SessionSummaryPanel for selected terminal session", async () => {
    mockApi({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: "sess-1", status: "exited" })],
      }),
    });
    const { SessionsPanel } = await import("./SessionsPanel");

    await act(async () => {
      createRoot(container).render(
        <SessionsPanel goalId="goal-1" workspaces={[workspace]} />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".session-list-item")?.click();
    });

    const panel = container.querySelector<HTMLElement>(".session-summary-panel");
    expect(panel).toBeTruthy();
    expect(panel?.dataset.sessionId).toBe("sess-1");
  });
});

describe("CreateSessionDialog", () => {
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

  it("renders workspace and adapter selectors", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container.querySelector("#create-session-workspace")).toBeTruthy();
    expect(container.querySelector("#create-session-adapter")).toBeTruthy();
  });

  it("shows workspace required error when no workspace selected", async () => {
    mockApi({
      listAdapters: vi.fn().mockResolvedValue({ adapters: [] }),
    });
    const { CreateSessionDialog } = await import("./CreateSessionDialog");
    const onCreated = vi.fn();

    // Render with no workspaces so workspaceId defaults to ""
    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[]}
          onCreated={onCreated}
          onClose={vi.fn()}
        />,
      );
    });

    const form = container.querySelector<HTMLFormElement>(".create-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Workspace is required.");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows adapter required error when no adapter selected", async () => {
    mockApi({
      listAdapters: vi.fn().mockResolvedValue({ adapters: [] }),
    });
    const { CreateSessionDialog } = await import("./CreateSessionDialog");
    const onCreated = vi.fn();

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={onCreated}
          onClose={vi.fn()}
        />,
      );
    });

    // workspace is pre-selected, but no adapters loaded → adapterId stays ""
    const form = container.querySelector<HTMLFormElement>(".create-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Adapter is required.");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows unavailable adapter hint", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    // Select the unavailable claude-code adapter
    const adapterSelect = container.querySelector<HTMLSelectElement>("#create-session-adapter");
    await act(async () => {
      if (adapterSelect) {
        adapterSelect.value = "claude-code";
        adapterSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(container.textContent).toContain("not in PATH");
  });

  it("shows unavailable labels and env override hints for all agent adapters", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const adapterSelect = container.querySelector<HTMLSelectElement>("#create-session-adapter");
    expect(adapterSelect?.textContent).toContain("Claude Code (unavailable)");
    expect(adapterSelect?.textContent).toContain("opencode (unavailable)");
    expect(adapterSelect?.textContent).toContain("Codex (unavailable)");

    for (const [adapterId, envKey] of [
      ["claude-code", "ORCA_CLAUDE_CODE_BIN"],
      ["opencode", "ORCA_OPENCODE_BIN"],
      ["codex", "ORCA_CODEX_BIN"],
    ] as const) {
      await act(async () => {
        if (adapterSelect) {
          adapterSelect.value = adapterId;
          adapterSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      expect(container.textContent).toContain(envKey);
    }
  });

  it("calls createSession and startSession on successful submit", async () => {
    const sessionDetail = {
      id: "sess-new",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "created" as const,
      createdAt: now,
      startedAt: null,
      exitedAt: null,
      instruction: null,
      pid: null,
      command: null,
      args: null,
      cwd: null,
      terminalCols: null,
      terminalRows: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    const createSession = vi.fn().mockResolvedValue({ session: sessionDetail });
    const startSession = vi.fn().mockResolvedValue({ session: { ...sessionDetail, status: "running" } });
    const onCreated = vi.fn();
    mockApi({ createSession, startSession });
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={onCreated}
          onClose={vi.fn()}
        />,
      );
    });

    const form = container.querySelector<HTMLFormElement>(".create-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createSession).toHaveBeenCalledWith("goal-1", expect.objectContaining({
      workspaceId: "ws-1",
      adapterId: "shell-manual",
    }));
    expect(startSession).toHaveBeenCalledWith("sess-new", { terminalCols: 80, terminalRows: 24 });
    expect(onCreated).toHaveBeenCalledWith("sess-new");
  });

  it("shows command_not_found error with env-var hint", async () => {
    const ApiErrorClass = class ApiError extends Error {
      code: string | undefined;
      constructor(message: string, _cause?: unknown, code?: string) {
        super(message);
        this.name = "ApiError";
        this.code = code;
      }
    };
    const createSession = vi.fn().mockRejectedValue(
      new ApiErrorClass("binary not found", undefined, "command_not_found"),
    );
    vi.doMock("../../api", () => ({
      listAdapters: vi.fn().mockResolvedValue({ adapters }),
      createSession,
      startSession: vi.fn(),
      stopSession: vi.fn(),
      openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
      ApiError: ApiErrorClass,
    }));
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const form = container.querySelector<HTMLFormElement>(".create-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("ORCA_SHELL_MANUAL_BIN");
  });

  it("shows workspace_unavailable error distinctly", async () => {
    const ApiErrorClass = class ApiError extends Error {
      code: string | undefined;
      constructor(message: string, _cause?: unknown, code?: string) {
        super(message);
        this.name = "ApiError";
        this.code = code;
      }
    };
    const createSession = vi.fn().mockRejectedValue(
      new ApiErrorClass("path not accessible", undefined, "workspace_unavailable"),
    );
    vi.doMock("../../api", () => ({
      listAdapters: vi.fn().mockResolvedValue({ adapters }),
      createSession,
      startSession: vi.fn(),
      stopSession: vi.fn(),
      openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
      ApiError: ApiErrorClass,
    }));
    const { CreateSessionDialog } = await import("./CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const form = container.querySelector<HTMLFormElement>(".create-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Workspace path is not accessible");
  });
});
