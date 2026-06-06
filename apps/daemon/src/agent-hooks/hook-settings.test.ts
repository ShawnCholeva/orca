import { describe, expect, it } from "vitest";
import { agentHookUrl, buildAgentHookSettings, permissionHookUrl, toolUseHookUrl } from "./hook-settings.js";

describe("agent hook settings", () => {
  it("builds a session-scoped Stop hook URL", () => {
    expect(agentHookUrl(8787, "sess-1", false)).toBe(
      "http://127.0.0.1:8787/v1/agent-hooks/stop?sessionId=sess-1"
    );
    expect(agentHookUrl(8787, "sess-1", true)).toBe(
      "http://127.0.0.1:8787/v1/agent-hooks/stop?sessionId=sess-1&failure=1"
    );
  });

  it("embeds Stop + StopFailure http hooks with bearer auth", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    expect(s.hooks.Stop[0]!.hooks[0]!.headers).toEqual({ Authorization: "Bearer tok" });
    expect(s.hooks.Stop[0]!.hooks[0]!.url).toContain("sessionId=sess-1");
    expect(s.hooks.StopFailure[0]!.hooks[0]!.url).toContain("failure=1");
  });

  it("includes a PreToolUse AskUserQuestion http hook pointing at /elicit", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    const pre = s.hooks.PreToolUse!;
    expect(pre[0]!.matcher).toBe("AskUserQuestion");
    expect(pre[0]!.hooks[0]!.url).toContain("/v1/agent-hooks/elicit?sessionId=sess-1");
    expect(pre[0]!.hooks[0]!.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("still includes Stop and StopFailure hooks", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    expect(s.hooks.Stop[0]!.hooks[0]!.url).toContain("/v1/agent-hooks/stop");
    expect(s.hooks.StopFailure[0]!.hooks[0]!.url).toContain("failure=1");
  });

  it("PreToolUse AskUserQuestion hook has a long timeout for human response", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    const pre = s.hooks.PreToolUse!;
    expect(pre[0]!.hooks[0]!.timeout).toBe(600);
  });

  it("toolUseHookUrl points at the tool-use endpoint with the session id", () => {
    expect(toolUseHookUrl(8787, "sess-1")).toBe(
      "http://127.0.0.1:8787/v1/agent-hooks/tool-use?sessionId=sess-1"
    );
  });

  it("includes a non-blocking catch-all PreToolUse hook without replacing AskUserQuestion", () => {
    const s = buildAgentHookSettings({ sessionId: "sess-1", port: 8787, authToken: "tok" });
    const pre = s.hooks.PreToolUse!;
    const toolUse = pre.find((entry) => entry.matcher === "*");

    expect(pre.some((entry) => entry.matcher === "AskUserQuestion")).toBe(true);
    expect(toolUse?.hooks[0]).toEqual({
      type: "http",
      url: "http://127.0.0.1:8787/v1/agent-hooks/tool-use?sessionId=sess-1",
      headers: { Authorization: "Bearer tok" },
      timeout: 5,
    });
  });
});

describe("permission hook settings", () => {
  it("permissionHookUrl points at the permission endpoint with the session id", () => {
    expect(permissionHookUrl(1234, "s1")).toBe("http://127.0.0.1:1234/v1/agent-hooks/permission?sessionId=s1");
  });

  it("worker hook settings include a catch-all PermissionRequest hook", () => {
    const s = buildAgentHookSettings({ sessionId: "s1", port: 1234, authToken: "tok" });
    const pr = s.hooks.PermissionRequest;
    expect(pr).toBeDefined();
    expect(pr![0].matcher).toBe("*");
    expect(pr![0].hooks[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:1234/v1/agent-hooks/permission?sessionId=s1",
    });
    expect(pr![0].hooks[0].timeout).toBeGreaterThanOrEqual(600);
  });
});
