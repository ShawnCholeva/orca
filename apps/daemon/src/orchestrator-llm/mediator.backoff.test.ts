import { describe, expect, it, vi } from "vitest";
import { OrchestratorMediator } from "./mediator.js";

function makeMediator(llm: { request: ReturnType<typeof vi.fn> }) {
  return new OrchestratorMediator({
    llm: llm as never,
    buildContext: vi.fn(() => ({} as never)),
    composePrompt: vi.fn(() => ({ systemPrompt: "s", userPrompt: "u" })),
  });
}

const INPUT = {
  triggerKind: "user_message" as const,
  goalId: "g", runId: "r", stepRunId: "s",
  triggerPayload: { userMessage: "hi" },
  adapterId: "claude-code", modelId: "claude-haiku-4-5",
};

describe("invokeWithBackoff", () => {
  it("retries on failure then succeeds", async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ text: JSON.stringify({ kind: "answer_user_directly", body: "ok" }) });
    const mediator = makeMediator({ request });
    const p = mediator.invokeWithBackoff(INPUT);
    await vi.runAllTimersAsync();
    const action = await p;
    expect(action.kind).toBe("answer_user_directly");
    expect(request).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after 6 attempts (attempt 0..5) of persistent failure", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error("down"));
    const mediator = makeMediator({ request });
    const p = mediator.invokeWithBackoff(INPUT);
    const assertion = expect(p).rejects.toThrow(/down/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(request).toHaveBeenCalledTimes(6); // attempts 0,1,2,3,4,5
    vi.useRealTimers();
  });
});
