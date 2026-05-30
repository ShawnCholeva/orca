import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerAgentHookRoutes, type AgentResponseDonePayload } from "./routes.js";

describe("POST /v1/agent-hooks/response-done", () => {
  it("accepts payload and invokes mediator", async () => {
    const onResponseDone = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone, resolveAdapterForSession: () => "claude-code" });
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
    registerAgentHookRoutes(app, { onResponseDone: vi.fn(), resolveAdapterForSession: () => "claude-code" });
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
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/agent-hooks/stop?sessionId=sess-1",
    payload: { last_assistant_message: "all done" },
  });
  expect(res.statusCode).toBe(200);
  expect(calls[0]).toMatchObject({ sessionId: "sess-1", adapterId: "claude-code", responseText: "all done" });
});
