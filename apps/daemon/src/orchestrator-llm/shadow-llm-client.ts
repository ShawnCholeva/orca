import type { OrchestratorLlmClient } from "./mediator.js";
import type { ShadowSessionManager } from "./shadow-session.js";

export class ShadowSessionLlmClient implements OrchestratorLlmClient {
  constructor(
    private readonly manager: Pick<ShadowSessionManager, "ask">,
    private readonly opts: { timeoutMs: number }
  ) {}

  async request(input: {
    goalId: string;
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }> {
    return this.manager.ask(input.goalId, {
      adapterId: input.adapterId === "codex" ? "codex" : "claude-code",
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      timeoutMs: this.opts.timeoutMs,
    });
  }
}
