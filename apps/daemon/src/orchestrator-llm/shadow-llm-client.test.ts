import { describe, it, expect } from "vitest";
import { ShadowSessionLlmClient } from "./shadow-llm-client.js";

describe("ShadowSessionLlmClient", () => {
  it("delegates request() to the manager's ask() keyed by goalId", async () => {
    const calls: any[] = [];
    const fakeManager = {
      ask: async (goalId: string, input: any) => {
        calls.push({ goalId, input });
        return { text: '{"kind":"answer_user_directly","body":"ok"}' };
      },
    };
    const client = new ShadowSessionLlmClient(fakeManager as any, { timeoutMs: 5000 });
    const res = await client.request({
      goalId: "G1",
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
      systemPrompt: "SYS",
      userPrompt: "USR",
    });
    expect(res.text).toContain("answer_user_directly");
    expect(calls[0].goalId).toBe("G1");
    expect(calls[0].input.timeoutMs).toBe(5000);
    expect(calls[0].input.adapterId).toBe("claude-code");
    expect(calls[0].input.systemPrompt).toBe("SYS");
    expect(calls[0].input.userPrompt).toBe("USR");
  });

  it("passes codex adapter id through to the manager", async () => {
    const calls: any[] = [];
    const fakeManager = {
      ask: async (goalId: string, input: any) => {
        calls.push({ goalId, input });
        return { text: '{"kind":"answer_user_directly","body":"ok"}' };
      },
    };
    const client = new ShadowSessionLlmClient(fakeManager as any, { timeoutMs: 5000 });
    await client.request({
      goalId: "G1",
      adapterId: "codex",
      modelId: "gpt-5.4-mini",
      systemPrompt: "SYS",
      userPrompt: "USR",
    });
    expect(calls[0].input.adapterId).toBe("codex");
  });

  it("passes antigravity adapter id through to the manager", async () => {
    const calls: any[] = [];
    const fakeManager = {
      ask: async (goalId: string, input: any) => {
        calls.push({ goalId, input });
        return { text: '{"kind":"answer_user_directly","body":"ok"}' };
      },
    };
    const client = new ShadowSessionLlmClient(fakeManager as any, { timeoutMs: 5000 });
    await client.request({
      goalId: "G1",
      adapterId: "antigravity",
      modelId: "gemini-3.5-flash",
      systemPrompt: "SYS",
      userPrompt: "USR",
    });
    expect(calls[0].input.adapterId).toBe("antigravity");
  });
});
