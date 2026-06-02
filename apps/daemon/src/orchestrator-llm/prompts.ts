import type { OrchestratorInvocationContext } from "./context.js";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

export interface AgentInitialPromptInput {
  goalTitle: string;
  goalDescription: string;
  stepInstructions: string;
  outputSchema: WorkflowStepOutputSchema;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
}

export function composeAgentInitialPrompt(input: AgentInitialPromptInput): string {
  const artifactBlock = input.priorStepArtifacts.length === 0
    ? "(no prior step outputs)"
    : input.priorStepArtifacts.map((a) => `## prior step: ${a.stepId}\n${JSON.stringify(a.outputJson, null, 2)}`).join("\n\n");

  const goalDescription = input.goalDescription.trim();
  return [
    "# Goal",
    input.goalTitle,
    ...(goalDescription ? ["", goalDescription] : []),
    "",
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
    "On each invocation, return EXACTLY ONE action object whose discriminator field is",
    'named "kind". Use one of these shapes EXACTLY — these field names are mandatory',
    'and validated; do not rename "kind"/"body"/"translated"/"feedback" or add others:',
    '- {"kind":"paraphrase_agent_message","body":"<agent output forwarded in your voice>"}',
    '- {"kind":"forward_to_agent","translated":"<the user\'s message translated into a prompt for the agent>"}',
    '- {"kind":"answer_user_directly","body":"<reply when the user\'s message is meta and need not reach the agent>"}',
    '- {"kind":"approve_step_complete"}  (the agent\'s orca:step-complete block satisfies the step)',
    '- {"kind":"revise_step","feedback":"<concrete feedback; the agent\'s proposal is insufficient>"}',
    '- {"kind":"escalate_to_user","body":"<describe the failure and ask for guidance>"}',
    'Every shape also accepts an optional "rationale":"<short why>".',
    "For user_message triggers, answer simple greetings, status checks, and meta questions directly.",
    "Only use forward_to_agent when the user is asking the active step agent to do work or providing information the step agent needs.",
    "When forward_to_agent succeeds, the application may show no immediate chat reply until agent hooks report a response.",
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
