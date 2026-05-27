import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerGoalBootstrapRoute, type GoalBootstrapRouteDeps } from "./bootstrap-route.js";

function makeDeps(overrides: Partial<GoalBootstrapRouteDeps> = {}): GoalBootstrapRouteDeps {
  return {
    createGoalFn: vi.fn().mockResolvedValue({ id: "goal-1" }),
    startWorkflowRunFn: vi.fn().mockReturnValue({ id: "run-1", goalId: "goal-1" }),
    requestNextDecisionFn: vi.fn().mockResolvedValue({ queued: true }),
    ...overrides,
  };
}

async function buildServer(deps: GoalBootstrapRouteDeps) {
  const server = Fastify();
  registerGoalBootstrapRoute(server, deps);
  await server.ready();
  return server;
}

const VALID_BODY = {
  title: "My Goal",
  workflowTemplateId: "orca/engineering",
};

describe("POST /v1/goals/create-and-start-workflow", () => {
  it("returns 201 with ok:true on full success", async () => {
    const server = await buildServer(makeDeps());
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; goalId: string; workflowRunId: string };
    expect(body.ok).toBe(true);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBe("run-1");
  });

  it("returns 400 on validation failure (missing workflowTemplateId)", async () => {
    const server = await buildServer(makeDeps());
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: { title: "Missing template" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with ok:false + phase startWorkflowRun when startWorkflowRun throws", async () => {
    const deps = makeDeps({
      startWorkflowRunFn: vi.fn().mockImplementation(() => {
        throw new Error("template not found");
      }),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      goalId: string;
      workflowRunId?: string;
      bootstrapError: { phase: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBeUndefined();
    expect(body.bootstrapError.phase).toBe("startWorkflowRun");
  });

  it("returns 201 with ok:false + phase requestDecision when requestNextDecision throws", async () => {
    const deps = makeDeps({
      requestNextDecisionFn: vi.fn().mockRejectedValue(new Error("orchestrator error")),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      goalId: string;
      workflowRunId: string;
      bootstrapError: { phase: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBe("run-1");
    expect(body.bootstrapError.phase).toBe("requestDecision");
  });

  it("propagates createGoal validation errors as 400", async () => {
    const { ValidationError } = await import("../goals.js");
    const deps = makeDeps({
      createGoalFn: vi.fn().mockRejectedValue(
        new ValidationError([{ code: "custom", message: "bad title", path: ["title"] }])
      ),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
  });
});
