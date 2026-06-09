import type { OrchestratorLlmClient } from "./mediator.js";
import type { ShadowAdapterId, ShadowSessionManager } from "./shadow-session.js";

export const SHADOW_LLM_TIMEOUT_MS = 60_000;

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
    if (!isShadowAdapterId(input.adapterId)) {
      throw new Error(`unsupported shadow adapter: ${input.adapterId}`);
    }
    return this.manager.ask(input.goalId, {
      adapterId: input.adapterId,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      timeoutMs: this.opts.timeoutMs,
    });
  }
}

function isShadowAdapterId(adapterId: string): adapterId is ShadowAdapterId {
  return adapterId === "claude-code" || adapterId === "codex" || adapterId === "antigravity";
}
