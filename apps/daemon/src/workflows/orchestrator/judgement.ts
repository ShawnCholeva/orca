import { extractOrcaStepCompleteBlock } from "./orca-output.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import type { OrchestratorAction } from "@orca/contracts";

export interface JudgeAgentResponseInput {
  mediator: OrchestratorMediator;
  schemaValidate(output: unknown): { ok: true } | { ok: false; errors: string[] };
  goalId: string;
  runId: string;
  stepRunId: string;
  adapterId: string;
  modelId: string;
  responseText: string;
}

export async function judgeAgentResponse(input: JudgeAgentResponseInput): Promise<OrchestratorAction> {
  const block = extractOrcaStepCompleteBlock(input.responseText);
  if (!block) {
    return input.mediator.invoke({
      triggerKind: "agent_response",
      goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId,
      adapterId: input.adapterId, modelId: input.modelId,
      triggerPayload: { agentResponseText: input.responseText },
    });
  }
  const v = input.schemaValidate(block);
  if (!v.ok) {
    return {
      kind: "revise_step",
      feedback: `Your output failed schema validation:\n${v.errors.join("\n")}\nRevise and re-emit.`,
      rationale: "schema validation failed deterministically",
    };
  }
  return input.mediator.invoke({
    triggerKind: "agent_response",
    goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId,
    adapterId: input.adapterId, modelId: input.modelId,
    triggerPayload: { agentResponseText: input.responseText, agentStepCompleteBlock: block },
  });
}
