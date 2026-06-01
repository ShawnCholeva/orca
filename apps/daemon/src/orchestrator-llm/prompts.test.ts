import { describe, expect, it } from "vitest";
import { composeOrchestratorPrompt, composeAgentInitialPrompt } from "./prompts.js";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

describe("composeAgentInitialPrompt", () => {
  it("includes step instructions, outputSchema, and orca-output convention", () => {
    const out = composeAgentInitialPrompt({
      stepInstructions: "Interview the user.",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      priorStepArtifacts: [],
    });
    expect(out).toMatch(/Interview the user\./);
    expect(out).toMatch(/orca:step-complete/);
    expect(out).toMatch(/problem.*string/);
  });

  it("includes bounded prior step artifacts", () => {
    const out = composeAgentInitialPrompt({
      stepInstructions: "Research.",
      outputSchema: [],
      priorStepArtifacts: [{ stepId: "intake", outputJson: { problem: "P", success_outcome: "O" } }],
    });
    expect(out).toMatch(/intake/);
    expect(out).toMatch(/problem/);
  });
});

describe("composeOrchestratorPrompt", () => {
  it("describes role and produces a structured response shape request", () => {
    const out = composeOrchestratorPrompt({
      triggerKind: "agent_response",
    } as any);
    expect(out.systemPrompt).toMatch(/orchestrator/i);
    expect(out.userPrompt).toMatch(/agent_response/);
  });

  it("system prompt includes the orca:action sentinel instruction", () => {
    const p = composeOrchestratorPrompt({
      triggerKind: "user_message",
      context: {
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
        currentStep: { id: "", instructions: "", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      },
      triggerPayload: { userMessage: "hi" },
    });
    expect(p.systemPrompt).toContain(SENTINEL_INSTRUCTION);
  });

  it("tells the mediator to answer greetings and meta chat directly", () => {
    const p = composeOrchestratorPrompt({
      triggerKind: "user_message",
      context: {
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
        currentStep: { id: "intake", instructions: "", outputSchema: [], agentAdapterId: "codex", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      },
      triggerPayload: { userMessage: "hi" },
    });
    expect(p.systemPrompt).toMatch(/answer simple greetings/i);
    expect(p.systemPrompt).toMatch(/Only use forward_to_agent/i);
  });

  it("specifies the exact OrchestratorAction shape: 'kind' discriminator and per-kind fields", () => {
    const out = composeOrchestratorPrompt({ triggerKind: "user_message" } as any);
    // Discriminator must be named exactly "kind" (model previously guessed "action").
    expect(out.systemPrompt).toMatch(/"kind"/);
    // answer_user_directly / paraphrase / escalate carry "body" (model previously guessed "message").
    expect(out.systemPrompt).toMatch(/"body"/);
    expect(out.systemPrompt).toMatch(/forward_to_agent[^]*"translated"/);
    expect(out.systemPrompt).toMatch(/revise_step[^]*"feedback"/);
  });
});
