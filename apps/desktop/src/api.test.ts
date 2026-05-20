import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedRefinementOutput, type AdapterId } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

type ApiModule = typeof import("./api");

const now = "2026-01-01T00:00:00.000Z";

const draft = GuidedRefinementOutput.parse({
  skillId: "guided-goal-refinement",
  title: "Ship M3",
  description: "Refine and attach workspace",
  successCriteria: ["detail view shows refinement"],
  constraints: ["deterministic only"],
  assumptions: ["local daemon available"],
});

const goal = {
  id: "goal-1",
  title: "Ship M3",
  description: "Refine and attach workspace",
  status: "active" as const,
  autonomyLevel: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const workspace = {
  id: "ws-1",
  goalId: "goal-1",
  path: "/tmp/workspace",
  name: "workspace",
  workspaceType: "folder" as const,
  branch: null,
  isDirty: null,
  gitProbe: "not_a_repo" as const,
  attachedAt: now,
};

const memoryItem = {
  id: "mem-1",
  goalId: "goal-1",
  type: "constraint" as const,
  status: "candidate" as const,
  content: "Use deterministic extraction only.",
  contentHash: "hash-1",
  confidence: 0.9,
  sourceType: "manual" as const,
  sourceId: null,
  sourceSessionId: null,
  sourceExtractionId: null,
  sourceOffsetFirst: null,
  sourceOffsetLast: null,
  createdAt: now,
  updatedAt: now,
  promotedAt: null,
  archivedAt: null,
};

const decision = {
  id: "dec-1",
  goalId: "goal-1",
  title: "Retry extraction manually",
  decisionText: "Use manual retry for failed extraction rows.",
  rationale: null,
  status: "proposed" as const,
  confirmationRequired: true,
  confidence: 0.8,
  sourceType: "manual" as const,
  sourceId: null,
  sourceSessionId: null,
  sourceExtractionId: null,
  sourceOffsetFirst: null,
  sourceOffsetLast: null,
  createdAt: now,
  updatedAt: now,
  confirmedAt: null,
  archivedAt: null,
};

const summary = {
  id: "sum-1",
  sessionId: "sess-1",
  goalId: "goal-1",
  extractionId: "ext-1",
  headline: "Session completed with one blocker",
  summaryText: "Build passed after retrying tests.",
  truncated: false,
  sourceOffsetFirst: 0,
  sourceOffsetLast: 120,
  createdAt: now,
};

const extraction = {
  id: "ext-1",
  goalId: "goal-1",
  sessionId: "sess-1",
  trigger: "manual" as const,
  status: "pending" as const,
  extractorVersion: "m5-deterministic-v1",
  sourceFingerprint: "fp-1",
  sourceOffsetFirst: 0,
  sourceOffsetLast: 120,
  summaryId: null,
  itemCount: 0,
  decisionCount: 0,
  promotedCount: 0,
  failureCode: null,
  failureMessage: null,
  requestedAt: now,
  startedAt: null,
  finishedAt: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desktop api client", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("createGoal accepts refined + workspaces and returns CreateGoalResponse", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { goal }));

    const response = await api.createGoal({
      title: "Ship M3",
      description: "Refine and attach workspace",
      refined: draft,
      workspaces: [{ inputPath: "/tmp/workspace", name: "workspace" }],
    });

    expect(response.goal.id).toBe("goal-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Ship M3",
      description: "Refine and attach workspace",
      refined: draft,
      workspaces: [{ inputPath: "/tmp/workspace", name: "workspace" }],
    });
  });

  it("refineGoal posts payload and returns draft", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { draft }));

    const response = await api.refineGoal({ title: "Ship M3", description: "desc" });

    expect(response.draft.skillId).toBe("guided-goal-refinement");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/refine");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Ship M3",
      description: "desc",
    });
  });

  it("getGoalDetail fetches goal detail", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        goal,
        refinement: {
          goalId: goal.id,
          skillId: "guided-goal-refinement",
          successCriteria: ["detail view shows refinement"],
          constraints: ["deterministic only"],
          assumptions: ["local daemon available"],
          refinedAt: now,
        },
        workspaces: [workspace],
      }),
    );

    const response = await api.getGoalDetail("goal-1");

    expect(response.goal.id).toBe("goal-1");
    expect(response.workspaces).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1");
    expect(init?.method).toBeUndefined();
  });

  it("inspectWorkspace returns preview", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        preview: {
          path: workspace.path,
          name: workspace.name,
          workspaceType: workspace.workspaceType,
          branch: workspace.branch,
          isDirty: workspace.isDirty,
          gitProbe: workspace.gitProbe,
        },
      }),
    );

    const response = await api.inspectWorkspace({ inputPath: "/tmp/workspace" });

    expect(response.preview.path).toBe("/tmp/workspace");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/workspaces/inspect");
    expect(init?.method).toBe("POST");
  });

  it("attachWorkspace posts request and returns workspace", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { workspace }));

    const response = await api.attachWorkspace("goal-1", {
      inputPath: "/tmp/workspace",
      name: "workspace",
    });

    expect(response.workspace.id).toBe("ws-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/workspaces");
    expect(init?.method).toBe("POST");
  });

  it("detachWorkspace issues DELETE and resolves void", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.detachWorkspace("goal-1", "ws-1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/workspaces/ws-1");
    expect(init?.method).toBe("DELETE");
  });

  it("maps structured 400 code into ApiError.code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: "invalid_input", message: "Title is required" },
      }),
    );

    await expect(api.refineGoal({ title: "x", description: "" })).rejects.toMatchObject({
      name: "ApiError",
      message: "Title is required",
      code: "invalid_input",
    });
  });

  it("returns ApiError for 401 unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));

    await expect(api.getGoalDetail("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "unauthorized",
      code: undefined,
    });
  });

  it("returns ApiError for 404", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "not_found", message: "Goal not found: goal-1" } }),
    );

    await expect(api.getGoalDetail("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "Goal not found: goal-1",
      code: "not_found",
    });
  });

  it("returns workspace_duplicate code on 409", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "workspace_duplicate", message: "Workspace already attached" },
      }),
    );

    await expect(
      api.attachWorkspace("goal-1", { inputPath: "/tmp/workspace", name: "workspace" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "workspace_duplicate",
    });
  });

  it("returns inspection_timeout code on 504", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(504, {
        error: { code: "inspection_timeout", message: "Inspection timed out" },
      }),
    );

    await expect(api.inspectWorkspace({ inputPath: "/tmp/workspace" })).rejects.toMatchObject({
      name: "ApiError",
      code: "inspection_timeout",
    });
  });

  it("listAdapters fetches adapter list", async () => {
    const adapters = [
      { id: "shell-manual" as AdapterId, title: "Shell / Manual", availability: "available" as const },
      { id: "claude-code" as AdapterId, title: "Claude Code", availability: "unavailable" as const, detail: "binary not found" },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { adapters }));

    const response = await api.listAdapters();

    expect(response.adapters).toHaveLength(2);
    expect(response.adapters[0]!.id).toBe("shell-manual");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/adapters");
    expect(init?.method).toBeUndefined();
  });

  it("listSessions fetches sessions for goal", async () => {
    const sessions = [
      {
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
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sessions }));

    const response = await api.listSessions("goal-1");

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]!.id).toBe("sess-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/sessions");
  });

  it("createSession posts to goal sessions endpoint", async () => {
    const session = {
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
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { session }));

    const response = await api.createSession("goal-1", {
      workspaceId: "ws-1",
      adapterId: "shell-manual",
    });

    expect(response.session.id).toBe("sess-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: "ws-1",
      adapterId: "shell-manual",
    });
  });

  it("startSession posts to session start endpoint", async () => {
    const session = {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "running" as const,
      createdAt: now,
      startedAt: now,
      exitedAt: null,
      instruction: null,
      pid: 1234,
      command: "/bin/sh",
      args: null,
      cwd: "/tmp",
      terminalCols: 80,
      terminalRows: 24,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { session }));

    const response = await api.startSession("sess-1", { terminalCols: 80, terminalRows: 24 });

    expect(response.session.status).toBe("running");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ terminalCols: 80, terminalRows: 24 });
  });

  it("stopSession posts to session stop endpoint", async () => {
    const session = {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "stopped" as const,
      createdAt: now,
      startedAt: now,
      exitedAt: now,
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
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { session }));

    const response = await api.stopSession("sess-1");

    expect(response.session.status).toBe("stopped");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/stop");
    expect(init?.method).toBe("POST");
  });

  it("listGoalMemory fetches and returns parsed items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [memoryItem] }));

    const response = await api.listGoalMemory("goal-1");

    expect(response).toHaveLength(1);
    expect(response[0]!.id).toBe("mem-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory");
  });

  it("listGoalMemory includes archived filter when requested", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [memoryItem] }));

    await api.listGoalMemory("goal-1", { includeArchived: true });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory?includeArchived=1");
  });

  it("listGoalMemory throws on unexpected response shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "missing-fields" }] }));

    await expect(api.listGoalMemory("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "Response validation failed",
    });
  });

  it("createGoalMemory posts and returns created item", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { item: memoryItem }));

    const response = await api.createGoalMemory("goal-1", {
      type: "constraint",
      content: "Use deterministic extraction only.",
      confidence: 0.9,
    });

    expect(response.id).toBe("mem-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory");
    expect(init?.method).toBe("POST");
  });

  it("patchMemoryItem patches and returns item", async () => {
    const promoted = { ...memoryItem, status: "promoted" as const, promotedAt: now, updatedAt: now };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item: promoted }));

    const response = await api.patchMemoryItem("mem-1", { status: "promoted" });

    expect(response.status).toBe("promoted");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/memory/mem-1");
    expect(init?.method).toBe("PATCH");
  });

  it("listGoalDecisions fetches and returns parsed items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [decision] }));

    const response = await api.listGoalDecisions("goal-1");

    expect(response).toHaveLength(1);
    expect(response[0]!.id).toBe("dec-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/decisions");
  });

  it("createGoalDecision posts and returns created item", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { item: decision }));

    const response = await api.createGoalDecision("goal-1", {
      title: "Retry extraction manually",
      decisionText: "Use manual retry for failed extraction rows.",
      confirmationRequired: true,
    });

    expect(response.id).toBe("dec-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/decisions");
    expect(init?.method).toBe("POST");
  });

  it("patchDecision patches and returns item", async () => {
    const confirmed = { ...decision, status: "confirmed" as const, confirmedAt: now, updatedAt: now };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item: confirmed }));

    const response = await api.patchDecision("dec-1", { status: "confirmed" });

    expect(response.status).toBe("confirmed");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/decisions/dec-1");
    expect(init?.method).toBe("PATCH");
  });

  it("getSessionSummary returns parsed summary", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { summary }));

    const response = await api.getSessionSummary("sess-1");

    expect(response?.id).toBe("sum-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/summary");
  });

  it("getSessionSummary returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "summary_not_found", message: "No summary found" } }),
    );

    await expect(api.getSessionSummary("sess-1")).resolves.toBeNull();
  });

  it("extractSessionMemory parses created and existing extraction responses", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { extraction }))
      .mockResolvedValueOnce(jsonResponse(200, { extraction }));

    const first = await api.extractSessionMemory("sess-1");
    const second = await api.extractSessionMemory("sess-1");

    expect(first.id).toBe("ext-1");
    expect(second.id).toBe("ext-1");
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!;
    expect(firstUrl).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/extract-memory");
    expect(firstInit?.method).toBe("POST");
    expect(firstInit?.body).toBe("{}");
  });

  it("extractSessionMemory surfaces structured 409 errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "session_not_terminal", message: "Session is not terminal" },
      }),
    );

    await expect(api.extractSessionMemory("sess-1")).rejects.toMatchObject({
      name: "ApiError",
      code: "session_not_terminal",
    });
  });

  it("createSession rejects with ApiError on 422", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: { code: "workspace_unavailable", message: "Workspace path not accessible" },
      }),
    );

    await expect(
      api.createSession("goal-1", { workspaceId: "ws-1", adapterId: "shell-manual" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "workspace_unavailable",
    });
  });
});
