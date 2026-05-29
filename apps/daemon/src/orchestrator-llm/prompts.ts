import type { OrchestratorInvocationContext } from "./context.js";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

export interface AgentInitialPromptInput {
  stepInstructions: string;
  outputSchema: WorkflowStepOutputSchema;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
}

export function composeAgentInitialPrompt(input: AgentInitialPromptInput): string {
  const artifactBlock = input.priorStepArtifacts.length === 0
    ? "(no prior step outputs)"
    : input.priorStepArtifacts.map((a) => `## prior step: ${a.stepId}\n${JSON.stringify(a.outputJson, null, 2)}`).join("\n\n");

  return [
    "# Step instructions",
    input.stepInstructions,
    "",
    "# Output schema",
    input.outputSchema.map((f) => JSON.stringify(f)).join("\n"),
    "",
    "# Prior step outputs",
    artifactBlock,
    "",
    "# Completion convention",
    "When you have all required information AND the success criteria are satisfied,",
    "emit a single fenced block at the end of your response:",
    "",
    "```orca:step-complete",
    "{ ...JSON matching the output schema exactly... }",
    "```",
    "",
    "If you are not done, do not emit this block. Continue working or ask the user one question at a time.",
  ].join("\n");
}

export type OrchestratorTriggerKind =
  | "agent_response"
  | "user_message"
  | "agent_crash"
  | "idle_timeout";

export interface OrchestratorPromptInput {
  triggerKind: OrchestratorTriggerKind;
  context: OrchestratorInvocationContext;
  triggerPayload: {
    agentResponseText?: string;
    agentStepCompleteBlock?: unknown;
    schemaValidationError?: string;
    userMessage?: string;
    crashReason?: string;
  };
}

export interface OrchestratorPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function composeOrchestratorPrompt(input: OrchestratorPromptInput): OrchestratorPrompt {
  const systemPrompt = [
    "You are the orchestrator-LLM for an Orca workflow run.",
    "Your job is to mediate between the user (chat surface) and a per-step agent.",
    "On each invocation, decide one of:",
    "- paraphrase_agent_message (forward agent output to user, in your voice)",
    "- forward_to_agent (translate the user's chat message to a prompt for the agent)",
    "- answer_user_directly (the user's message is meta and does not need to reach the agent)",
    "- approve_step_complete (the agent's <orca:step-complete> block satisfies step instructions and schema)",
    "- revise_step (the agent's proposal is insufficient; produce concrete feedback)",
    "- escalate_to_user (a failure has occurred; describe and ask for guidance)",
    "Return exactly one structured action.",
    "",
    SENTINEL_INSTRUCTION,
  ].join("\n");

  const userPrompt = JSON.stringify({
    triggerKind: input.triggerKind,
    context: input.context,
    trigger: input.triggerPayload,
  });

  return { systemPrompt, userPrompt };
}
