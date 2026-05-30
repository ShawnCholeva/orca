import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowSessionManager } from "./orchestrator-llm/shadow-session.js";
import { ShadowSessionLlmClient } from "./orchestrator-llm/shadow-llm-client.js";
import { OrchestratorMediator } from "./orchestrator-llm/mediator.js";
import { composeOrchestratorPrompt } from "./orchestrator-llm/prompts.js";

function fakeTmux(paneScript: string[] = ["❯ \n auto mode on"]) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let paneIdx = 0;
  const runner = {
    calls,
    run: async (args: string[], input?: string) => {
      calls.push({ args, input });
      if (args[0] === "capture-pane") {
        const out = paneScript[Math.min(paneIdx, paneScript.length - 1)];
        paneIdx++;
        return { stdout: out ?? "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  return runner;
}

function deps(root: string, tmux: ReturnType<typeof fakeTmux>, ready = true) {
  return {
    shadowRoot: root,
    daemonPort: 8787,
    authToken: "test-token",
    isReady: async () => ready,
    tmux,
    pollMs: 1,
    readyQuietMs: 1,
    startupTimeoutMs: 200,
  };
}

describe("shadow orchestrator wiring", () => {
  it("mediator.invoke drives a paraphrase action end-to-end via the shadow session", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-shadow-"));
    const tmux = fakeTmux();
    const mgr = new ShadowSessionManager(deps(root, tmux));
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
    // Wait for startup to resolve and askOnce to register its pending callback
    await new Promise<void>((r) => setTimeout(r, 20));
    mgr.resolvePending("G1", {
      text: '```orca:action\n{"kind":"answer_user_directly","body":"hello"}\n```',
    });

    const action = await p;
    expect(action.kind).toBe("answer_user_directly");
    if (action.kind === "answer_user_directly") expect(action.body).toBe("hello");
  });
});
