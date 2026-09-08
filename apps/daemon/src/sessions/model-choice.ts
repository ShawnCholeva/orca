import type { AdapterId, ContextVariant, EffortLevel, ResolvedModelChoice } from '@orca/contracts';

export interface ModelChoiceRow {
  model_id: string | null;
  context_variant: string | null;
  effort: string | null;
}

export function modelChoiceToRow(choice: ResolvedModelChoice | undefined): ModelChoiceRow {
  if (!choice) return { model_id: null, context_variant: null, effort: null };
  return {
    model_id: choice.modelId,
    context_variant: choice.contextVariant,
    effort: choice.effort,
  };
}

/**
 * Rebuild the choice a session was started with. A row with no model_id predates
 * the column and ran under the ambient CLI default; it returns undefined rather
 * than a guess, so the caller can tell "no model chosen" from "this model".
 */
export function modelChoiceFromRow(
  adapterId: AdapterId,
  row: ModelChoiceRow
): ResolvedModelChoice | undefined {
  if (!row.model_id) return undefined;
  return {
    adapterId,
    modelId: row.model_id,
    contextVariant: (row.context_variant as ContextVariant | null) ?? 'default',
    effort: (row.effort as EffortLevel | null) ?? null,
  };
}
