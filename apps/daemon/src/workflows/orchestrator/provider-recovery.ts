import {
  AdapterId,
  ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
  asPinned,
  type CatalogModel,
  type OperatorDescriptor,
  type ProviderRecoveryChoice,
  type StepAgentChoice,
} from "@orca/contracts";
import type { ModelProfile } from "../../adapters/model-catalog/profiles.js";
import { resolveChoice } from "../../adapters/model-catalog/resolve-choice.js";
import type { AgentInitialPromptInput } from "../../orchestrator-llm/prompts.js";
import { composeAgentInitialPrompt } from "../../orchestrator-llm/prompts.js";
import type { StepDispatchCapabilities } from "./dispatch-types.js";
import { resolveStepDispatch, type ResolvedStepDispatch } from "./step-dispatch.js";

export interface BuildProviderRecoveryChoicesInput {
  currentAdapterId: string;
  connectedAdapterIds: string[];
  stepPreferences: StepAgentChoice[];
  operators: OperatorDescriptor[];
  catalogFor(adapterId: AdapterId): Promise<CatalogModel[]>;
  profiles: ModelProfile[];
}

export async function buildProviderRecoveryChoices(
  input: BuildProviderRecoveryChoicesInput
): Promise<ProviderRecoveryChoice[]> {
  // A profile-arm preference names no adapter, so it cannot key this map — but
  // it is not therefore inapplicable: a profile is a requirement set, and every
  // candidate adapter gets to satisfy it from its own catalog. Pins win where
  // they name the adapter; the first profile arm is the fallback for the rest.
  const pinnedByAdapter = new Map(
    input.stepPreferences
      .map((preference) => asPinned(preference))
      .filter((preference) => preference !== null)
      .map((preference) => [preference.adapterId, preference])
  );
  const profileArm = input.stepPreferences.find((pref) => pref.kind === "profile") ?? null;
  const connected = new Set(input.connectedAdapterIds);

  const eligible = input.operators
    .filter((operator) => operator.kind === "agent")
    .filter((operator) => connected.has(operator.id.slice("agent:".length)))
    .filter((operator) => operator.id !== `agent:${input.currentAdapterId}`);

  return Promise.all(
    eligible.map(async (operator): Promise<ProviderRecoveryChoice> => {
      const adapterId = AdapterId.parse(operator.id.slice("agent:".length));
      const preference = pinnedByAdapter.get(adapterId) ?? profileArm;

      if (!preference) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: null,
          enabled: false,
          reason: "not configured for this step",
        };
      }

      const catalog = await input.catalogFor(adapterId);
      const resolved = resolveChoice(preference, catalog, adapterId, input.profiles);
      if (!resolved) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: preference.kind === "pinned" ? preference.modelId : null,
          enabled: false,
          reason:
            preference.kind === "pinned"
              ? "configured model is not supported"
              : "no model here matches the configured profile",
        };
      }

      return {
        adapterId,
        displayName: operator.displayName,
        modelId: resolved.modelId,
        enabled: operator.ready,
        reason: operator.ready ? null : (operator.notReadyReason ?? "provider unavailable"),
      };
    })
  );
}

/**
 * Resolve the step's own preferences against ONE adapter — the provider the
 * operator switched to (or retried). Recovery has already established that this
 * adapter is ready, so readiness is pinned true and the adapter order is a
 * single entry, which also lets a profile-arm preference resolve here.
 *
 * Null when nothing resolves; the caller decides whether that is fatal.
 */
export async function resolveRecoveryDispatch(
  stepDispatch: StepDispatchCapabilities,
  preferences: StepAgentChoice[],
  adapterId: AdapterId
): Promise<ResolvedStepDispatch | null> {
  return resolveStepDispatch({
    preferences,
    isAdapterReady: async (id) => id === adapterId,
    catalogFor: (id) => stepDispatch.catalogFor(id),
    profiles: stepDispatch.profiles,
    resolveMode: (id) => stepDispatch.resolveMode(id),
    adapterOrder: [adapterId],
  }).catch(() => null);
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
