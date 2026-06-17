import type { OrchestratorInvocationContext } from "./context.js";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { SENTINEL_INSTRUCTION } from "./sentinel.js";

export interface AgentInitialPromptInput {
  goalTitle: string;
  goalDescription: string;
  stepInstructions: string;
  outputSchema: WorkflowStepOutputSchema;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
  repairContext?: { reason: string; issueRefs: string[] } | null;
  workspaces?: Array<{ name: string; root: string }>;
}

export function composeAgentInitialPrompt(input: AgentInitialPromptInput): string {
  const artifactBlock = input.priorStepArtifacts.length === 0
    ? "(no prior step outputs)"
    : input.priorStepArtifacts.map((a) => `## prior step: ${a.stepId}\n${JSON.stringify(a.outputJson, null, 2)}`).join("\n\n");

  const goalDescription = input.goalDescription.trim();
  const repair = input.repairContext;
  const repairSection = repair
    ? [
        "",
        "# Repair context",
        "A reviewing gate routed back to this step. Address the following before completing:",
        repair.reason,
        ...(repair.issueRefs.length > 0 ? [`Issue refs: ${repair.issueRefs.join(", ")}`] : []),
      ]
    : [];
  const workspaceBlock = input.workspaces && input.workspaces.length > 0
    ? ["", "# Workspaces", ...input.workspaces.map((w) => `- ${w.name}: ${w.root}`)]
    : [];
  return [
    "# Goal",
    input.goalTitle,
    ...(goalDescription ? ["", goalDescription] : []),
    ...repairSection,
    ...workspaceBlock,
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
    'and validated; do not rename "kind"/"body"/"translated"/"feedback"/"questions" or add others:',
    '- {"kind":"paraphrase_agent_message","body":"<agent output, narrated from the agent\'s perspective in the third person>"}',
    '- {"kind":"forward_to_agent","translated":"<the user\'s message translated into a prompt for the agent>"}',
    '- {"kind":"answer_user_directly","body":"<reply when the user\'s message is meta and need not reach the agent>"}',
    '- {"kind":"approve_step_complete","scoring":{"successScore":0.0,"quality":{"outputCompleteness":0.0,"outputCorrectness":0.0,"instructionAdherence":0.0,"downstreamReadiness":0.0,"riskLevel":0.0},"reason":"<short>","handoffReady":true}}  (the agent\'s orca:step-complete block satisfies the step; ALWAYS include scoring when you approve)',
    '- {"kind":"revise_step","feedback":"<concrete feedback; the agent\'s proposal is insufficient>"}',
    '- {"kind":"escalate_to_user","body":"<describe the failure and ask for guidance>"}',
    '- {"kind":"ask_user","body":"<short third-person framing, e.g. \'Step 1 agent needs a decision before it can continue\'>","questions":[{"header":"<chip ≤12 chars>","question":"<the decision to make>","multiSelect":false,"options":[{"label":"<choice>","description":"<what it means>"}]}]}  (the step agent needs a DECISION from the user — present concrete choices)',
    "When you approve_step_complete you MUST score the completed step. All scoring numbers are 0..1.",
    "successScore and each quality dimension: 1 = best. riskLevel is inverted: 0 = no risk, 1 = severe risk.",
    "Score from the agent evidence (output block, artifacts, assumptions, warnings). The agent never authors its own score.",
    "Keep scoring.reason concise (about one sentence, under 240 characters); longer reasons are truncated on the result card.",
    'Every shape also accepts an optional "rationale":"<short why>".',
    'Voice: narrate the agent\'s work in the third person, from the agent\'s perspective. Refer to the active step agent as "Step N agent" (e.g. "Step 1 agent is running the tests"). Never speak as if you personally do the work — do not write "I\'m running the agent" or "I\'ll do X".',
    "For user_message triggers, answer simple greetings, status checks, and meta questions directly.",
    "Only use forward_to_agent when the user is asking the active step agent to do work or providing information the step agent needs.",
    "When forward_to_agent succeeds, the application may show no immediate chat reply until agent hooks report a response.",
    'Use ask_user whenever the step agent has asked the user a question or cannot proceed without a user decision: present the concrete choices as structured options. Never paraphrase a question as prose, and never narrate the step as finished or claim it "has a complete picture" while it is waiting on the user — a step blocked on the user is waiting, not done.',
    "When the user answers an ask_user, you receive it as a user_message; forward_to_agent so the answer reaches the step agent.",
    "Honor the current step's completionPolicy (context.currentStep.completionPolicy):",
    "- interview: never approve_step_complete while the step output's open_questions is non-empty or the synthesized result is unconfirmed by the user — use ask_user (one decision at a time, with a recommended answer) until the queue is drained, then ask the user to confirm.",
    "- reasoning: pause at any material fork (options that genuinely diverge and are the user's to decide) via ask_user; never approve_step_complete while such a decision is pending.",
    "- handoff: open_questions is a recorded deliverable and does not block completion, but still ask_user for any genuine decision (for example, where to save an artifact).",
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
