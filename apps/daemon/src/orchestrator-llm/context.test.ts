import { describe, expect, it } from "vitest";
import { buildOrchestratorContext } from "./context.js";

describe("buildOrchestratorContext", () => {
  it("assembles goal + run + current step + conversation + prior artifacts", () => {
    const ctx = buildOrchestratorContext({
      goal: { id: "g1", title: "T", description: "D", attachedWorkspaces: [{ id: "w1", name: "main", root: "/x" }] },
      run: { templateId: "orca/engineering", templateVersion: 4, ordinal: 1, status: "active" },
      currentStep: {
        id: "research", instructions: "do research", outputSchema: [],
        agentAdapterId: "claude-code", executionMode: "shadow_session",
      },
      chatMessages: [{ role: "user", body: "hi", ts: "t0" }],
      currentStepAgentTurns: [{ role: "agent", body: "asking", ts: "t1" }],
      priorStepArtifacts: [{ stepId: "intake", outputJson: { problem: "X" } }],
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.goal.id).toBe("g1");
    expect(ctx.currentStep.id).toBe("research");
    expect(ctx.conversation.chatMessages).toHaveLength(1);
    expect(ctx.priorStepArtifacts).toHaveLength(1);
  });

  it("truncates oldest currentStepAgentTurns first when over budget", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: "agent" as const, body: "X".repeat(5000), ts: `t${i}` }));
    const ctx = buildOrchestratorContext({
      goal: { id: "g1", title: "T", description: "D", attachedWorkspaces: [] },
      run: { templateId: "orca/engineering", templateVersion: 4, ordinal: 1, status: "active" },
      currentStep: { id: "research", instructions: "x", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
      chatMessages: [],
      currentStepAgentTurns: turns,
      priorStepArtifacts: [],
      payloadBudgetBytes: 50_000,
    });
    expect(ctx.conversation.currentStepAgentTurns.length).toBeLessThan(20);
    expect(ctx.conversation.currentStepAgentTurns.at(-1)?.ts).toBe("t19");
  });
});
