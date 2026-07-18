import type { EvidenceFacet, RefuteFacet } from "@orca/contracts";

export type CalibrationSource = "executable" | "grounding" | "independent_review" | "self_report";

// The designed per-source prior confidences — the single source of truth shared by
// composedScore's `base` compounding and per-source calibration.
export const SOURCE_CONFIDENCE: Record<CalibrationSource, number> = {
  executable: 1.0, grounding: 0.7, independent_review: 0.55, self_report: 0.3,
};

// Which independent verifiers PASSED on a completion. Same gates classifyTier uses,
// so score and calibration bucket a completion identically.
export function sourcesPassed(
  ev: EvidenceFacet | null | undefined,
  rf: RefuteFacet | null | undefined,
): { executable: boolean; grounding: boolean; independentReview: boolean } {
  const executable = !!ev && ev.sensorsRun.length > 0 && ev.oracleAdequacy.sufficient === true;
  const grounding =
    ev?.grounding?.verdict === "passed" &&
    (ev.grounding.checks ?? []).some((c) => c.mode === "enforce" && c.result !== "skipped");
  const independentReview = rf?.verdict === "upheld";
  return { executable, grounding: !!grounding, independentReview: !!independentReview };
}
