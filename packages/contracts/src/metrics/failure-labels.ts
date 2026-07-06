// Deterministic, human-readable labels for categorical failure codes. No jargon.
// Complete over the FailureCode enum (contracts/harness) — the fallback below is
// for future codes only, and the test guards completeness.
const CATALOG: Record<string, string> = {
  invalid_output: "Produced output that didn't match what the step asked for",
  timeout: "Ran out of time before finishing",
  session_not_terminal: "Was still working when its result was requested",
  output_unavailable: "Finished without leaving a readable result",
  source_truncated: "The result was cut off before it could be read in full",
  goal_archived: "Stopped because the goal was archived",
  session_archived: "Stopped because its work session was archived",
  daemon_restart: "Interrupted by an app restart",
  guardrail_denied: "Blocked by a safety rule before it could act",
  evidence_veto: "Automated checks failed, so the completion was rejected",
  refute_veto: "An independent review rejected the completion",
  provider_error: "The AI provider failed mid-step",
  internal_error: "An internal error stopped the step",
  evaluation_failed: "Finished without producing a checkable result",
};

export function labelForFailure(code: string | null): string {
  if (code == null) return "Unclassified problem";
  return CATALOG[code] ?? code.replace(/_/g, " ");
}
