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

export const bandMeta: Record<"strong" | "weak" | "needs_evidence", { tone: "run" | "warn" | "accent"; color: string }> = {
  strong: { tone: "run", color: "var(--run)" },
  weak: { tone: "warn", color: "var(--warn)" },
  needs_evidence: { tone: "accent", color: "var(--accent)" },
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

export type ChannelTone = "run" | "warn" | "err" | "accent";
export type Chip = { text: string; tone: ChannelTone };

export const toneColor: Record<ChannelTone, string> = {
  run: "var(--run)", warn: "var(--warn)", err: "var(--err)", accent: "var(--accent)",
};

// The data-driven verdict line: a plain-language health read plus its limiting cause —
// both derived from existing signals (band, score, failure modes). No new scoring.
export function verdictFor(step: StepMetrics): { health: string; cause: string; tone: ChannelTone } {
  const { score, failureModes, quality, verification } = step;
  let health: string;
  let tone: ChannelTone;
  if (verification.band.level === "needs_evidence") {
    health = "Not checked yet"; tone = "accent";
  } else if (score == null) {
    health = "Not scored yet"; tone = "accent";
  } else if (failureModes.length > 0 || score < 60) {
    health = "Needs attention"; tone = "err";
  } else if (score < 70) {
    health = "Holding, with gaps"; tone = "warn";
  } else {
    health = "Healthy"; tone = "run";
  }
  const cause = failureModes[0]?.label
    ?? quality.limitingDimension
    ?? (score != null && score < 70 ? `low score (${score})` : "nothing failing this period");
  return { health, cause, tone };
}

const CHECK_TEXT: Record<string, string> = {
  "Run & tested": "Ran the tests and they passed.",
  "Reviewed": "Its claims are checked; no code to run, so review is the right bar.",
  "Not tested": "Reviewed but not run — a step like this can be tested; it wasn't.",
  "Only self-reported": "Nothing independent checked it — add a grounding check or a reviewer.",
  "Not checked yet": "No check has run yet.",
};
// Band labels are a free string (daemon-produced); fall back on the band level for any
// label this switch doesn't recognize, so the copy stays meaningful either way.
const CHECK_FALLBACK: Record<"strong" | "weak" | "needs_evidence", string> = {
  strong: "Checked and holding up.",
  weak: "Only lightly checked so far.",
  needs_evidence: "No check has run yet.",
};

// The three telemetry channels (paper §3.5.1): how it's doing, how we checked it, and
// what's currently wrong — each a short plain-language line derived from existing signals.
export function channelsFor(step: StepMetrics): { doing: Chip; check: Chip; wrong: Chip } {
  const { score, runs, trend, verification, failureModes } = step;

  let doing: Chip;
  if (score == null) {
    doing = { text: "No score yet — needs more runs", tone: "accent" };
  } else {
    const word = score >= 80 ? "Strong" : score >= 60 ? "Holding" : "Struggling";
    const tone: ChannelTone = score >= 80 ? "run" : score >= 60 ? "warn" : "err";
    let trendSuffix = "";
    if (trend.length >= 2) {
      const first = trend[0]!;
      const last = trend[trend.length - 1]!;
      if (last < first) trendSuffix = " · falling";
      else if (last > first) trendSuffix = " · rising";
    }
    doing = { text: `${word} · ${score} across ${runs} runs${trendSuffix}`, tone };
  }

  const check: Chip = {
    text: CHECK_TEXT[verification.band.label] ?? CHECK_FALLBACK[verification.band.level],
    tone: bandMeta[verification.band.level].tone,
  };

  const top = failureModes[0];
  const wrong: Chip = top
    ? { text: `${top.label} ${top.count}× · ${Math.round(top.pct * 100)}%`, tone: "err" }
    : { text: "Nothing this period", tone: "run" };

  return { doing, check, wrong };
}
