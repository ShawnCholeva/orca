// Presentation-only helpers for the Metrics tab. All numbers are computed server-side
// (F4); this module only formats them. Re-exports the contract types the views consume.
import type { Metric, StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

export type { StepMetrics, TemplateMetricsSummary } from "@orca/contracts";

export type StepStatus = "healthy" | "watch" | "degraded";

export const statusMeta: Record<StepStatus, { tone: "run" | "warn" | "err"; color: string; label: string }> = {
  healthy: { tone: "run", color: "var(--run)", label: "Healthy" },
  watch: { tone: "warn", color: "var(--warn)", label: "Watch" },
  degraded: { tone: "err", color: "var(--err)", label: "Degraded" },
};

export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

export function statusForScore(score: number): StepStatus {
  return score >= 80 ? "healthy" : score >= 70 ? "watch" : "degraded";
}

export function healthOf(summary: TemplateMetricsSummary): number {
  return Math.round((summary.dimensions.verificationStrength.value ?? 0) * 100);
}

export function pctLabel(m: Metric): string {
  return m.value == null ? "—" : `${Math.round(m.value * 100)}%`;
}

export function latencyLabel(ms: number | null): string {
  return ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
