import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedRefinementOutput } from "@orca/contracts";

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
});
