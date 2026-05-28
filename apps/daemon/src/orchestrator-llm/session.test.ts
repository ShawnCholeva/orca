import { describe, expect, it, vi } from "vitest";
import { OrchestratorSessionManager } from "./session.js";

describe("OrchestratorSessionManager", () => {
  it("spawn returns a sessionId and registers it", async () => {
    const fakeAdapter = {
      resolveSpawn: vi.fn(async () => ({ command: "true", args: [], env: {}, cwd: "/" })),
    };
    const fakeRuntime = {
      spawnPty: vi.fn(async () => ({ sessionId: "orchsess-1" })),
      terminate: vi.fn(async () => {}),
      sendStdin: vi.fn(async () => {}),
    };
    const mgr = new OrchestratorSessionManager({ adapter: fakeAdapter as any, runtime: fakeRuntime as any });
    const id = await mgr.spawn({ goalId: "g1", adapterId: "claude-code", modelId: "claude-haiku-4-5" });
    expect(id).toBe("orchsess-1");
    expect(fakeRuntime.spawnPty).toHaveBeenCalledOnce();
  });

  it("invoke one_shot returns response text", async () => {
    const fakeOneShot = vi.fn(async () => ({ text: "hello" }));
    const mgr = new OrchestratorSessionManager({
      adapter: { resolveSpawn: vi.fn() } as any,
      runtime: {} as any,
      oneShotClient: { request: fakeOneShot } as any,
    });
    const out = await mgr.invokeOneShot({ adapterId: "codex", modelId: "gpt-x", systemPrompt: "s", userPrompt: "u" });
    expect(out.text).toBe("hello");
  });
});
