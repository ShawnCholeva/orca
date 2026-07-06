import type { StepMetrics, TargetedFailureMode, TemplateMetricsDetail } from "@orca/contracts";
import type { TemplateRevisionSignal } from "./fetch.js";

export const SAMPLE_MIN = 5;
const K = 3; // R2 min cluster count
const M = 3; // R3 min feedback-signal count
const TOP_N = 3;

export const INSTRUCTION_ADDRESSABLE: ReadonlySet<string> = new Set([
  "invalid_output", "output_unavailable", "source_truncated", "evidence_veto", "guardrail_denied",
]);

export type DiagnosisBundle = {
  stepTemplateId: string;
  currentInstructions: string;
  targetedFailureMode: TargetedFailureMode;
  evidence: {
    sampleTransitionIds: string[];
    revisionSignalIds: string[];
    revisionFeedbackTexts: string[];
    metricSnapshot: { score: number | null; verdictPassRate: number; oracleSufficientRate: number | null; versionDelta: number | null };
  };
};

function chooseRule(step: StepMetrics, feedbackSignals: TemplateRevisionSignal[]): TargetedFailureMode | null {
  // R3 — revision-signal density (highest signal; instruction-related regardless of code).
  if (feedbackSignals.length >= M) {
    return { rule: "R3", failureCode: null, clusterCount: null, signalCount: feedbackSignals.length };
  }
  // R2 — dominant instruction-addressable cluster.
  const cluster = step.failureClusters
    .filter((c) => c.failureCode != null && INSTRUCTION_ADDRESSABLE.has(c.failureCode) && c.count >= K)
    .sort((a, b) => b.count - a.count)[0];
  if (cluster) {
    return { rule: "R2", failureCode: cluster.failureCode, clusterCount: cluster.count, signalCount: null };
  }
  // R4 — false confidence (high pass, low oracle).
  if (step.quality.verdictPassRate >= 0.8 && (step.quality.oracleSufficientRate ?? 0) < 0.5) {
    return { rule: "R4", failureCode: null, clusterCount: null, signalCount: null };
  }
  // R1 — underperforming headline (degraded/watch ~ score < 80).
  if (step.score != null && step.score < 80) {
    return { rule: "R1", failureCode: null, clusterCount: null, signalCount: null };
  }
  return null;
}

export function diagnoseTemplate(input: {
  detail: TemplateMetricsDetail;
  signals: TemplateRevisionSignal[];
  stepInstructions: Map<string, string>;
}): DiagnosisBundle[] {
  const versionDelta = input.detail.summary.versionComparison?.byDimension.verificationStrength ?? null;
  const signalsByStep = new Map<string, TemplateRevisionSignal[]>();
  for (const s of input.signals) {
    if (s.feedbackText == null) continue;
    (signalsByStep.get(s.stepTemplateId) ?? signalsByStep.set(s.stepTemplateId, []).get(s.stepTemplateId)!).push(s);
  }

  const eligible = input.detail.steps.filter((s) => s.confidence === "ok" && s.sampleSize >= SAMPLE_MIN);
  const bundles: DiagnosisBundle[] = [];
  for (const step of eligible) {
    const feedback = signalsByStep.get(step.stepTemplateId) ?? [];
    const mode = chooseRule(step, feedback);
    if (!mode) continue;
    const sampleTransitionIds = step.failureClusters.flatMap((c) => c.sampleTransitionIds).slice(0, 6);
    bundles.push({
      stepTemplateId: step.stepTemplateId,
      currentInstructions: input.stepInstructions.get(step.stepTemplateId) ?? "",
      targetedFailureMode: mode,
      evidence: {
        sampleTransitionIds,
        revisionSignalIds: feedback.map((f) => f.id),
        revisionFeedbackTexts: feedback.map((f) => f.feedbackText!).slice(0, 5),
        metricSnapshot: { score: step.score, verdictPassRate: step.quality.verdictPassRate, oracleSufficientRate: step.quality.oracleSufficientRate, versionDelta },
      },
    });
  }
  // Worst-first, capped.
  return bundles.sort((a, b) => (a.evidence.metricSnapshot.score ?? 101) - (b.evidence.metricSnapshot.score ?? 101)).slice(0, TOP_N);
}
