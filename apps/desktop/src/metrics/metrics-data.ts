// Presentation-only helpers for the Metrics tab. All numbers are computed server-side
// (F4); this module only formats them. Re-exports the contract types the views consume.
import type { Metric, StepMetrics, TemplateMetricsSummary, VerificationTier } from "@orca/contracts";

export type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

export type StepStatus = "healthy" | "watch" | "degraded" | "unverified";

export const statusMeta: Record<StepStatus, { tone: "run" | "warn" | "err"; color: string; label: string }> = {
  healthy: { tone: "run", color: "var(--run)", label: "Healthy" },
  watch: { tone: "warn", color: "var(--warn)", label: "Watch" },
  degraded: { tone: "err", color: "var(--err)", label: "Degraded" },
  // No conclusive verdict was ever produced — low verification COVERAGE, not low
  // quality. Actionable, not alarming: the step may be fine, we just haven't checked.
  unverified: { tone: "warn", color: "var(--accent)", label: "No check yet" },
};

export const verificationMeta: Record<VerificationTier, { label: string; color: string }> = {
  verified_executed: { label: "Run & tested", color: "var(--run)" },
  partially_verified: { label: "Partly verified", color: "var(--warn)" },
  ai_reviewed: { label: "Reviewed, not proven", color: "var(--warn)" },
  self_reported: { label: "Self-reported only", color: "var(--warn)" },
  unverified: { label: "No check yet", color: "var(--accent)" },
};

// Sample-weighted mean of conclusive step scores (unverified steps excluded).
export function workflowHealthFromSteps(steps: StepMetrics[]): number | null {
  const scored = steps.filter((s) => s.quality.verifiedSampleSize > 0);
  const wsum = scored.reduce((n, s) => n + s.sampleSize, 0);
  if (wsum === 0) return null;
  return Math.round(scored.reduce((n, s) => n + s.score * s.sampleSize, 0) / wsum);
}

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

export function statusForScore(score: number): StepStatus {
  return score >= 80 ? "healthy" : score >= 70 ? "watch" : "degraded";
}

// The score reflects verification STRENGTH; a step whose delivery was never
// independently verified (zero conclusive verdicts) is UNVERIFIED, not degraded —
// so it must not wear a failing grade it didn't earn. (#2)
export function statusForStep(step: StepMetrics): StepStatus {
  return step.quality.verifiedSampleSize === 0 ? "unverified" : statusForScore(step.score);
}

export function healthOf(summary: TemplateMetricsSummary): number | null {
  const v = summary.dimensions.verificationStrength.value;
  return v == null ? null : Math.round(v * 100);
}

export function pctLabel(m: Metric): string {
  return m.value == null ? "—" : `${Math.round(m.value * 100)}%`;
}

export function latencyLabel(ms: number | null): string {
  return ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
