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

  it("renders a Workspaces section when workspaces are provided", () => {
    const prompt = composeAgentInitialPrompt({
      goalTitle: "G",
      goalDescription: "",
      stepInstructions: "do it",
      outputSchema: [{ key: "summary", type: "string", required: true }],
      priorStepArtifacts: [],
      workspaces: [{ name: "api", root: "/repos/api" }, { name: "web", root: "/repos/web" }],
    });
    expect(prompt).toMatch(/# Workspaces/);
    expect(prompt).toMatch(/api/);
    expect(prompt).toMatch(/\/repos\/web/);
  });

  it("omits the Workspaces section when none are provided", () => {
    const prompt = composeAgentInitialPrompt({
      goalTitle: "G",
      goalDescription: "",
      stepInstructions: "do it",
      outputSchema: [{ key: "summary", type: "string", required: true }],
      priorStepArtifacts: [],
    });
    expect(prompt).not.toMatch(/# Workspaces/);
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

  it("advertises ask_user for blocking decisions and forbids 'finished' framing while waiting", () => {
    const sys = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    }).systemPrompt;
    expect(sys).toContain("ask_user");
    expect(sys).toContain("questions");
    expect(sys).toMatch(/waiting on the user|waiting, not done/i);
  });

  it("forbids putting a user-facing question in a prose body instead of ask_user", () => {
    const sys = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    }).systemPrompt;
    expect(sys).toMatch(/never place a question to the user in the body/i);
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

  it("scoring literal lists reasoning before successScore", () => {
    const { systemPrompt } = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    });
    expect(systemPrompt.indexOf('"reasoning"')).toBeGreaterThan(-1);
    expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"successScore"'));
  });

  it("instructs the mediator to honor completionPolicy", () => {
    const { systemPrompt } = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    });
    expect(systemPrompt).toMatch(/completionPolicy/);
    expect(systemPrompt).toMatch(/interview/i);
    expect(systemPrompt).toMatch(/open_questions/);
  });

  it("interview policy blocks completion on open questions but does not require a separate confirm ask_user", () => {
    const { systemPrompt } = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {} as never,
      triggerPayload: {} as never,
    });
    expect(systemPrompt).toMatch(/interview: never approve_step_complete while the step output's open_questions is non-empty/);
    expect(systemPrompt).not.toMatch(/ask the user to confirm/);
  });

  it("source-starves internal identifiers (step number, step id, agent adapter) from the model context", () => {
    const { userPrompt } = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      context: {
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "tmpl", templateVersion: 1, ordinal: 7, status: "active" },
        currentStep: { id: "triage", instructions: "do the thing", outputSchema: [], agentAdapterId: "codex", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      },
      triggerPayload: {},
    });
    const ctx = JSON.parse(userPrompt).context;
    expect(ctx.workflowRun.ordinal).toBeUndefined();
    expect(ctx.currentStep.id).toBeUndefined();
    expect(ctx.currentStep.agentAdapterId).toBeUndefined();
    // Reasoning material the model still needs is retained.
    expect(ctx.currentStep.instructions).toBe("do the thing");
    expect(ctx.goal.title).toBe("T");
  });

  it("voice rule forbids internal identifiers and no longer mandates 'Step N agent'", () => {
    const { systemPrompt } = composeOrchestratorPrompt({ triggerKind: "agent_response" } as any);
    expect(systemPrompt).toMatch(/NEVER reference step numbers/);
    expect(systemPrompt).not.toMatch(/Refer to the active step agent as "Step N agent"/);
  });
});
