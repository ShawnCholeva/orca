import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type {
  SessionSummary,
  Task,
  TaskGeneration,
  TaskRole,
  TaskStatus,
  Workspace,
} from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

const workspace: Workspace = {
  id: "ws-1",
  path: "/tmp/repo",
  name: "repo",
  description: "",
  createdAt: now,
  updatedAt: now,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goalId: "goal-1",
    parentTaskId: null,
    workspaceId: "ws-1",
    role: "engineer" as TaskRole,
    status: "open" as TaskStatus,
    origin: "generator",
    title: "Implement task panel",
    description: "Render generated tasks in Goal detail.",
    acceptanceCriteria: [{ id: "ac-1", text: "Panel renders tasks" }],
    validationSteps: [{ id: "vs-1", text: "Run desktop tests", kind: "test" }],
    dependencies: [],
    sources: [{ type: "refinement", id: "ref-1" }],
    generationId: "gen-1",
    fingerprint: "task-fp-1",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

function makeGeneration(overrides: Partial<TaskGeneration> = {}): TaskGeneration {
  return {
    id: "gen-1",
    goalId: "goal-1",
    trigger: "manual",
    triggerSourceId: null,
    generatorId: "orca-task-generator",
    generatorVersion: "1.0.0",
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

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    goalId: "goal-1",
    workspaceId: "ws-1",
    adapterId: "claude-code",
    taskId: "task-1",
    fromRecommendationId: null,
    role: null,
    title: "Implementation session",
    status: "created",
    createdAt: now,
    startedAt: null,
    exitedAt: null,
    ...overrides,
  };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    listTasks: vi.fn().mockResolvedValue({ tasks: [], generations: [] }),
    generateTasks: vi.fn().mockResolvedValue({ generation: makeGeneration({ status: "running" }) }),
    patchTask: vi.fn().mockResolvedValue({ task: makeTask() }),
    splitTask: vi.fn().mockResolvedValue({
      parentTask: makeTask({ status: "blocked" }),
      childTasks: [makeTask({ id: "task-child", parentTaskId: "task-1" })],
    }),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    ...overrides,
  }));
}

describe("TasksPanel", () => {
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
    mockApi({ listTasks: vi.fn(() => new Promise(() => undefined)) });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    expect(container.querySelector(".tasks-panel-loading")).toBeTruthy();
    expect(container.textContent).toContain("Loading...");
  });

  it("renders empty state with generate CTA", async () => {
    mockApi({ listTasks: vi.fn().mockResolvedValue({ tasks: [], generations: [] }) });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    expect(container.querySelector(".tasks-panel-empty")).toBeTruthy();
    expect(container.textContent).toContain("No tasks yet.");
    expect(container.textContent).toContain("Generate tasks");
  });

  it("renders loaded task rows with badges and session count", async () => {
    const task = makeTask();
    mockApi({
      listTasks: vi.fn().mockResolvedValue({ tasks: [task], generations: [makeGeneration()] }),
      listSessions: vi.fn().mockResolvedValue({ sessions: [makeSession()] }),
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    expect(container.querySelectorAll(".task-row")).toHaveLength(1);
    expect(container.textContent).toContain("Implement task panel");
    expect(container.textContent).toContain("engineer");
    expect(container.textContent).toContain("open");
    expect(container.textContent).toContain("repo");
    expect(container.textContent).toContain("1 session");
    expect(container.textContent).toContain("1 source");
  });

  it("shows generating state from latest generation", async () => {
    mockApi({
      listTasks: vi.fn().mockResolvedValue({
        tasks: [],
        generations: [makeGeneration({ status: "running", finishedAt: null })],
      }),
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    expect(container.querySelector(".task-generation-banner--running")).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>(".tasks-generate-button")?.disabled).toBe(true);
  });

  it("shows failed generation state", async () => {
    mockApi({
      listTasks: vi.fn().mockResolvedValue({
        tasks: [],
        generations: [
          makeGeneration({
            status: "failed",
            failureCode: "internal_error",
            finishedAt: now,
          }),
        ],
      }),
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    expect(container.querySelector(".task-generation-banner--failed")).toBeTruthy();
    expect(container.textContent).toContain("failure: internal_error");
  });

  it("submits edit dialog patch", async () => {
    const patchTask = vi.fn().mockResolvedValue({ task: makeTask({ title: "Updated" }) });
    mockApi({
      listTasks: vi
        .fn()
        .mockResolvedValueOnce({ tasks: [makeTask()], generations: [] })
        .mockResolvedValue({ tasks: [makeTask({ title: "Updated" })], generations: [] }),
      patchTask,
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".task-row-menu-button")?.click();
    });
    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    await act(async () => {
      editButton?.click();
    });
    const saveButton = container.querySelector<HTMLButtonElement>(".task-edit-dialog button[type='submit']");
    await act(async () => {
      saveButton?.click();
    });

    expect(patchTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ title: "Implement task panel", status: "open" }),
    );
  });

  it("enforces edit dialog field caps before submit", async () => {
    const patchTask = vi.fn();
    mockApi({
      listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask()], generations: [] }),
      patchTask,
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".task-row-menu-button")?.click();
    });
    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    await act(async () => {
      editButton?.click();
    });

    const criteria = container.querySelector<HTMLTextAreaElement>("#task-criteria-task-1");
    await act(async () => {
      setControlValue(criteria!, Array.from({ length: 21 }, (_, i) => `criterion ${i}`).join("\n"));
    });

    const saveButton = container.querySelector<HTMLButtonElement>(".task-edit-dialog button[type='submit']");
    await act(async () => {
      saveButton?.click();
    });

    expect(container.textContent).toContain("Acceptance criteria must contain 20 items or fewer.");
    expect(patchTask).not.toHaveBeenCalled();
  });

  it("submits split dialog children", async () => {
    const splitTask = vi.fn().mockResolvedValue({
      parentTask: makeTask({ status: "blocked" }),
      childTasks: [makeTask({ id: "task-child", parentTaskId: "task-1" })],
    });
    mockApi({
      listTasks: vi.fn().mockResolvedValue({ tasks: [makeTask()], generations: [] }),
      splitTask,
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    await act(async () => {
      container.querySelector<HTMLElement>(".task-row-menu-button")?.click();
    });
    const splitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Split",
    );
    await act(async () => {
      splitButton?.click();
    });

    const titleInput = container.querySelector<HTMLInputElement>("#task-split-title-0");
    await act(async () => {
      setControlValue(titleInput!, "Child task");
    });

    const submitButton = container.querySelector<HTMLButtonElement>(".task-split-dialog button[type='submit']");
    await act(async () => {
      submitButton?.click();
    });

    expect(splitTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        setParentStatus: "blocked",
        children: [expect.objectContaining({ title: "Child task", role: "engineer" })],
      }),
    );
  });

  it("filters by status chip", async () => {
    mockApi({
      listTasks: vi.fn().mockResolvedValue({
        tasks: [
          makeTask({ id: "task-open", status: "open", title: "Open task" }),
          makeTask({ id: "task-done", status: "done", title: "Done task" }),
        ],
        generations: [],
      }),
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    const doneFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "done",
    );
    await act(async () => {
      doneFilter?.click();
    });

    expect(container.textContent).not.toContain("Open task");
    expect(container.textContent).toContain("Done task");
  });

  it("filters by role chip", async () => {
    mockApi({
      listTasks: vi.fn().mockResolvedValue({
        tasks: [
          makeTask({ id: "task-eng", role: "engineer", title: "Engineer task" }),
          makeTask({ id: "task-qa", role: "qa", title: "QA task" }),
        ],
        generations: [],
      }),
    });
    const { TasksPanel } = await import("./TasksPanel");

    await act(async () => {
      createRoot(container).render(<TasksPanel goalId="goal-1" workspaces={[workspace]} />);
    });

    const qaFilter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "qa",
    );
    await act(async () => {
      qaFilter?.click();
    });

    expect(container.textContent).not.toContain("Engineer task");
    expect(container.textContent).toContain("QA task");
  });
});

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
