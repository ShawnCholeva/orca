import {
  AdapterId,
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  type OperatorDescriptor,
  type ProviderRecoveryChoice,
  type StepAgentChoice,
} from "@orca/contracts";
import type { AgentInitialPromptInput } from "../../orchestrator-llm/prompts.js";
import { composeAgentInitialPrompt } from "../../orchestrator-llm/prompts.js";

export interface BuildProviderRecoveryChoicesInput {
  currentAdapterId: string;
  connectedAdapterIds: string[];
  stepPreferences: StepAgentChoice[];
  operators: OperatorDescriptor[];
  supportsModel(adapterId: string, modelId: string): boolean;
}

export function buildProviderRecoveryChoices(
  input: BuildProviderRecoveryChoicesInput
): ProviderRecoveryChoice[] {
  const preferenceByAdapter = new Map(
    input.stepPreferences.map((preference) => [preference.adapterId, preference])
  );
  const connected = new Set(input.connectedAdapterIds);

  return input.operators
    .filter((operator) => operator.kind === "agent")
    .filter((operator) => connected.has(operator.id.slice("agent:".length)))
    .filter((operator) => operator.id !== `agent:${input.currentAdapterId}`)
    .map((operator): ProviderRecoveryChoice => {
      const adapterId = AdapterId.parse(operator.id.slice("agent:".length));
      const preference = preferenceByAdapter.get(adapterId);

      if (!preference) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: null,
          enabled: false,
          reason: "not configured for this step",
        };
      }

      if (!input.supportsModel(adapterId, preference.modelId)) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: preference.modelId,
          enabled: false,
          reason: "configured model is not supported",
        };
      }

      return {
        adapterId,
        displayName: operator.displayName,
        modelId: preference.modelId,
        enabled: operator.ready,
        reason: operator.ready ? null : (operator.notReadyReason ?? "provider unavailable"),
      };
    });
}

export interface ComposeProviderSwitchPromptInput {
  agentPromptInput: AgentInitialPromptInput;
  interruptedTail: string;
}

export function composeProviderSwitchPrompt(
  input: ComposeProviderSwitchPromptInput
): string {
  const base = composeAgentInitialPrompt(input.agentPromptInput);

  const tailBytes = Buffer.from(input.interruptedTail, "utf8");
  const bounded =
    tailBytes.length > ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
      ? tailBytes
          .subarray(tailBytes.length - ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES)
          .toString("utf8")
      : input.interruptedTail;

  const handoff = [
    "",
    "# Interrupted session handoff",
    "The previous provider stopped because its usage limit was reached.",
    "Continue the same step using this bounded transcript:",
    bounded,
  ].join("\n");

  return base + handoff;
}
