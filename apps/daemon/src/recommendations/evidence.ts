// Keyword tokens indicating implementation activity (word-boundary matched, case-insensitive).
// Canonical set: test/tests, build/builds, lint, diff, commit/commits, pr, merge/merged.
const IMPL_EVIDENCE_RE = /\b(tests?|builds?|lint|diff|commits?|pr|merged?)\b/i;

export interface SessionSummaryEvidence {
  sessionId: string;
  /** 'exited' = completed successfully; 'failed' = failed/rejected */
  sessionStatus: string;
  sessionRole: string | null;
  summaryText: string;
  /** True when a validation_result memory item exists for this session */
  hasValidationResult: boolean;
}

/**
 * Returns true when the session completed normally (status='exited') AND the
 * summary text contains at least one implementation-evidence token
 * (test/build/lint/diff/commit/pr/merge), OR a validation_result memory item
 * exists for the same session.
 *
 * Operates on M5-curated summary fields only — no raw raw session outputs or output tails.
 */
export function detectImplementationEvidence(summary: SessionSummaryEvidence): boolean {
  if (summary.sessionStatus !== 'exited') return false;
  return IMPL_EVIDENCE_RE.test(summary.summaryText) || summary.hasValidationResult;
}

/**
 * Returns true when the session is a reviewer-role session that failed
 * (status='failed'), indicating the reviewer reported a rejection or failure.
 *
 * Uses M5 session status field only — no raw raw session output inspection.
 */
export function detectReviewerRejection(summary: SessionSummaryEvidence): boolean {
  return summary.sessionRole === 'reviewer' && summary.sessionStatus === 'failed';
}
