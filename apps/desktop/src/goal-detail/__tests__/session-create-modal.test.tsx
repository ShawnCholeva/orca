import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AdapterId, ContextAssembly, ContextPackage, CreateContextPackageResponse, Workspace } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  nativeTextareaSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

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

const adapters = [
  { id: "shell-manual" as AdapterId, title: "Shell / Manual", availability: "available" as const },
  { id: "claude-code" as AdapterId, title: "Claude Code", availability: "unavailable" as const, detail: "not in PATH; set ORCA_CLAUDE_CODE_BIN" },
];

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

const pkg: ContextPackage = {
  id: "pkg-1",
  goalId: "goal-1",
  supersedesPackageId: null,
  adapterId: "shell-manual",
  workspaceId: "ws-1",
  role: "engineer",
  objective: "Summarize the goal before starting",
  status: "ready",
  renderedContext: "# Objective\nSummarize the goal before starting\n",
  renderedBytes: 42,
  estimatedTokens: 11,
  truncated: false,
  sparse: false,
  sourceCount: 1,
  sources: [{ type: "goal", id: "goal-1", sourceSessionId: null, label: "Goal", reason: "required", marker: "[goal:goal-1]" }],
  warnings: [],
  sourceFingerprint: "fp-1",
  assemblerVersion: "0.1.0",
  createdAt: now,
};

const assembly: ContextAssembly = {
  id: "asm-1",
  goalId: "goal-1",
  packageId: "pkg-1",
  replacePackageId: null,
  adapterId: "shell-manual",
  workspaceId: "ws-1",
  role: "engineer",
  objectiveHash: "obj-hash",
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

const contextResponse: CreateContextPackageResponse = {
  package: pkg,
  assembly,
  reused: false,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listAdapters: vi.fn().mockResolvedValue({ adapters }),
    createSession: vi.fn().mockResolvedValue({ session: sessionDetail }),
    startSession: vi.fn().mockResolvedValue({ session: { ...sessionDetail, status: "running" } }),
    createContextPackage: vi.fn().mockResolvedValue(contextResponse),
    listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [] }),
    getContextPackage: vi.fn().mockResolvedValue({ package: pkg }),
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
}

describe("CreateSessionDialog — M6-013 context controls", () => {
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

  it("default state shows both Prepare context and Skip context buttons with no preview area", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Prepare context");
    expect(buttons).toContain("Skip context");
    expect(container.querySelector(".context-preview-panel")).toBeNull();
  });

  it("Skip-context path calls createSession with M4-shaped request", async () => {
    const createSession = vi.fn().mockResolvedValue({ session: sessionDetail });
    const startSession = vi.fn().mockResolvedValue({ session: { ...sessionDetail, status: "running" } });
    const onCreated = vi.fn();
    mockApi({ createSession, startSession });
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const skipBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Skip context",
    );
    expect(skipBtn).toBeTruthy();

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
    // contextPackageId must not be present on skip path
    const callArg = createSession.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty("contextPackageId");
  });

  it("Prepare-context path calls createContextPackage with role, objective, adapterId, workspaceId", async () => {
    const createContextPackage = vi.fn().mockResolvedValue(contextResponse);
    const onContextPrepared = vi.fn();
    mockApi({ createContextPackage });
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

    await act(async () => {
      createRoot(container).render(
        <CreateSessionDialog
          goalId="goal-1"
          workspaces={[workspace]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
          onContextPrepared={onContextPrepared}
        />,
      );
    });

    // Select engineer role
    const roleSelect = container.querySelector<HTMLSelectElement>("#create-session-role");
    await act(async () => {
      if (roleSelect) {
        roleSelect.value = "engineer";
        roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Type objective
    const objectiveArea = container.querySelector<HTMLTextAreaElement>("#create-session-objective");
    await act(async () => {
      if (objectiveArea) setTextareaValue(objectiveArea, "Summarize the goal before starting");
    });

    const prepareBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Prepare context",
    );
    expect(prepareBtn).toBeTruthy();

    await act(async () => {
      prepareBtn?.click();
    });

    expect(createContextPackage).toHaveBeenCalledWith("goal-1", expect.objectContaining({
      adapterId: "shell-manual",
      role: "engineer",
      workspaceId: "ws-1",
    }));
    const callArg = createContextPackage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof callArg["objective"]).toBe("string");
    expect(onContextPrepared).toHaveBeenCalledWith(contextResponse);
  });

  it("Prepare-context button disabled when role missing", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    // Set objective but no role
    const objectiveArea = container.querySelector<HTMLTextAreaElement>("#create-session-objective");
    await act(async () => {
      if (objectiveArea) {
        objectiveArea.value = "Some objective text";
        objectiveArea.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const prepareBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Prepare context",
    );
    expect(prepareBtn?.disabled).toBe(true);
  });

  it("Prepare-context button disabled when objective missing", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    // Set role but no objective
    const roleSelect = container.querySelector<HTMLSelectElement>("#create-session-role");
    await act(async () => {
      if (roleSelect) {
        roleSelect.value = "engineer";
        roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const prepareBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Prepare context",
    );
    expect(prepareBtn?.disabled).toBe(true);
  });

  it("Prepare-context button disabled when both role and objective missing", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const prepareBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Prepare context",
    );
    expect(prepareBtn?.disabled).toBe(true);
  });

  it("objective character counter shows count at boundary 0", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const counter = container.querySelector(".form-char-count");
    expect(counter?.textContent).toBe("0/4000");
  });

  it("objective character counter shows count at boundary 1", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const objectiveArea = container.querySelector<HTMLTextAreaElement>("#create-session-objective");
    await act(async () => {
      if (objectiveArea) setTextareaValue(objectiveArea, "x");
    });

    const counter = container.querySelector(".form-char-count");
    expect(counter?.textContent).toBe("1/4000");
  });

  it("objective character counter shows count at boundary 3999", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const objectiveArea = container.querySelector<HTMLTextAreaElement>("#create-session-objective");
    await act(async () => {
      if (objectiveArea) setTextareaValue(objectiveArea, "a".repeat(3999));
    });

    const counter = container.querySelector(".form-char-count");
    expect(counter?.textContent).toBe("3999/4000");
  });

  it("objective character counter shows count at boundary 4000", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const objectiveArea = container.querySelector<HTMLTextAreaElement>("#create-session-objective");
    await act(async () => {
      if (objectiveArea) setTextareaValue(objectiveArea, "a".repeat(4000));
    });

    const counter = container.querySelector(".form-char-count");
    expect(counter?.textContent).toBe("4000/4000");
  });

  it("role select renders all four ContextRole options", async () => {
    mockApi();
    const { CreateSessionDialog } = await import("../sessions/CreateSessionDialog");

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

    const roleSelect = container.querySelector<HTMLSelectElement>("#create-session-role");
    const optionValues = Array.from(roleSelect?.options ?? []).map((o) => o.value);
    expect(optionValues).toContain("architect");
    expect(optionValues).toContain("engineer");
    expect(optionValues).toContain("reviewer");
    expect(optionValues).toContain("generalist");
  });
});
