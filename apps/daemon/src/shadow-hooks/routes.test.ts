import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerShadowHookRoutes } from "./routes.js";

function app(resolvePending: any) {
  const f = Fastify();
  registerShadowHookRoutes(f, { resolvePending });
  return f;
}

describe("POST /v1/shadow-hooks/stop", () => {
  it("resolves the goal's pending ask with last_assistant_message", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    const res = await f.inject({
      method: "POST",
      url: "/v1/shadow-hooks/stop?goalId=G1",
      payload: { session_id: "s1", last_assistant_message: "```orca:action\n{\"k\":1}\n```" },
    });
    expect(res.statusCode).toBe(200);
    expect(resolvePending).toHaveBeenCalledWith("G1", { text: "```orca:action\n{\"k\":1}\n```", failure: false });
  });

  it("failure=1 marks failure", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    await f.inject({ method: "POST", url: "/v1/shadow-hooks/stop?goalId=G1&failure=1", payload: { session_id: "s1" } });
    expect(resolvePending).toHaveBeenCalledWith("G1", { text: "", failure: true });
  });

  it("passes hook failure text through to resolvePending", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    const res = await f.inject({
      method: "POST",
      url: "/v1/shadow-hooks/stop?goalId=g1&failure=1",
      payload: { last_assistant_message: "quota exceeded" },
    });
    expect(res.statusCode).toBe(200);
    expect(resolvePending).toHaveBeenCalledWith("g1", { text: "quota exceeded", failure: true });
  });

  it("missing goalId -> 200 no-op (drops stray hook)", async () => {
    const resolvePending = vi.fn();
    const f = app(resolvePending);
    const res = await f.inject({ method: "POST", url: "/v1/shadow-hooks/stop", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
