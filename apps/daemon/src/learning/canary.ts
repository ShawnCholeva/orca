import type { TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";

export const REGRESSION_THRESHOLD = 0.1;
export const SAMPLE_MIN = 5;

export function enrichWithRegression(
  proposals: TemplateInstructionProposal[], summary: TemplateMetricsSummary,
): TemplateInstructionProposal[] {
  const vc = summary.versionComparison;
  return proposals.map((p) => {
    if (p.status !== "applied" || p.appliedAsVersion == null) return p;
    // Only judge once the applied version has accrued enough runs.
    const versionRuns = summary.versions.find((v) => v.version === p.appliedAsVersion)?.runs ?? 0;
    if (versionRuns < SAMPLE_MIN || !vc || vc.latest !== p.appliedAsVersion) {
      return { ...p, regressionDetected: false, watchedDeltas: {} };
    }
    const watchedDeltas: Record<string, number | null> = {};
    let regressed = false;
    for (const dim of p.invariantsPreserved) {
      const delta = vc.byDimension[dim] ?? null;
      watchedDeltas[dim] = delta;
      if (delta != null && delta < -REGRESSION_THRESHOLD) regressed = true;
    }
    return { ...p, regressionDetected: regressed, watchedDeltas };
  });
}
