// Deterministic, human-readable labels for categorical failure codes. No jargon.
const CATALOG: Record<string, string> = {
  evaluation_failed: "Finished without producing a checkable result",
  invalid_output: "Produced output that didn't match what the step asked for",
  hard_constraint_violation: "Broke a rule the goal required",
  gate_rejected: "A reviewer sent it back",
  timeout: "Ran out of time before finishing",
  escalated: "Had to hand off to a human",
};

export function labelForFailure(code: string | null): string {
  if (code == null) return "Unclassified problem";
  return CATALOG[code] ?? code.replace(/_/g, " ");
}
