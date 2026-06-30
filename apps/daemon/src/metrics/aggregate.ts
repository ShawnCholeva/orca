import type { HarnessMetrics } from "../harness-metrics/usecases.js";
import { computeHarnessMetricsFromTransitions } from "../harness-metrics/usecases.js";
import type { MetricPeriod, TemplateMetricsSummary } from "@orca/contracts";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";

export const SAMPLE_MIN = 5;

const PERIOD_MS: Record<MetricPeriod, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function windowStart(nowIso: string, period: MetricPeriod): string {
  return new Date(new Date(nowIso).getTime() - PERIOD_MS[period]).toISOString();
}

export function medianLatencyMs(ts: TemplateTransition[]): number | null {
  const xs = ts
    .map((t) => t.transition.telemetry?.latency_ms)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

const PASSED = new Set(["passed"]);
const FAILED_STATUSES = new Set(["failed", "blocked"]);

// Final attempt per distinct (run, step).
function finalAttempts(runs: TemplateStepRun[]): TemplateStepRun[] {
  const byKey = new Map<string, TemplateStepRun>();
  for (const r of runs) {
    const key = `${r.workflowRunId}::${r.stepTemplateId}`;
    const prev = byKey.get(key);
    if (!prev || r.attempt > prev.attempt) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export function firstPassRate(runs: TemplateStepRun[]): number | null {
  const finals = finalAttempts(runs);
  if (finals.length === 0) return null;
  const firstPass = finals.filter((r) => r.attempt === 1 && PASSED.has(r.status)).length;
  return firstPass / finals.length;
}

export function recoveredRate(runs: TemplateStepRun[]): number | null {
  const finals = finalAttempts(runs);
  if (finals.length === 0) return null;
  const recovered = finals.filter((r) => r.attempt > 1 && PASSED.has(r.status)).length;
  return recovered / finals.length;
}

export function failedCount(runs: TemplateStepRun[]): number {
  return finalAttempts(runs).filter((r) => FAILED_STATUSES.has(r.status)).length;
}

// Escalated: distinct (run, step) that had a require_approval/deny gate or a human
// intervention, over distinct (run, step) total.
export function escalatedRate(ts: TemplateTransition[]): number | null {
  const keys = new Set<string>();
  const escalated = new Set<string>();
  for (const { transition: t } of ts) {
    if (!t.workflowRunId || !t.workflowStepRunId) continue;
    const key = `${t.workflowRunId}::${t.workflowStepRunId}`;
    keys.add(key);
    const gate = t.risk?.gate_decision;
    const humans = t.telemetry?.human_interventions?.length ?? 0;
    if (gate === "require_approval" || gate === "deny" || humans > 0) escalated.add(key);
  }
  if (keys.size === 0) return null;
  return escalated.size / keys.size;
}

function toSummaryDimensions(m: HarnessMetrics): TemplateMetricsSummary["dimensions"] {
  return {
    trajectoryEfficiency: m.trajectory_efficiency,
    verificationStrength: m.verification_strength,
    recovery: m.recovery,
    stateConsistency: m.state_consistency,
    safetyCompliance: m.safety_compliance,
    replayability: m.replayability,
  };
}

function delta(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

function dimsFromTransitions(ts: TemplateTransition[]): HarnessMetrics {
  return computeHarnessMetricsFromTransitions(ts.map((t) => t.transition));
}

export function computeTemplateSummary(input: {
  templateId: string;
  name: string;
  latestVersion: number;
  runCount: number;
  versions: { version: number; runs: number; firstSeenAt: string }[];
  current: { transitions: TemplateTransition[]; stepRuns: TemplateStepRun[] };
  prior: { transitions: TemplateTransition[]; stepRuns: TemplateStepRun[] };
}): TemplateMetricsSummary {
  const cur = dimsFromTransitions(input.current.transitions);
  const prev = dimsFromTransitions(input.prior.transitions);
  const curLatency = medianLatencyMs(input.current.transitions);
  const priorLatency = medianLatencyMs(input.prior.transitions);

  // Version comparison: latest vs immediately-prior version present in the window.
  const presentVersions = [...new Set(input.current.transitions.map((t) => t.templateVersion))].sort((a, b) => b - a);
  let versionComparison: TemplateMetricsSummary["versionComparison"] = null;
  if (presentVersions.length >= 2) {
    const [latestV, priorV] = presentVersions;
    const latestDims = dimsFromTransitions(input.current.transitions.filter((t) => t.templateVersion === latestV));
    const priorDims = dimsFromTransitions(input.current.transitions.filter((t) => t.templateVersion === priorV));
    versionComparison = {
      latest: latestV, prior: priorV,
      byDimension: {
        trajectoryEfficiency: delta(latestDims.trajectory_efficiency.value, priorDims.trajectory_efficiency.value),
        verificationStrength: delta(latestDims.verification_strength.value, priorDims.verification_strength.value),
        recovery: delta(latestDims.recovery.value, priorDims.recovery.value),
        stateConsistency: delta(latestDims.state_consistency.value, priorDims.state_consistency.value),
        safetyCompliance: delta(latestDims.safety_compliance.value, priorDims.safety_compliance.value),
        replayability: delta(latestDims.replayability.value, priorDims.replayability.value),
      },
    };
  }

  return {
    templateId: input.templateId, name: input.name, latestVersion: input.latestVersion,
    runs: input.runCount,
    dimensions: toSummaryDimensions(cur),
    firstPass: firstPassRate(input.current.stepRuns),
    recovered: recoveredRate(input.current.stepRuns),
    escalated: escalatedRate(input.current.transitions),
    latencyP50Ms: curLatency,
    deltas: {
      trajectoryEfficiency: delta(cur.trajectory_efficiency.value, prev.trajectory_efficiency.value),
      verificationStrength: delta(cur.verification_strength.value, prev.verification_strength.value),
      recovery: delta(cur.recovery.value, prev.recovery.value),
      stateConsistency: delta(cur.state_consistency.value, prev.state_consistency.value),
      safetyCompliance: delta(cur.safety_compliance.value, prev.safety_compliance.value),
      replayability: delta(cur.replayability.value, prev.replayability.value),
      latencyP50Ms: delta(curLatency, priorLatency),
    },
    versionComparison,
    versions: input.versions,
    confidence: input.runCount < SAMPLE_MIN ? "low" : "ok",
  };
}
