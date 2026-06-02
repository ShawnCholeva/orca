import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerAgentHookRoutes, type AgentResponseDonePayload } from "./routes.js";

const stubDeps = {
  onResponseDone: vi.fn(async () => undefined),
  resolveAdapterForSession: () => "claude-code",
  onWorkerQuestion: vi.fn(async () => "ANSWER REASON"),
};

describe("POST /v1/agent-hooks/response-done", () => {
  it("accepts payload and invokes mediator", async () => {
    const onResponseDone = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/response-done",
      payload: {
        sessionId: "sess-1",
        adapterId: "claude-code",
        responseText: "agent says hi",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(onResponseDone).toHaveBeenCalledWith({
      sessionId: "sess-1",
      adapterId: "claude-code",
      responseText: "agent says hi",
    });
  });

  it("rejects missing fields", async () => {
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone: vi.fn(), resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x" });
    const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/response-done", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

it("POST /v1/agent-hooks/stop maps last_assistant_message to a response-done call", async () => {
  const calls: AgentResponseDonePayload[] = [];
  const server = Fastify();
  registerAgentHookRoutes(server, {
    onResponseDone: async (p) => { calls.push(p); },
    resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x",
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/agent-hooks/stop?sessionId=sess-1",
    payload: { last_assistant_message: "all done" },
  });
  expect(res.statusCode).toBe(200);
  expect(calls[0]).toMatchObject({ sessionId: "sess-1", adapterId: "claude-code", responseText: "all done" });
});

it("POST /v1/agent-hooks/elicit returns deny with the assembled answer reason", async () => {
  const onWorkerQuestion = vi.fn(async () => "User answered via Orca chat. Q1 'H': A. ...");
  const server = Fastify();
  registerAgentHookRoutes(server, {
    onResponseDone: async () => undefined,
    resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion,
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/agent-hooks/elicit?sessionId=s1",
    payload: {
      tool_input: { questions: [
        { question: "Which approach?", header: "Choose approach", options: [{ label: "A", description: "Option A" }], multiSelect: false },
      ] },
      tool_use_id: "t1",
    },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(body.hookSpecificOutput.permissionDecisionReason).toContain("User answered");
  expect(onWorkerQuestion).toHaveBeenCalledWith("s1", {
    questions: [{ question: "Which approach?", header: "Choose approach", options: [{ label: "A", description: "Option A" }], multiSelect: false }],
    toolUseId: "t1",
  });
});

it("POST /v1/agent-hooks/elicit allows (no deny) when there is no question payload", async () => {
  const server = Fastify();
  registerAgentHookRoutes(server, { onResponseDone: async () => undefined, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x" });
  const res = await server.inject({ method: "POST", url: "/v1/agent-hooks/elicit?sessionId=s1", payload: { tool_input: { questions: [] } } });
  const body = JSON.parse(res.body) as { hookSpecificOutput: { permissionDecision: string } };
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
});
