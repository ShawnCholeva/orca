import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerAgentHookRoutes, type AgentResponseDonePayload } from "./routes.js";

const stubDeps = {
  onResponseDone: vi.fn(async () => undefined),
  resolveAdapterForSession: () => "claude-code",
  onWorkerQuestion: vi.fn(async () => "ANSWER REASON"),
  onPermissionRequest: vi.fn(async () => "deny" as const),
  onToolUse: vi.fn(async () => undefined),
  onToolGate: vi.fn(async () => null),
};

describe("POST /v1/agent-hooks/tool-gate", () => {
  const app = (onToolGate: (s: string, p: { toolName: string; toolInput: unknown }) => Promise<string | null>) => {
    const server = Fastify();
    registerAgentHookRoutes(server, { ...stubDeps, onToolGate });
    return server;
  };

  it("denies with the policy reason when the step forbids workspace writes", async () => {
    const res = await app(async () => "The Research step is read-only.").inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-gate?sessionId=s1",
      payload: { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } },
    });
    expect(res.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "The Research step is read-only.",
      },
    });
  });

  it("stays silent when the policy has no opinion, so normal permissions still apply", async () => {
    // Returning permissionDecision:"allow" here would AUTO-APPROVE every edit and
    // bypass the approval flow entirely. Silence is the only safe fall-through.
    const res = await app(async () => null).inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-gate?sessionId=s1",
      payload: { tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } },
    });
    expect(res.json()).toEqual({ continue: true });
    expect(JSON.stringify(res.json())).not.toContain("allow");
  });

  it("has no opinion when the session cannot be attributed", async () => {
    const onToolGate = vi.fn(async () => "denied");
    const res = await app(onToolGate).inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-gate",
      payload: { tool_name: "Write", tool_input: {} },
    });
    expect(res.json()).toEqual({ continue: true });
    expect(onToolGate).not.toHaveBeenCalled();
  });
});

describe("POST /v1/agent-hooks/response-done", () => {
  it("accepts payload and invokes mediator", async () => {
    const onResponseDone = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny", onToolUse: async () => undefined, onToolGate: async () => null });
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
    registerAgentHookRoutes(app, { onResponseDone: vi.fn(), resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny", onToolUse: async () => undefined, onToolGate: async () => null });
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
    onToolUse: async () => undefined,
    onToolGate: async () => null,
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
    onToolUse: async () => undefined,
    onToolGate: async () => null,
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
  registerAgentHookRoutes(server, { onResponseDone: async () => undefined, resolveAdapterForSession: () => "claude-code", onWorkerQuestion: async () => "x", onPermissionRequest: async () => "deny", onToolUse: async () => undefined, onToolGate: async () => null });
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
    onToolUse: async () => undefined,
    onToolGate: async () => null,
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
    onToolUse: async () => undefined,
    onToolGate: async () => null,
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
    onToolUse: async () => undefined,
    onToolGate: async () => null,
  });
  const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/permission",
    payload: { tool_name: "Bash", tool_input: {}, tool_use_id: "t3" } });
  expect(res.json().hookSpecificOutput.decision.behavior).toBe("deny");
  expect(onPermissionRequest).not.toHaveBeenCalled();
});

describe("POST /v1/agent-hooks/tool-use", () => {
  it("observes tool use and returns an exact non-blocking response", async () => {
    const onToolUse = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { ...stubDeps, onToolUse });

    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-use?sessionId=s1",
      payload: {
        session_id: "claude-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp/project",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "t1",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(onToolUse).toHaveBeenCalledWith("s1", {
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "t1",
      transcriptPath: "/tmp/transcript.jsonl",
    });
    expect(res.json()).toEqual({ continue: true });
    expect(res.body).not.toContain("permissionDecision");
    expect(res.body).not.toContain("decision");
    expect(res.body).not.toContain("behavior");
  });

  it("accepts additional Claude metadata without forwarding it", async () => {
    const onToolUse = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { ...stubDeps, onToolUse });

    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-use?sessionId=s1",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "claude-session",
        effort: { level: "high" },
        agent_id: "agent-1",
        agent_type: "general-purpose",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_use_id: "t-extra",
      },
    });

    expect({
      statusCode: res.statusCode,
      callbackCalls: onToolUse.mock.calls.length,
    }).toEqual({
      statusCode: 200,
      callbackCalls: 1,
    });
    expect(onToolUse).toHaveBeenCalledWith("s1", {
      toolName: "Bash",
      toolInput: { command: "pwd" },
      toolUseId: "t-extra",
    });
    expect(res.json()).toEqual({ continue: true });
  });

  it("ignores AskUserQuestion while continuing tool execution", async () => {
    const onToolUse = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { ...stubDeps, onToolUse });

    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-use?sessionId=s1",
      payload: { tool_name: "AskUserQuestion", tool_input: { questions: [] }, tool_use_id: "t2" },
    });

    expect(res.statusCode).toBe(200);
    expect(onToolUse).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ continue: true });
  });

  it("rejects a missing tool name with the standard validation error shape", async () => {
    const app = Fastify();
    registerAgentHookRoutes(app, stubDeps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-use?sessionId=s1",
      payload: { tool_input: {}, tool_use_id: "t3" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: "validation_failed",
        issues: expect.any(Array),
      },
    });
    expect(stubDeps.onToolUse).not.toHaveBeenCalled();
  });
});
