import { describe, expect, it } from "vitest";
import { composeOrchestratorPrompt, composeAgentInitialPrompt } from "./prompts.js";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

describe("composeAgentInitialPrompt", () => {
  it("includes the goal, step instructions, outputSchema, and orca-output convention", () => {
    const out = composeAgentInitialPrompt({
      goalTitle: "Add dark mode",
      goalDescription: "Users want a dark theme toggle in settings.",
      stepInstructions: "Interview the user.",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      priorStepArtifacts: [],
    });
    expect(out).toMatch(/Add dark mode/);
    expect(out).toMatch(/dark theme toggle/);
    expect(out).toMatch(/Interview the user\./);
    expect(out).toMatch(/orca:step-complete/);
    expect(out).toMatch(/problem.*string/);
  });

  it("includes bounded prior step artifacts", () => {
    const out = composeAgentInitialPrompt({
      goalTitle: "G",
      goalDescription: "D",
      stepInstructions: "Research.",
      outputSchema: [],
      priorStepArtifacts: [{ stepId: "intake", outputJson: { problem: "P", success_outcome: "O" } }],
    });
    expect(out).toMatch(/intake/);
    expect(out).toMatch(/problem/);
  });

  it("handles an empty goal description without a dangling header", () => {
    const out = composeAgentInitialPrompt({
      goalTitle: "Just a title",
      goalDescription: "",
      stepInstructions: "Do it.",
      outputSchema: [],
      priorStepArtifacts: [],
    });
    expect(out).toMatch(/Just a title/);
  });
});

describe("composeOrchestratorPrompt", () => {
  it("instructs the model to include a scoring object on approval", () => {
    const sys = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    }).systemPrompt;
    expect(sys).toContain("approve_step_complete");
    expect(sys).toContain("scoring");
    expect(sys).toContain("successScore");
    expect(sys).toContain("riskLevel");
  });

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
