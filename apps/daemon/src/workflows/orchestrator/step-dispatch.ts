import type { AdapterId, ExecutionMode, ResolvedModelChoice, StepAgentChoice } from "@orca/contracts";
import type { ResolvedMode } from "../../adapters/dispatcher.js";
import type { ModelProfile } from "../../adapters/model-catalog/profiles.js";
import { resolveChoice } from "../../adapters/model-catalog/resolve-choice.js";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";

export interface ResolveStepDispatchInput {
  preferences: StepAgentChoice[];
  isAdapterReady(adapterId: string): Promise<boolean>;
  resolveMode(adapterId: string): ResolvedMode;
  catalogFor(adapterId: AdapterId): Promise<CatalogModel[]>;
  profiles: ModelProfile[];
  /** Adapter order used to resolve a profile preference, which names no adapter. */
  adapterOrder?: AdapterId[];
}

export interface ResolvedStepDispatch {
  adapterId: string;
  modelId: string;
  model: ResolvedModelChoice;
  providerId?: string;
  executionMode: ExecutionMode;
  fallbackModes: ExecutionMode[];
}

const DEFAULT_ADAPTER_ORDER: AdapterId[] = ["claude-code", "codex", "antigravity"];

/**
 * Resolve a step's ordered preferences into the one model that will actually
 * run. Catalog membership is checked here (inside `resolveChoice`), so a
 * preference naming a model the installed CLI no longer ships is skipped rather
 * than dispatched and rejected at spawn.
 */
export async function resolveStepDispatch(
  input: ResolveStepDispatchInput
): Promise<ResolvedStepDispatch> {
  for (const pref of input.preferences) {
    const candidates: AdapterId[] =
      pref.kind === "pinned" ? [pref.adapterId] : (input.adapterOrder ?? DEFAULT_ADAPTER_ORDER);

    for (const adapterId of candidates) {
      if (!(await input.isAdapterReady(adapterId))) continue;
      const catalog = await input.catalogFor(adapterId);
      const model = resolveChoice(pref, catalog, adapterId, input.profiles);
      if (!model) continue;
      const mode = input.resolveMode(adapterId);
      return {
        adapterId,
        modelId: model.modelId,
        model,
        ...(pref.kind === "pinned" && pref.providerId ? { providerId: pref.providerId } : {}),
        executionMode: mode.mode,
        fallbackModes: mode.fallbacks,
      };
    }
  }
  const described = input.preferences
    .map((p) => (p.kind === "pinned" ? `${p.adapterId}/${p.modelId}` : `profile:${p.ref}`))
    .join(", ");
  throw new Error(`no ready agent for step (preferences: ${described})`);
}
