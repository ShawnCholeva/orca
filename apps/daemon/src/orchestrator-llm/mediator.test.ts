import { describe, expect, it, vi } from "vitest";
import { OrchestratorMediator } from "./mediator.js";

describe("OrchestratorMediator.invoke", () => {
  it("returns parsed OrchestratorAction from LLM", async () => {
    const fakeLlm = { request: vi.fn(async () => ({ text: JSON.stringify({ kind: "approve_step_complete" }) })) };
    const mediator = new OrchestratorMediator({
      llm: fakeLlm as any,
      buildContext: vi.fn(() => ({ goal: {}, workflowRun: {}, currentStep: {}, conversation: { chatMessages: [], currentStepAgentTurns: [] }, priorStepArtifacts: [] } as any)),
      composePrompt: vi.fn((i) => ({ systemPrompt: "s", userPrompt: "u" })),
    });
    const action = await mediator.invoke({
      triggerKind: "agent_response",
      goalId: "g1",
      runId: "r1",
      stepRunId: "s1",
      triggerPayload: { agentResponseText: "x", agentStepCompleteBlock: {} },
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
    });
    expect(action.kind).toBe("approve_step_complete");
  });

  it("retries once on parse failure", async () => {
    const fakeLlm = {
      request: vi.fn()
        .mockResolvedValueOnce({ text: "not-json" })
        .mockResolvedValueOnce({ text: JSON.stringify({ kind: "paraphrase_agent_message", body: "hi" }) }),
    };
    const mediator = new OrchestratorMediator({
      llm: fakeLlm as any,
      buildContext: vi.fn(() => ({} as any)),
      composePrompt: vi.fn(() => ({ systemPrompt: "s", userPrompt: "u" })),
    });
    const action = await mediator.invoke({
      triggerKind: "agent_response",
      goalId: "g1", runId: "r1", stepRunId: "s1",
      triggerPayload: { agentResponseText: "x" },
      adapterId: "claude-code", modelId: "claude-haiku-4-5",
    });
    expect(action.kind).toBe("paraphrase_agent_message");
    expect(fakeLlm.request).toHaveBeenCalledTimes(2);
  });
});
