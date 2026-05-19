import { describe, expect, it } from 'vitest';
import { shouldAutoPromote, type ExtractionContext } from './promotion-rules.js';
import type { MemoryCandidate } from '@orca/contracts';

const SESSION_EXIT_CTX: ExtractionContext = {
  sourceType: 'session',
  derivedFromExitCode: true,
  derivedFromCleanCompletion: false,
};

const SESSION_CLEAN_CTX: ExtractionContext = {
  sourceType: 'session',
  derivedFromExitCode: false,
  derivedFromCleanCompletion: true,
};

const SESSION_GENERIC_CTX: ExtractionContext = {
  sourceType: 'session',
  derivedFromExitCode: false,
  derivedFromCleanCompletion: false,
};

const REFINEMENT_CTX: ExtractionContext = {
  sourceType: 'refinement',
  derivedFromExitCode: false,
  derivedFromCleanCompletion: false,
};

function candidate(overrides: Partial<MemoryCandidate>): MemoryCandidate {
  return {
    type: 'note',
    content: 'some content',
    promoteEligible: false,
    ...overrides,
  };
}

describe('shouldAutoPromote — refinement source', () => {
  it('promotes constraint from refinement', () => {
    expect(shouldAutoPromote(candidate({ type: 'constraint' }), REFINEMENT_CTX)).toBe(true);
  });

  it('promotes success_criterion from refinement', () => {
    expect(shouldAutoPromote(candidate({ type: 'success_criterion' }), REFINEMENT_CTX)).toBe(true);
  });

  it('does not promote note from refinement', () => {
    expect(shouldAutoPromote(candidate({ type: 'note' }), REFINEMENT_CTX)).toBe(false);
  });

  it('does not promote assumption from refinement', () => {
    expect(shouldAutoPromote(candidate({ type: 'assumption' }), REFINEMENT_CTX)).toBe(false);
  });

  it('does not promote blocker from refinement', () => {
    expect(shouldAutoPromote(candidate({ type: 'blocker', confidence: 1.0 }), REFINEMENT_CTX)).toBe(false);
  });
});

describe('shouldAutoPromote — session blocker', () => {
  it('promotes high-confidence blocker when derived from exit code', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'blocker', confidence: 0.9 }), SESSION_EXIT_CTX)
    ).toBe(true);
  });

  it('promotes blocker with confidence exactly 0.9', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'blocker', confidence: 0.9 }), SESSION_EXIT_CTX)
    ).toBe(true);
  });

  it('does not promote blocker with confidence below 0.9', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'blocker', confidence: 0.89 }), SESSION_EXIT_CTX)
    ).toBe(false);
  });

  it('does not promote blocker when not derived from exit code', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'blocker', confidence: 0.95 }), SESSION_CLEAN_CTX)
    ).toBe(false);
  });

  it('does not promote blocker when no confidence set (defaults to 0)', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'blocker' }), SESSION_EXIT_CTX)
    ).toBe(false);
  });
});

describe('shouldAutoPromote — session validation_result', () => {
  it('promotes high-confidence validation_result on clean completion', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'validation_result', confidence: 0.9 }), SESSION_CLEAN_CTX)
    ).toBe(true);
  });

  it('does not promote validation_result with confidence below 0.9', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'validation_result', confidence: 0.89 }), SESSION_CLEAN_CTX)
    ).toBe(false);
  });

  it('does not promote validation_result when not from clean completion', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'validation_result', confidence: 0.95 }), SESSION_EXIT_CTX)
    ).toBe(false);
  });
});

describe('shouldAutoPromote — non-promotable types', () => {
  it('does not promote note from session', () => {
    expect(shouldAutoPromote(candidate({ type: 'note' }), SESSION_GENERIC_CTX)).toBe(false);
  });

  it('does not promote open_question from session', () => {
    expect(shouldAutoPromote(candidate({ type: 'open_question' }), SESSION_GENERIC_CTX)).toBe(false);
  });

  it('does not promote architecture_note from session', () => {
    expect(
      shouldAutoPromote(candidate({ type: 'architecture_note' }), SESSION_GENERIC_CTX)
    ).toBe(false);
  });

  it('does not auto-promote any type from manual source', () => {
    const manualCtx: ExtractionContext = { sourceType: 'manual', derivedFromExitCode: false, derivedFromCleanCompletion: false };
    expect(shouldAutoPromote(candidate({ type: 'constraint' }), manualCtx)).toBe(false);
    expect(shouldAutoPromote(candidate({ type: 'blocker', confidence: 1.0 }), manualCtx)).toBe(false);
  });
});
