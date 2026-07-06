import type { HarnessMetrics } from "../harness-metrics/usecases.js";
import { computeHarnessMetricsFromTransitions } from "../harness-metrics/usecases.js";
import type { MetricPeriod, TemplateMetricsSummary, StepMetrics } from "@orca/contracts";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, TIER_LABEL, buildArtifacts } from "./verification.js";

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

const FAILED_OUTCOME = new Set(["failed", "escalated", "denied"]);
const TREND_BUCKETS = 12;

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function p50(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function uniqueCapped(values: string[], cap = 12): string[] {
  return [...new Set(values)].slice(0, cap);
}
function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) { const k = key(it); if (k != null) out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export function deriveInsights(step: StepMetrics): string[] {
  const out: string[] = [];
  // I4a — false confidence: passes but the oracle is inadequate.
  if (step.quality.verdictPassRate >= 0.8 && step.quality.oracleSufficientRate < 0.5) {
    out.push("Passes, but the oracle is inadequate — verified output may not be the full specification.");
  }
  // I4b — cost without verification gain.
  if ((step.cost.meanTokens ?? 0) >= 4000 && step.score < 70) {
    out.push("High token cost with low verification gain.");
  }
  // I4c — loop / churn.
  if ((step.cost.meanRetries ?? 0) >= 1.5) {
    out.push("Loops between failed strategies — high retry churn.");
  }
  return out;
}

export function computeStepMetrics(input: {
  transitions: TemplateTransition[];
  stepRuns: TemplateStepRun[];
  stepNames: Map<string, { name: string; ordinal: number }>;
  nowIso: string;
  period: MetricPeriod;
}): StepMetrics[] {
  const byStep = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (!t.stepTemplateId) continue;
    (byStep.get(t.stepTemplateId) ?? byStep.set(t.stepTemplateId, []).get(t.stepTemplateId)!).push(t);
  }
  const runsByStep = new Map<string, TemplateStepRun[]>();
  for (const r of input.stepRuns) {
    (runsByStep.get(r.stepTemplateId) ?? runsByStep.set(r.stepTemplateId, []).get(r.stepTemplateId)!).push(r);
  }

  const sinceIso = windowStart(input.nowIso, input.period);
  const sinceMs = new Date(sinceIso).getTime();
  const spanMs = new Date(input.nowIso).getTime() - sinceMs;

  const steps: StepMetrics[] = [];
  for (const [stepTemplateId, ts] of byStep) {
    const meta = input.stepNames.get(stepTemplateId) ?? { name: stepTemplateId, ordinal: 999 };
    const stepRuns = runsByStep.get(stepTemplateId) ?? [];
    const stepCompletes = ts.filter((t) => t.transition.boundary === "step_complete");
    const evidenceCompletes = stepCompletes.filter((t) => t.transition.evidence);
    // The delivered result of a step is its FINAL attempt. A veto-then-pass step
    // emits two step_completes for one (run, step); scoring over both double-counts
    // the recovered veto and drags the headline to 50 even though the run delivered
    // (the recovered/failed counters already dedup to finals). Reduce to the final
    // attempt per run — the latest step_complete by createdAt — so the score reflects
    // the verified END state (p.62 oracle-adequacy: score the delivered state). (#1/#7)
    const finalStepCompletes = (() => {
      const byRun = new Map<string, (typeof stepCompletes)[number]>();
      for (const t of stepCompletes) {
        const key = t.transition.workflowRunId ?? t.transition.id;
        const prev = byRun.get(key);
        if (!prev || t.transition.createdAt > prev.transition.createdAt) byRun.set(key, t);
      }
      return [...byRun.values()];
    })();

    // CHANNEL 1 — quality / scope. verdictPassRate credits the independent refute
    // (RefuteFacet, 5.4) for no-oracle completions and scores over VERIFIED completes
    // (evidence OR conclusive refute); unverified completions are excluded — mirrors
    // verification_strength. sensor/oracle rates stay evidence-only.
    const vPass = (t: (typeof stepCompletes)[number]) =>
      t.transition.evidence?.verdict === "passed" ||
      (t.transition.evidence == null && t.transition.refute?.verdict === "upheld");
    const vFail = (t: (typeof stepCompletes)[number]) =>
      t.transition.evidence?.verdict === "failed" ||
      t.transition.evidence?.verdict === "partial" ||
      (t.transition.evidence == null && t.transition.refute?.verdict === "refuted");
    // An evaluation-failed completion (e.g. no scoring supplied) carries no
    // trustworthy verdict — exclude it so it is UNVERIFIED, never a verified pass. (#8)
    const isUnverifiedEval = (t: (typeof stepCompletes)[number]) =>
      t.transition.telemetry?.outcome.failure_code === "evaluation_failed";
    const verifiedCompletes = finalStepCompletes.filter((t) => !isUnverifiedEval(t) && (vPass(t) || vFail(t)));
    // null when nothing is verified (insufficient signal), distinct from 0 (all failed).
    const verificationValue = verifiedCompletes.length === 0 ? null :
      verifiedCompletes.filter(vPass).length / verifiedCompletes.length;
    const verdictPassRate = verificationValue ?? 0;

    // Verification-weighted score (SP1): each conclusive completion contributes its
    // tier confidence when it passed, 0 when it failed. Pure function of evidence.
    const tierByCompletion = new Map(finalStepCompletes.map((t) => [t, classifyTier(t)] as const));
    const conclusive = finalStepCompletes.filter((t) => tierByCompletion.get(t) !== "unverified");
    const scoreValue = conclusive.length === 0 ? null :
      conclusive.reduce((acc, t) => acc + (vPass(t) ? TIER_CONFIDENCE[tierByCompletion.get(t)!] : 0), 0) / conclusive.length;
    const stepTier = strongestTier(conclusive.map((t) => tierByCompletion.get(t)!));
    const falseAccept = conclusive.filter((t) => t.transition.refute?.verdict === "refuted").length;
    const falseAcceptanceRate = conclusive.length === 0 ? 0 : falseAccept / conclusive.length;

    const allSensors = evidenceCompletes.flatMap((t) => t.transition.evidence!.sensorsRun);
    // No sensors ran → null (unknown), NEVER 1. Absence of a check is not a perfect check.
    const sensorPassRate = allSensors.length === 0 ? null :
      allSensors.filter((s) => s.result === "passed").length / allSensors.length;
    const oracleSufficientRate = evidenceCompletes.length === 0 ? 0 :
      evidenceCompletes.filter((t) => t.transition.evidence!.oracleAdequacy.sufficient).length / evidenceCompletes.length;

    // CHANNEL 2 — cost / trajectory.
    const latencies = ts.map((t) => t.transition.telemetry?.latency_ms).filter((x): x is number => typeof x === "number");
    const tokens = ts.map((t) => t.transition.telemetry?.cost).filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => c.tokens_in + c.tokens_out);
    const usds = ts.map((t) => t.transition.telemetry?.cost?.usd).filter((x): x is number => typeof x === "number");
    const finals = (() => {
      const byKey = new Map<string, TemplateStepRun>();
      for (const r of stepRuns) {
        const k = r.workflowRunId; const prev = byKey.get(k);
        if (!prev || r.attempt > prev.attempt) byKey.set(k, r);
      }
      return [...byKey.values()];
    })();
    const meanRetries = finals.length === 0 ? null : mean(finals.map((r) => r.attempt - 1));

    // CHANNEL 3 — risk / boundary.
    const riskTs = ts.filter((t) => t.transition.risk);
    const riskClassDist = countBy(riskTs, (t) => t.transition.risk!.risk_class);
    const gateDecisionDist = countBy(riskTs, (t) => t.transition.risk!.gate_decision);
    const hardConstraintViolations = riskTs.reduce((n, t) => n + t.transition.risk!.hard_constraint_violations.length, 0);
    const approvalTs = riskTs.filter((t) => t.transition.risk!.approval);
    const approvals = { count: approvalTs.length, sampleTransitionIds: approvalTs.slice(0, 3).map((t) => t.transition.id) };

    // Failure clusters (categorical, deterministic).
    const failedTs = ts.filter((t) => FAILED_OUTCOME.has(t.transition.telemetry?.outcome.status ?? ""));
    const clusterMap = new Map<string, { failureCode: string | null; boundary: string; ids: string[] }>();
    for (const t of failedTs) {
      const fc = t.transition.telemetry!.outcome.failure_code;
      const key = `${fc ?? "null"}::${t.transition.boundary}`;
      const entry = clusterMap.get(key) ?? { failureCode: fc, boundary: t.transition.boundary, ids: [] };
      entry.ids.push(t.transition.id);
      clusterMap.set(key, entry);
    }
    const failureClusters = [...clusterMap.values()]
      .map((c) => ({ failureCode: c.failureCode, boundary: c.boundary, count: c.ids.length, sampleTransitionIds: c.ids.slice(0, 3) }))
      .sort((a, b) => b.count - a.count);

    // Counts.
    const passedFirstTry = finals.filter((r) => r.attempt === 1 && r.status === "passed").length;
    const recovered = finals.filter((r) => r.attempt > 1 && r.status === "passed").length;
    const failed = finals.filter((r) => FAILED_STATUSES.has(r.status)).length;
    const sampleSize = Math.max(finals.length, stepCompletes.length);

    // Trend (bucketed verification strength) + version boundaries.
    const trend: number[] = [];
    const versionBoundaries: number[] = [];
    if (sampleSize >= SAMPLE_MIN && spanMs > 0) {
      let lastVersion: number | null = null;
      for (let i = 0; i < TREND_BUCKETS; i++) {
        const lo = sinceMs + (spanMs * i) / TREND_BUCKETS;
        const hi = sinceMs + (spanMs * (i + 1)) / TREND_BUCKETS;
        const bucket = stepCompletes.filter((t) => {
          const at = new Date(t.transition.createdAt).getTime();
          return at >= lo && at < hi;
        });
        if (bucket.length > 0) {
          trend.push(Math.round((dimsFromTransitions(bucket).verification_strength.value ?? 0) * 100));
          const v = bucket[bucket.length - 1].templateVersion;
          if (lastVersion !== null && v !== lastVersion) versionBoundaries.push(i);
          lastVersion = v;
        } else {
          trend.push(trend.length > 0 ? trend[trend.length - 1] : 0);
        }
      }
    }

    // Recent raw reasons (full-fidelity tail) from step-run blocked_reason.
    const recentReasons = [...stepRuns]
      .filter((r) => r.blockedReason)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, 5)
      .map((r) => ({ at: r.finishedAt ?? r.startedAt ?? "", reason: r.blockedReason! }));

    const step: StepMetrics = {
      stepTemplateId, name: meta.name, ordinal: meta.ordinal,
      score: scoreValue == null ? 0 : Math.round(scoreValue * 100), sampleSize, confidence: sampleSize < SAMPLE_MIN ? "low" : "ok",
      runs: finals.length, passedFirstTry, recovered, failed,
      quality: {
        verdictPassRate, verifiedSampleSize: verifiedCompletes.length, sensorPassRate, oracleSufficientRate,
        untestedRegions: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.untestedRegions)),
        residualRisk: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.residualRisk)),
        oracleGaps: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
        limitingDimension: null,
      },
      cost: { p50LatencyMs: p50(latencies), meanTokens: mean(tokens), meanUsd: mean(usds), meanRetries },
      risk: { riskClassDist, gateDecisionDist, hardConstraintViolations, approvals },
      failureClusters,
      verification: {
        tier: stepTier, tierLabel: TIER_LABEL[stepTier], confidence: scoreValue ?? 0, falseAcceptanceRate,
        artifacts: buildArtifacts({
          hasEvidence: evidenceCompletes.length > 0, anySensors: allSensors.length > 0,
          oracleSufficientRate, oracleGaps: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
          hasRefute: finalStepCompletes.some((t) => t.transition.refute != null), falseAccept,
        }),
      },
      failureModes: [],
      reconciliation: null,
      trend, versionBoundaries, insights: [], recentReasons,
    };
    step.insights = deriveInsights(step);
    steps.push(step);
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}
