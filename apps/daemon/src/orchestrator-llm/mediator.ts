import { OrchestratorAction } from "@orca/contracts";
import type {
  OrchestratorPromptInput,
  OrchestratorPrompt,
  OrchestratorTriggerKind,
} from "./prompts.js";
import type { OrchestratorInvocationContext } from "./context.js";

export interface OrchestratorLlmClient {
  request(input: {
    goalId: string;
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }>;
}

export interface TurnScope {
  goalId: string;
  runId: string;
  stepRunId: string;
  triggerKind: OrchestratorTriggerKind;
}

export interface MediatorDeps {
  llm: OrchestratorLlmClient;
  buildContext: (args: {
    goalId: string;
    runId: string;
    stepRunId: string;
  }) => OrchestratorInvocationContext;
  composePrompt: (input: OrchestratorPromptInput) => OrchestratorPrompt;
  /**
   * Observes each invocation as a placed interval. Every orchestrator turn passes
   * through `invoke`, so this is the one seam where the orchestrator's own wall
   * clock can be written down; the judge/refute phases cover only two of its kinds.
   */
  turns?: { started(scope: TurnScope): void; finished(scope: TurnScope): void };
}

export interface MediatorInvokeInput {
  triggerKind: OrchestratorTriggerKind;
  goalId: string;
  runId: string;
  stepRunId: string;
  triggerPayload: OrchestratorPromptInput["triggerPayload"];
  adapterId: string;
  modelId: string;
}

export class OrchestratorMediator {
  constructor(private readonly deps: MediatorDeps) {}

  async invokeWithBackoff(input: MediatorInvokeInput, attempt = 0): Promise<OrchestratorAction> {
    try {
      return await this.invoke(input);
    } catch (err) {
      if (attempt >= 5) throw err;
      const backoffMs = Math.min(60_000, 500 * Math.pow(2, attempt));
      await new Promise((r) => setTimeout(r, backoffMs));
      return this.invokeWithBackoff(input, attempt + 1);
    }
  }

  async invoke(input: MediatorInvokeInput): Promise<OrchestratorAction> {
    const scope: TurnScope = { goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId, triggerKind: input.triggerKind };
    this.deps.turns?.started(scope);
    try {
      return await this.invokeTurn(input);
    } finally {
      this.deps.turns?.finished(scope);
    }
  }

  private async invokeTurn(input: MediatorInvokeInput): Promise<OrchestratorAction> {
    const context = this.deps.buildContext({
      goalId: input.goalId,
      runId: input.runId,
      stepRunId: input.stepRunId,
    });
    const prompt = this.deps.composePrompt({
      triggerKind: input.triggerKind,
      context,
      triggerPayload: input.triggerPayload,
    });
    const res1 = await this.deps.llm.request({
      goalId: input.goalId,
      adapterId: input.adapterId,
      modelId: input.modelId,
      ...prompt,
    });
    const parsed1 = tryParseAction(res1.text);
    if (parsed1) return parsed1;
    const res2 = await this.deps.llm.request({
      goalId: input.goalId,
      adapterId: input.adapterId,
      modelId: input.modelId,
      ...prompt,
    });
    const parsed2 = tryParseAction(res2.text);
    if (parsed2) return parsed2;
    throw new Error("orchestrator-LLM produced no parseable action after 2 attempts");
  }
}

function tryParseAction(text: string): OrchestratorAction | null {
  try {
    const obj = JSON.parse(text);
    const parsed = OrchestratorAction.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
