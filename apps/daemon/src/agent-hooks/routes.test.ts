import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerAgentHookRoutes, type AgentResponseDonePayload } from "./routes.js";

const stubDeps = {
  onResponseDone: vi.fn(async () => undefined),
  resolveAdapterForSession: () => "claude-code",
  onWorkerQuestion: vi.fn(async () => "ANSWER REASON"),
  onPermissionRequest: vi.fn(async () => "deny" as const),
};

describe("POST /v1/agent-hooks/response-done", () => {
  it("accepts payload and invokes mediator", async () => {
    const onResponseDone = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny" });
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
    registerAgentHookRoutes(app, { onResponseDone: vi.fn(), resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny" });
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
    onPermissionRequest: async () => "deny",
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
    onPermissionRequest: async () => "deny",
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
  registerAgentHookRoutes(server, { onResponseDone: async () => undefined, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny" });
  const res = await server.inject({ method: "POST", url: "/v1/agent-hooks/elicit?sessionId=s1", payload: { tool_input: { questions: [] } } });
  const body = JSON.parse(res.body) as { hookSpecificOutput: { permissionDecision: string } };
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
});

it("permission route returns allow when onPermissionRequest resolves allow", async () => {
  const app = Fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x",
    onPermissionRequest: async () => "allow",
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
});

it("permission route returns deny when onPermissionRequest resolves deny", async () => {
  const app = Fastify();
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x",
    onPermissionRequest: async () => "deny",
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "t2" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("deny");
});

it("permission route denies (safe default) when sessionId is missing, without calling onPermissionRequest", async () => {
  const app = Fastify();
  const onPermissionRequest = vi.fn(async () => "allow" as const);
  registerAgentHookRoutes(app, {
    onResponseDone: async () => {}, resolveAdapterForSession: () => "claude-code",
    onWorkerQuestion: async () => "x", onPermissionRequest,
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission",
    payload: { tool_name: "Bash", tool_input: {}, tool_use_id: "t3" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("deny");
  expect(onPermissionRequest).not.toHaveBeenCalled();
});
