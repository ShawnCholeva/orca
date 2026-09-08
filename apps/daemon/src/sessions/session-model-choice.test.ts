import { describe, expect, it } from 'vitest';
import type { ResolvedModelChoice } from '@orca/contracts';
import { modelChoiceFromRow, modelChoiceToRow } from './model-choice.js';

const CHOICE: ResolvedModelChoice = {
  adapterId: 'claude-code',
  modelId: 'claude-opus-5',
  contextVariant: '1m',
  effort: 'xhigh',
};

describe('modelChoiceToRow', () => {
  it('flattens a choice into the three columns', () => {
    expect(modelChoiceToRow(CHOICE)).toEqual({
      model_id: 'claude-opus-5',
      context_variant: '1m',
      effort: 'xhigh',
    });
  });

  it('writes nulls when there is no choice', () => {
    expect(modelChoiceToRow(undefined)).toEqual({
      model_id: null,
      context_variant: null,
      effort: null,
    });
  });

  it('writes a null effort for an adapter with no effort axis', () => {
    expect(modelChoiceToRow({ ...CHOICE, effort: null }).effort).toBeNull();
  });
});

describe('modelChoiceFromRow', () => {
  it('rebuilds the choice from the row', () => {
    expect(
      modelChoiceFromRow('claude-code', {
        model_id: 'claude-opus-5',
        context_variant: '1m',
        effort: 'xhigh',
      })
    ).toEqual(CHOICE);
  });

  it('returns undefined for a pre-migration row rather than inventing a model', () => {
    expect(
      modelChoiceFromRow('claude-code', {
        model_id: null,
        context_variant: null,
        effort: null,
      })
    ).toBeUndefined();
  });

  it('defaults a missing variant to default', () => {
    expect(
      modelChoiceFromRow('claude-code', {
        model_id: 'claude-opus-5',
        context_variant: null,
        effort: null,
      })
    ).toEqual({
      adapterId: 'claude-code',
      modelId: 'claude-opus-5',
      contextVariant: 'default',
      effort: null,
    });
  });
});
