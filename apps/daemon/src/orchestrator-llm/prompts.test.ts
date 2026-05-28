import { describe, expect, it } from "vitest";
import { composeOrchestratorPrompt, composeAgentInitialPrompt } from "./prompts.js";

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
});
