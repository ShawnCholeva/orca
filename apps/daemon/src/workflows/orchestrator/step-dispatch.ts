import type { ExecutionMode, StepAgentChoice } from "@orca/contracts";
import type { ResolvedMode } from "../../adapters/dispatcher.js";

export interface ResolveStepDispatchInput {
  preferences: StepAgentChoice[];
  isAdapterReady(adapterId: string): Promise<boolean>;
  supportsModel(adapterId: string, modelId: string): boolean;
  resolveMode(adapterId: string): ResolvedMode;
}

export interface ResolvedStepDispatch {
  adapterId: string;
  modelId: string;
  providerId?: string;
  executionMode: ExecutionMode;
  fallbackModes: ExecutionMode[];
}

export async function resolveStepDispatch(
  input: ResolveStepDispatchInput
): Promise<ResolvedStepDispatch> {
  for (const pref of input.preferences) {
    if (!input.supportsModel(pref.adapterId, pref.modelId)) continue;
    const ready = await input.isAdapterReady(pref.adapterId);
    if (!ready) continue;
    const mode = input.resolveMode(pref.adapterId);
    return {
      adapterId: pref.adapterId,
      modelId: pref.modelId,
      providerId: pref.providerId,
      executionMode: mode.mode,
      fallbackModes: mode.fallbacks,
    };
  }
  throw new Error(`no ready agent for step (preferences: ${input.preferences.map(p => `${p.adapterId}/${p.modelId}`).join(", ")})`);
}
