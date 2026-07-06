import type { StepMetrics, TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";

export const REGRESSION_THRESHOLD = 0.1;
export const SAMPLE_MIN = 5;
export const SCHEMA_INVALID_OUTPUT_THRESHOLD = 0.2;

export function enrichWithRegression(
  proposals: TemplateInstructionProposal[], summary: TemplateMetricsSummary, steps: StepMetrics[] = [],
): TemplateInstructionProposal[] {
  const vc = summary.versionComparison;
  return proposals.map((p) => {
    if (p.status !== "applied" || p.appliedAsVersion == null) return p;
    // Only judge once the applied version has accrued enough runs.
    const versionRuns = summary.versions.find((v) => v.version === p.appliedAsVersion)?.runs ?? 0;
    if (versionRuns < SAMPLE_MIN || !vc || vc.latest !== p.appliedAsVersion) {
      return { ...p, regressionDetected: false, watchedDeltas: {}, targetDelta: null, targetImproved: null,
        targetDeltaVersions: null, invalidOutputRateDelta: null };
    }
    const watchedDeltas: Record<string, number | null> = {};
    let regressed = false;
    for (const dim of p.invariantsPreserved) {
      const delta = vc.byDimension[dim] ?? null;
      watchedDeltas[dim] = delta;
      if (delta != null && delta < -REGRESSION_THRESHOLD) regressed = true;
    }
    // The falsifier must also check the proposal's own goal: did the TARGETED step's
    // honest score move under the applied version? Invariants alone let a proposal
    // fail its purpose and still read as a success.
    const step = steps.find((s) => s.stepTemplateId === p.stepTemplateId);
    // Attribute the step's version delta to this proposal only when the compared
    // pair actually spans the applied version — otherwise a stale prior-pair delta
    // would masquerade as this proposal's outcome.
    const spansApplied = step?.versionScoreDeltaVersions?.latest === p.appliedAsVersion;
    const targetDelta = spansApplied ? step?.versionScoreDelta ?? null : null;
    const invalidOutputRateDelta = spansApplied ? step?.versionInvalidOutputRateDelta ?? null : null;
    // A learned tightening's specific failure shape: the new checks reject output.
    const schemaCanaryTripped = p.component === "step_output_schema"
      && invalidOutputRateDelta != null && invalidOutputRateDelta > SCHEMA_INVALID_OUTPUT_THRESHOLD;
    return { ...p, regressionDetected: regressed || schemaCanaryTripped, watchedDeltas,
      targetDelta, targetImproved: targetDelta == null ? null : targetDelta > 0,
      targetDeltaVersions: spansApplied ? step?.versionScoreDeltaVersions ?? null : null,
      invalidOutputRateDelta };
  });
}
