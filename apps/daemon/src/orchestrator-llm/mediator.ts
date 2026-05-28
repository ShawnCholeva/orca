import { OrchestratorAction } from "@orca/contracts";
import type {
  OrchestratorPromptInput,
  OrchestratorPrompt,
  OrchestratorTriggerKind,
} from "./prompts.js";
import type { OrchestratorInvocationContext } from "./context.js";

export interface OrchestratorLlmClient {
  request(input: {
    adapterId: string;
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string }>;
}

export interface MediatorDeps {
  llm: OrchestratorLlmClient;
  buildContext: (args: {
    goalId: string;
    runId: string;
    stepRunId: string;
  }) => OrchestratorInvocationContext;
  composePrompt: (input: OrchestratorPromptInput) => OrchestratorPrompt;
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

  async invoke(input: MediatorInvokeInput): Promise<OrchestratorAction> {
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
      adapterId: input.adapterId,
      modelId: input.modelId,
      ...prompt,
    });
    const parsed1 = tryParseAction(res1.text);
    if (parsed1) return parsed1;
    const res2 = await this.deps.llm.request({
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
