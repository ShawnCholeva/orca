import { describe, expect, it } from 'vitest';
import {
  detectImplementationEvidence,
  detectReviewerRejection,
  type SessionSummaryEvidence,
} from './evidence.js';

function base(overrides: Partial<SessionSummaryEvidence> = {}): SessionSummaryEvidence {
  return {
    sessionId: 's-1',
    sessionStatus: 'exited',
    sessionRole: 'engineer',
    summaryText: '',
    hasValidationResult: false,
    ...overrides,
  };
}

// ── detectImplementationEvidence ───────────────────────────────────────────────

describe('detectImplementationEvidence', () => {
  it('returns true: status=exited, summary contains "tests"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'All tests pass' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "build"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Build succeeded' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "lint"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Running lint on changed files' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "diff"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Reviewed the diff carefully' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "commit"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Created commit with changes' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "pr"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Opened pr for review' }))
    ).toBe(true);
  });

  it('returns true: status=exited, summary contains "merge"', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Ready to merge' }))
    ).toBe(true);
  });

  it('returns true: status=exited, hasValidationResult=true, no keyword in summary', () => {
    expect(
      detectImplementationEvidence(
        base({ summaryText: 'Session completed', hasValidationResult: true })
      )
    ).toBe(true);
  });

  it('returns true: keyword match is case-insensitive', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'BUILD SUCCEEDED' }))
    ).toBe(true);
  });

  it('returns false: status=exited, no keywords, no validation result', () => {
    expect(
      detectImplementationEvidence(base({ summaryText: 'Session completed without context' }))
    ).toBe(false);
  });

  it('returns false: status=running (not exited)', () => {
    expect(
      detectImplementationEvidence(
        base({ sessionStatus: 'running', summaryText: 'all tests pass' })
      )
    ).toBe(false);
  });

  it('returns false: status=failed even with keyword', () => {
    expect(
      detectImplementationEvidence(
        base({ sessionStatus: 'failed', summaryText: 'build failed' })
      )
    ).toBe(false);
  });

  it('returns false: status=paused', () => {
    expect(
      detectImplementationEvidence(
        base({ sessionStatus: 'paused', summaryText: 'tests are passing' })
      )
    ).toBe(false);
  });

  it('does not match "pretest" as "test" — word boundary respected', () => {
    // "pretest" contains "test" but not at a word boundary start
    // however "tests" at start of token IS a match — check that "apretend" doesn't match
    expect(
      detectImplementationEvidence(base({ summaryText: 'apretendword' }))
    ).toBe(false);
  });
});

// ── detectReviewerRejection ────────────────────────────────────────────────────

describe('detectReviewerRejection', () => {
  it('returns true: role=reviewer, status=failed', () => {
    expect(
      detectReviewerRejection(
        base({ sessionRole: 'reviewer', sessionStatus: 'failed' })
      )
    ).toBe(true);
  });

  it('returns false: role=reviewer, status=exited (successful review)', () => {
    expect(
      detectReviewerRejection(
        base({ sessionRole: 'reviewer', sessionStatus: 'exited' })
      )
    ).toBe(false);
  });

  it('returns false: role=engineer, status=failed (engineer failure is not reviewer rejection)', () => {
    expect(
      detectReviewerRejection(
        base({ sessionRole: 'engineer', sessionStatus: 'failed' })
      )
    ).toBe(false);
  });

  it('returns false: role=qa, status=failed (qa is not reviewer)', () => {
    expect(
      detectReviewerRejection(
        base({ sessionRole: 'qa', sessionStatus: 'failed' })
      )
    ).toBe(false);
  });

  it('returns false: role=null, status=failed', () => {
    expect(
      detectReviewerRejection(
        base({ sessionRole: null, sessionStatus: 'failed' })
      )
    ).toBe(false);
  });
});
