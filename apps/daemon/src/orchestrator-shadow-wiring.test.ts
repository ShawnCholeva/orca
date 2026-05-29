import { describe, it, expect } from "vitest";
import { ShadowSessionManager } from "./orchestrator-llm/shadow-session.js";
import { ShadowSessionLlmClient } from "./orchestrator-llm/shadow-llm-client.js";
import { OrchestratorMediator } from "./orchestrator-llm/mediator.js";
import { composeOrchestratorPrompt } from "./orchestrator-llm/prompts.js";
import { FakePtyManager } from "./pty/fake.js";

describe("shadow orchestrator wiring", () => {
  it("mediator.invoke drives a paraphrase action end-to-end via the shadow session", async () => {
    const pty = new FakePtyManager();
    const mgr = new ShadowSessionManager({
      ptyManager: pty,
      resolveSpawn: () => ({ command: "claude", args: [], env: {}, cwd: "/tmp" }),
    });
    await mgr.spawn("G1");
    const mediator = new OrchestratorMediator({
      llm: new ShadowSessionLlmClient(mgr, { timeoutMs: 1000 }),
      buildContext: () => ({
        goal: { id: "G1", title: "T", description: "D", attachedWorkspaces: [] },
        workflowRun: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
        currentStep: { id: "", instructions: "", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
        conversation: { chatMessages: [], currentStepAgentTurns: [] },
        priorStepArtifacts: [],
      }),
      composePrompt: composeOrchestratorPrompt,
    });

    const p = mediator.invoke({
      triggerKind: "user_message",
      goalId: "G1", runId: "R1", stepRunId: "S1",
      adapterId: "claude-code", modelId: "claude-haiku-4-5",
      triggerPayload: { userMessage: "hi" },
    });
    // Let askOnce run (it's queued via session.queue.then())
    await Promise.resolve();
    mgr.resolvePending("G1", {
      text: '```orca:action\n{"kind":"answer_user_directly","body":"hello"}\n```',
    });

    const action = await p;
    expect(action.kind).toBe("answer_user_directly");
    if (action.kind === "answer_user_directly") expect(action.body).toBe("hello");
  });
});
