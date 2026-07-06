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

// Sample-weighted mean of scored step scores. Weight by scoredSampleSize — the
// denominator each score was actually computed over — not raw sampleSize, so a
// step with 50 runs but 2 scored ones doesn't put weight-50 on a 2-sample score.
export function workflowHealthFromSteps(steps: StepMetrics[]): number | null {
  const scored = steps.filter((s) => s.score != null);
  const wsum = scored.reduce((n, s) => n + s.quality.scoredSampleSize, 0);
  if (wsum === 0) return null;
  return Math.round(scored.reduce((n, s) => n + s.score! * s.quality.scoredSampleSize, 0) / wsum);
}

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

export function statusForScore(score: number): StepStatus {
  return score >= 80 ? "healthy" : score >= 70 ? "watch" : "degraded";
}

// score === null ⇔ nothing was scoreable (no conclusive verdicts AND no hard
// failures) — that's a coverage gap, not a grade. A numeric 0 is a real grade.
export function statusForStep(step: StepMetrics): StepStatus {
  return step.score == null ? "unverified" : statusForScore(step.score);
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
