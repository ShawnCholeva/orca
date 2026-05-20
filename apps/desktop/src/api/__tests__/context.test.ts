import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContextAssembly,
  ContextPackage,
  CreateContextPackageResponse,
  GetContextPackageResponse,
  ListContextPackagesResponse,
} from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

type ContextApiModule = typeof import("../context");
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _CreateTypeMatches = Assert<
  Equal<
    Awaited<ReturnType<ContextApiModule["createContextPackage"]>>,
    CreateContextPackageResponse
  >
>;
type _ListTypeMatches = Assert<
  Equal<
    Awaited<ReturnType<ContextApiModule["listContextPackages"]>>,
    ListContextPackagesResponse
  >
>;
type _GetTypeMatches = Assert<
  Equal<
    Awaited<ReturnType<ContextApiModule["getContextPackage"]>>,
    GetContextPackageResponse
  >
>;

const now = "2026-01-01T00:00:00.000Z";

const pkg: ContextPackage = {
  id: "pkg-1",
  goalId: "goal-1",
  supersedesPackageId: null,
  adapterId: "shell-manual",
  workspaceId: "ws-1",
  role: "engineer",
  objective: "Summarize goal context before session start",
  status: "ready",
  renderedContext: "## Goal\nShip milestone 6 safely.\n",
  renderedBytes: 34,
  estimatedTokens: 9,
  truncated: false,
  sparse: false,
  sourceCount: 2,
  sources: [
    {
      type: "goal",
      id: "goal-1",
      sourceSessionId: null,
      label: "Goal",
      reason: "required",
      marker: "[S1]",
    },
    {
      type: "memory_item",
      id: "mem-1",
      sourceSessionId: null,
      label: "Constraint",
      reason: "high_confidence",
      marker: "[S2]",
    },
  ],
  warnings: ["no_sibling_summaries"],
  sourceFingerprint: "source-fp-1",
  assemblerVersion: "m6-deterministic-v1",
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
  objectiveHash: "obj-hash-1",
  sourceFingerprint: "source-fp-1",
  assemblerVersion: "m6-deterministic-v1",
  requestFingerprint: "req-fp-1",
  status: "succeeded",
  trigger: "prepare",
  failureCode: null,
  failureMessage: null,
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("context api wrappers", () => {
  let api: ContextApiModule;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("../context");
  });

  it("createContextPackage posts payload and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { package: pkg, assembly, reused: false }));

    const response = await api.createContextPackage("goal-1", {
      adapterId: "shell-manual",
      workspaceId: "ws-1",
      role: "engineer",
      objective: "Summarize goal context before session start",
    });

    expect(response.package?.id).toBe("pkg-1");
    expect(response.assembly.status).toBe("succeeded");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/context-packages");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      adapterId: "shell-manual",
      workspaceId: "ws-1",
      role: "engineer",
      objective: "Summarize goal context before session start",
    });
  });

  it("listContextPackages serializes query and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { packages: [pkg], assemblies: [assembly] }));

    const response = await api.listContextPackages("goal-1", {
      sessionId: "sess-1",
      adapterId: "shell-manual",
      limit: 5,
    });

    expect(response.packages).toHaveLength(1);
    expect(response.assemblies).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.pathname).toBe("/v1/goals/goal-1/context-packages");
    expect(parsedUrl.searchParams.get("sessionId")).toBe("sess-1");
    expect(parsedUrl.searchParams.get("adapterId")).toBe("shell-manual");
    expect(parsedUrl.searchParams.get("limit")).toBe("5");
    expect(init?.method).toBeUndefined();
  });

  it("getContextPackage fetches package detail and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { package: pkg }));

    const response = await api.getContextPackage("pkg-1");

    expect(response.package.id).toBe("pkg-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/context-packages/pkg-1");
  });

  it("propagates structured API error code/message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "goal_archived", message: "Goal is archived: goal-1" },
      }),
    );

    await expect(
      api.createContextPackage("goal-1", {
        adapterId: "shell-manual",
        role: "engineer",
        objective: "assemble",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "goal_archived",
      message: "Goal is archived: goal-1",
    });
  });

  it("propagates string error payloads", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: "validation_failed",
        issues: [],
      }),
    );

    await expect(
      api.listContextPackages("goal-1", {
        limit: 1,
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "validation_failed",
    });
  });
});
