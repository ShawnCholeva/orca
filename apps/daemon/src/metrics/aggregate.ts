import type { HarnessMetrics } from "../harness-metrics/usecases.js";
import { computeHarnessMetricsFromTransitions } from "../harness-metrics/usecases.js";
import { VERSION_DELTA_MIN_PER_SIDE } from "@orca/contracts";
import type { MetricPeriod, MetricScope, TemplateMetricsSummary, StepMetrics, NodeVersionHistory, CountedRate } from "@orca/contracts";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import type { VindicationOutcome } from "./vindication.js";
import { classifyTier, strongestTier, TIER_LABEL, buildArtifacts, computeCalibration, CALIBRATION_DIVERGENCE, CALIBRATION_SCORE_MIN } from "./verification.js";
import type { CalibrationEntry } from "./verification.js";
import { labelForFailure } from "./failure-labels.js";
import { composedScore } from "./composed-score.js";
import { deriveConfidenceReason } from "./confidence-reason.js";
import { classifyInfraReason } from "./infra-failure.js";
import { FAILED_TRANSITION_STATUSES } from "@orca/contracts";
import { isSubstrateBlockedCode, type StepOutcomeBreakdown } from "@orca/contracts";
import { deriveStepBlockedCause } from "../workflows/steps/blocked-cause.js";

export const SAMPLE_MIN = 5;
// Per-side minimum of SCORED samples before a per-step version delta is emitted.
// A designed floor (not a significance test) — same spirit as SAMPLE_MIN.
export const VERSION_MIN = 2;

/**
 * What one rescue costs, relative to a whole completion, in the score denominator.
 * A step the system had to restart to get through is less trustworthy than one that
 * ran clean — but it did deliver, so it is not a whole failure either.
 */
export const STALL_WEIGHT = 0.5;

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

/**
 * A worker gate creates a real `workflow_step_runs` row (`__gate__:<nodeId>`) so
 * the engine can hang a session off it. It is not a step of the workflow, and
 * four separate places in this file had their own copy of this prefix check —
 * one of which was missed, which is how gate surrogates got into the summary's
 * first-pass and recovery rates.
 */
export function isGateSurrogate(stepTemplateId: string | null | undefined): boolean {
  return stepTemplateId?.startsWith("__gate__:") === true;
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

/** Step statuses that represent a reached outcome. `pending`/`active` have not. */
const TERMINAL_STEP_STATUSES = new Set(["passed", "failed", "blocked", "skipped"]);

/**
 * Final attempts that actually reached an outcome.
 *
 * `firstPass`/`recovered` divided by every final attempt, which on the founder's
 * data included a step that was still running. A thing in progress is not an
 * observation of that thing, so it cannot appear in a rate about outcomes — the
 * same rule the run ledger applies when it aggregates over terminated runs only.
 *
 * This exclusion is DEFINITIONAL and deliberately the only one here. Infra-killed
 * steps stay in the population: removing them would answer "when the substrate
 * let it finish, how often did it pass first time", which is a different question
 * than the label asks, and it would rest on classifyInfraReason matching free
 * text with a count interpolated into it. Separating workflow failures from
 * substrate kills is worth doing and is coming, on a recorded step-level cause
 * rather than parsed English — at which point this becomes a four-way split
 * (passed-first-time / failed-on-merit / infra-killed / still-running) whose
 * parts sum to the total, so the reader sees the cut instead of inheriting it.
 *
 * Note a step whose latest attempt is non-terminal drops out even if an earlier
 * attempt passed. That is reachable and normal: a gate rejection routes backward
 * and nextAttemptForStep opens a new attempt. The earlier pass was superseded by
 * that rejection, so the step genuinely has no settled outcome yet.
 */
/**
 * The full partition of final attempts: every step lands in exactly one bucket
 * and the parts sum to the total.
 *
 * Cause comes from `deriveStepBlockedCause`, never from the raw `blocked_code`
 * column and never from `classifyInfraReason`. The column alone cannot tell a
 * verified cause from a historical absence, and the classifier answers the FAMILY
 * question ("something in the substrate failed") which is not specific enough to
 * carry a claim — it stays advisory, feeding `infrastructureFailures`.
 *
 * So a step that stopped before the column existed counts as `unattributed`
 * rather than being guessed into `failedOnMerit` or `infraKilled`. That bucket is
 * expected to dominate at first and empties on its own; nothing backfills it,
 * because storing a guess beside a verified value under one name is the defect
 * the column was added to remove.
 */
export function stepOutcomeBreakdown(runs: TemplateStepRun[]): StepOutcomeBreakdown {
  const finals = finalAttempts(runs);
  const b = {
    passedFirstTime: 0, passedAfterRetry: 0, failedOnMerit: 0,
    infraKilled: 0, unattributed: 0, skipped: 0, stillRunning: 0,
  };
  let anyInferred = false;
  const runIds = new Set<string>();
  for (const r of finals) {
    runIds.add(r.workflowRunId);
    if (!TERMINAL_STEP_STATUSES.has(r.status)) { b.stillRunning += 1; continue; }
    if (r.status === "skipped") { b.skipped += 1; continue; }
    if (PASSED.has(r.status)) {
      if (r.attempt === 1) b.passedFirstTime += 1;
      else b.passedAfterRetry += 1;
      continue;
    }
    const cause = deriveStepBlockedCause({ blockedCode: r.blockedCode, blockedReason: r.blockedReason });
    if (cause === null || cause.inferred) {
      if (cause?.inferred) anyInferred = true;
      b.unattributed += 1;
      continue;
    }
    if (isSubstrateBlockedCode(cause.code)) b.infraKilled += 1;
    else b.failedOnMerit += 1;
  }
  return {
    ...b,
    scope: {
      steps: finals.length,
      runs: runIds.size,
      // Scope is a property of the aggregation, so this claim is built here rather
      // than inherited: one template per summary, by construction.
      templates: finals.length > 0 ? 1 : 0,
      inferred: anyInferred,
    },
  };
}

export function settledFinalAttempts(runs: TemplateStepRun[]): TemplateStepRun[] {
  return finalAttempts(runs).filter((r) => TERMINAL_STEP_STATUSES.has(r.status));
}

export function firstPassRate(runs: TemplateStepRun[]): CountedRate | null {
  const settled = settledFinalAttempts(runs);
  if (settled.length === 0) return null;
  const firstPass = settled.filter((r) => r.attempt === 1 && PASSED.has(r.status)).length;
  return { pos: firstPass, n: settled.length };
}

export function recoveredRate(runs: TemplateStepRun[]): CountedRate | null {
  const settled = settledFinalAttempts(runs);
  if (settled.length === 0) return null;
  const recovered = settled.filter((r) => r.attempt > 1 && PASSED.has(r.status)).length;
  return { pos: recovered, n: settled.length };
}

// Escalated: distinct (run, step) that had a require_approval/deny gate or a human
// intervention, over distinct (run, step) total.
export function escalatedRate(ts: TemplateTransition[]): CountedRate | null {
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
  return { pos: escalated.size, n: keys.size };
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
  // Pre-computed calibration to share with a caller (e.g. getTemplateMetricsDetail)
  // that already computed a vindication-aware calibration for the same transitions —
  // keeps the summary's calibration readout from diverging from the step scores'.
  // Omitted (undefined) by standalone callers (e.g. the summaries-list endpoint),
  // which keep computing it here, prior-based, exactly as before.
  calibration?: CalibrationEntry[];
}): Omit<TemplateMetricsSummary, "scope"> {
  // Gate surrogate transitions (__gate__:*) are steps only for tile-rate/escalation
  // purposes (computeStepMetrics already excludes them there); they must not feed the
  // six-dimension harness metrics, or gate approvals/denials contaminate verificationStrength
  // etc. — same predicate computeStepMetrics uses.
  const isGateTransition = (t: TemplateTransition) => isGateSurrogate(t.stepTemplateId);
  const currentNonGate = input.current.transitions.filter((t) => !isGateTransition(t));
  const priorNonGate = input.prior.transitions.filter((t) => !isGateTransition(t));

  const cur = dimsFromTransitions(currentNonGate);
  const prev = dimsFromTransitions(priorNonGate);
  // Gates are excluded from the duration median too, and the split from the
  // comment above is deliberate rather than an oversight. RATES legitimately
  // count gate surrogates — a gate that escalated is a real escalation and
  // belongs in that denominator. A duration MEDIAN is a different aggregation
  // with a different appropriate population: a step's latency answers "how long
  // did the agent take to do the work", a gate's answers "how long did the check
  // take", and pooling them yields the median of neither. Gate durations are not
  // lost — GateMetrics reports its own p50 over exactly these transitions.
  //
  // This mattered the moment gate surrogates began emitting transitions at all
  // (be490cb): before that the two arguments were the same array, so passing the
  // unfiltered one was harmless. It would otherwise have moved a shipped number
  // with nobody touching it — the Triage 16/100 failure, where adjacent figures
  // were each computed over a different population with nothing saying so.
  const curLatency = medianLatencyMs(currentNonGate);
  const priorLatency = medianLatencyMs(priorNonGate);

  // Version comparison: latest vs immediately-prior version present in the window.
  const presentVersions = [...new Set(input.current.transitions.map((t) => t.templateVersion))].sort((a, b) => b - a);
  let versionComparison: TemplateMetricsSummary["versionComparison"] = null;
  // Gated at emit, per side: a delta between one run and three is noise dressed
  // as a trend, and a consumer given the number has no way to know. Absent is
  // the honest shape below the floor.
  const runsOf = (v: number) => input.versions.find((x) => x.version === v)?.runs ?? 0;
  if (presentVersions.length >= 2 && presentVersions.slice(0, 2).every((v) => runsOf(v) >= VERSION_DELTA_MIN_PER_SIDE)) {
    const [latestV, priorV] = presentVersions;
    const latestDims = dimsFromTransitions(currentNonGate.filter((t) => t.templateVersion === latestV));
    const priorDims = dimsFromTransitions(currentNonGate.filter((t) => t.templateVersion === priorV));
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
    // Gate surrogates are excluded here for a reason distinct from the latency
    // median above: they cannot answer the question these rates ask. closeSurrogate
    // sets status='passed' unconditionally — on every path, including the aborts
    // that discard the gate's output — so each surrogate is a guaranteed first-pass
    // in both numerator and denominator. On the founder's data that is 4 of 22 rows
    // that could not have been anything else. Worse for recovery: a gate loop-back
    // bumps the surrogate's attempt, producing attempt>1 with status passed, which
    // recoveredRate reads as a step that failed and then recovered — so re-entering
    // a gate looked like the workflow healing itself.
    firstPass: firstPassRate(input.current.stepRuns.filter((r) => !isGateSurrogate(r.stepTemplateId))),
    recovered: recoveredRate(input.current.stepRuns.filter((r) => !isGateSurrogate(r.stepTemplateId))),
    escalated: escalatedRate(input.current.transitions),
    stepOutcomes: stepOutcomeBreakdown(input.current.stepRuns.filter((r) => !isGateSurrogate(r.stepTemplateId))),
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
    calibration: input.calibration ?? computeCalibration(input.current.transitions),
    // TODO(gate-metrics): populated in the gates-wiring task
    gateHealth: { value: null, grade: null, delta: null, confidence: "low" },
  };
}

// Derived from the enum, not hand-listed: a status added to TransitionStatus
// lands on the failed side by default. See FAILED_TRANSITION_STATUSES.
const FAILED_OUTCOME: ReadonlySet<string> = new Set(FAILED_TRANSITION_STATUSES);
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

export function deriveInsights(step: StepMetrics, calibration?: CalibrationEntry[]): string[] {
  const out: string[] = [];
  const far = step.verification.falseAcceptanceRate;
  if (far >= 0.2) {
    out.push(`Approves work without proof ${Math.round(far * 100)}% of the time — bad output can slip through.`);
  }
  if (step.verification.tier === "ai_reviewed" || step.verification.tier === "self_reported") {
    out.push("Consistently passes but is never independently proven — if later steps fail on this output, that's the signal to strengthen it.");
  }
  const top = step.failureModes[0];
  if (top && top.count > 0) out.push(`Most common problem: ${top.label.toLowerCase()} (${top.count}×).`);
  if ((step.cost.meanRetries ?? 0) >= 1.5) out.push("Loops between failed attempts — high retry churn.");
  // The score now feeds a calibratable source's measured survival rate in place of
  // the designed prior (composedScore -> effectiveSourceConfidence). Only surface a
  // calibratable source the step actually used (via scoreBreakdown.verifierMix).
  const mix = step.quality.scoreBreakdown?.verifierMix;
  for (const c of calibration ?? []) {
    if (c.state !== "measured" || c.measured == null || c.sampleSize < CALIBRATION_SCORE_MIN) continue;
    if (Math.abs(c.measured - c.assumed) <= CALIBRATION_DIVERGENCE) continue;
    const used = c.source === "executable" ? (mix?.executable ?? 0) > 0 : c.source === "grounding" ? (mix?.grounding ?? 0) > 0 : false;
    if (!used) continue;
    const label = c.source === "grounding" ? "Grounding claims" : "Executed checks";
    out.push(`${label} hold up ${Math.round(c.measured * 100)}% of the time here vs the ${Math.round(c.assumed * 100)}% assumed — the score now uses the measured rate.`);
  }
  return out;
}

export function computeStepMetrics(input: {
  transitions: TemplateTransition[];
  stepRuns: TemplateStepRun[];
  stepNames: Map<string, { name: string; ordinal: number; description?: string; completionPolicy?: string }>;
  nowIso: string;
  period: MetricPeriod;
  calibration?: CalibrationEntry[];
  scope?: MetricScope;
  lineage?: Map<string, NodeVersionHistory>;
  requiresExecution?: Set<string>;
  gateApprovedByCompletion?: (t: TemplateTransition) => boolean;
  vindicationByCompletion?: (t: TemplateTransition) => VindicationOutcome | "excluded" | undefined;
  verifyingGateNameByStep?: Map<string, string>;
}): StepMetrics[] {
  // Scope to the CURRENT template's steps: a step id not in stepNames is a fossil
  // from a retired version, or the step-era of a node that is now a gate — either way
  // it isn't part of today's pipeline. If the step set is unknown (empty), don't filter.
  // scope="all" disables this id-shape filter entirely (pre-A-i behavior).
  const scope = input.scope ?? "current";
  const currentSteps = input.stepNames;
  const inCurrentShape = scope === "all" ? () => true : (id: string) => currentSteps.size === 0 || currentSteps.has(id);

  const byStep = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (!t.stepTemplateId) continue;
    if (isGateSurrogate(t.stepTemplateId)) continue;
    if (!inCurrentShape(t.stepTemplateId)) continue;
    (byStep.get(t.stepTemplateId) ?? byStep.set(t.stepTemplateId, []).get(t.stepTemplateId)!).push(t);
  }
  const runsByStep = new Map<string, TemplateStepRun[]>();
  for (const r of input.stepRuns) {
    if (isGateSurrogate(r.stepTemplateId)) continue;
    if (!inCurrentShape(r.stepTemplateId)) continue;
    (runsByStep.get(r.stepTemplateId) ?? runsByStep.set(r.stepTemplateId, []).get(r.stepTemplateId)!).push(r);
  }

  const sinceIso = windowStart(input.nowIso, input.period);
  const sinceMs = new Date(sinceIso).getTime();
  const spanMs = new Date(input.nowIso).getTime() - sinceMs;

  const steps: StepMetrics[] = [];
  for (const [stepTemplateId, ts] of byStep) {
    const requiresExec = input.requiresExecution?.has(stepTemplateId) ?? false;
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

    // Final attempt per run (step-run rows) — used by scoring (hard failures) and cost.
    const finals = (() => {
      const byKey = new Map<string, TemplateStepRun>();
      for (const r of stepRuns) {
        const k = r.workflowRunId; const prev = byKey.get(k);
        if (!prev || r.attempt > prev.attempt) byKey.set(k, r);
      }
      return [...byKey.values()];
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
    // tier confidence when it passed, 0 when it failed; a self_reported completion
    // (claim stands, nothing independent) contributes the self_reported confidence.
    // Hard failures — runs that died without ever emitting a step_complete — count
    // as 0 in the denominator: a step that fails often must not keep a high score
    // just because its failures never reached scoring. Pure function of evidence.
    // A run's FINAL step-run attempt can hard-fail AFTER an earlier attempt already
    // produced a passing step_complete (distinct from veto-then-pass, where the FINAL
    // attempt is the pass). Left alone, `finalStepCompletes` keeps that earlier pass
    // and credits it — a stale, superseded verdict. Reclassify the run as a hard fail
    // ONLY when the failed final attempt's finishedAt is provably after the stale
    // completion's createdAt; with no finishedAt there is no ordering evidence, so we
    // fall back to current behavior rather than guess.
    const completionByRunId = new Map(finalStepCompletes.map((t) => [t.transition.workflowRunId, t] as const));
    const supersededByHardFail = new Set(
      finals
        .filter((r) => FAILED_STATUSES.has(r.status) && r.finishedAt != null)
        .filter((r) => {
          const completion = completionByRunId.get(r.workflowRunId);
          return completion != null && r.finishedAt! > completion.transition.createdAt;
        })
        .map((r) => r.workflowRunId)
    );
    const tierByCompletion = new Map(finalStepCompletes.map((t) => [t, classifyTier(t)] as const));
    const scoreByCompletion = new Map(finalStepCompletes.map((t) =>
      [t, composedScore(t, input.calibration, { gateApproved: input.gateApprovedByCompletion?.(t) ?? false })] as const));
    const isConclusive = (t: (typeof finalStepCompletes)[number]) =>
      scoreByCompletion.get(t)!.established && !isUnverifiedEval(t) && !supersededByHardFail.has(t.transition.workflowRunId ?? "");
    const conclusive = finalStepCompletes.filter(isConclusive);
    const completeRunIds = new Set(finalStepCompletes.map((t) => t.transition.workflowRunId).filter((x): x is string => x != null));
    const hardFailedFinals = finals.filter((r) =>
      FAILED_STATUSES.has(r.status) && (!completeRunIds.has(r.workflowRunId) || supersededByHardFail.has(r.workflowRunId)));
    // Rescues are counted across EVERY attempt, not just finals: a run that stalled
    // twice and then passed still cost two rescues, and `finalAttempts` would hide them.
    const rescueCount = stepRuns.reduce((acc, r) => acc + (r.stallRescues ?? 0), 0);
    const contribution = (t: (typeof stepCompletes)[number]) => scoreByCompletion.get(t)!.score;
    const scoreOver = (
      completes: typeof finalStepCompletes,
      hardFails: number,
      rescues: number
    ): { n: number; count: number; value: number | null } => {
      const conc = completes.filter(isConclusive);
      // The null/needs_evidence sentinel and the VERSION_MIN sample floor must both key
      // off the UNWEIGHTED population (count) — a rescue discounts a delivered result,
      // it must never manufacture a scoreable population (or clear the version-delta
      // floor) out of one that was otherwise empty.
      const count = conc.length + hardFails;
      if (count === 0) return { n: 0, count, value: null };
      const n = count + STALL_WEIGHT * rescues;
      return { n, count, value: conc.reduce((acc, t) => acc + contribution(t), 0) / n };
    };
    const headline = scoreOver(finalStepCompletes, hardFailedFinals.length, rescueCount);
    const scoreValue = headline.value;
    const scoredSampleSize = headline.n;
    const stepTier = strongestTier(conclusive.map((t) => tierByCompletion.get(t)!));
    const falseAccept = conclusive.filter((t) => t.transition.refute?.verdict === "refuted").length;
    const falseAcceptanceRate = conclusive.length === 0 ? 0 : falseAccept / conclusive.length;

    // Per-step, per-version score delta (latest vs prior version in the window): the
    // falsifier's "did the TARGETED step improve" signal (0..1 scale).
    let versionScoreDelta: number | null = null;
    let versionScoreDeltaVersions: { latest: number; prior: number } | null = null;
    let versionInvalidOutputRateDelta: number | null = null;
    // Union of completed AND hard-failed version identity: a version whose runs of
    // this step ALL hard-failed (no step_complete) must still be visible here — an
    // all-hard-fail applied version is exactly the regression the falsifier must catch.
    const versionsPresent = [...new Set([
      ...finalStepCompletes.map((t) => t.templateVersion),
      ...hardFailedFinals.map((r) => r.templateVersion),
    ])].sort((a, b) => b - a);
    if (versionsPresent.length >= 2) {
      const [latestV, priorV] = versionsPresent;
      const forVersion = (v: number) => scoreOver(
        finalStepCompletes.filter((t) => t.templateVersion === v),
        hardFailedFinals.filter((r) => r.templateVersion === v).length,
        stepRuns.filter((r) => r.templateVersion === v).reduce((acc, r) => acc + (r.stallRescues ?? 0), 0),
      );
      const a = forVersion(latestV), b = forVersion(priorV);
      // Gate on `count` (unweighted scored samples), not `n` (rescue-weighted): rescues
      // alone must not clear the floor and let an under-powered comparison fire.
      if (a.count >= VERSION_MIN && b.count >= VERSION_MIN && a.value != null && b.value != null) {
        versionScoreDelta = a.value - b.value;
        versionScoreDeltaVersions = { latest: latestV, prior: priorV };
      }

      // Schema-canary signal: invalid-output completion rate per version, completions-only
      // basis (an invalid_output failure implies a step_complete happened), same floor.
      // Unlike versionScoreDelta, a version present only via hard-fails yields null here
      // (below VERSION_MIN on completions) — intended, since invalid_output requires a completion.
      const invalidRateFor = (v: number): number | null => {
        const completes = finalStepCompletes.filter((t) => t.templateVersion === v);
        if (completes.length < VERSION_MIN) return null;
        return completes.filter((t) => t.transition.telemetry?.outcome.failure_code === "invalid_output").length / completes.length;
      };
      const ia = invalidRateFor(latestV), ib = invalidRateFor(priorV);
      if (ia != null && ib != null) versionInvalidOutputRateDelta = ia - ib;
    }

    const allSensors = evidenceCompletes.flatMap((t) => t.transition.evidence!.sensorsRun);
    // No sensors ran → null (unknown), NEVER 1. Absence of a check is not a perfect check.
    const sensorPassRate = allSensors.length === 0 ? null :
      allSensors.filter((s) => s.result === "passed").length / allSensors.length;
    // Oracle adequacy is an EXECUTION-oracle fact, so the denominator is the
    // sensor-bearing completions only — grounding-only evidence (no sensors)
    // must keep the rate null (unknown/inapplicable), NEVER an explicit 0.
    const sensorCompletes = evidenceCompletes.filter((t) => t.transition.evidence!.sensorsRun.length > 0);
    const oracleSufficientRate = sensorCompletes.length === 0 ? null :
      sensorCompletes.filter((t) => t.transition.evidence!.oracleAdequacy.sufficient).length / sensorCompletes.length;
    const groundingCompletes = evidenceCompletes.filter((t) =>
      (t.transition.evidence!.grounding?.checks ?? []).some((c) => c.result !== "skipped"));

    // CHANNEL 2 — cost / trajectory.
    const latencies = ts.map((t) => t.transition.telemetry?.latency_ms).filter((x): x is number => typeof x === "number");
    const tokens = ts.map((t) => t.transition.telemetry?.cost).filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => c.tokens_in + c.tokens_out);
    const usds = ts.map((t) => t.transition.telemetry?.cost?.usd).filter((x): x is number => typeof x === "number");
    const meanRetries = finals.length === 0 ? null : mean(finals.map((r) => r.attempt - 1));

    // CHANNEL 3 — risk / boundary.
    const riskTs = ts.filter((t) => t.transition.risk);
    const riskClassDist = countBy(riskTs, (t) => t.transition.risk!.risk_class);
    const gateDecisionDist = countBy(riskTs, (t) => t.transition.risk!.gate_decision);
    const hardConstraintViolations = riskTs.reduce((n, t) => n + t.transition.risk!.hard_constraint_violations.length, 0);
    const approvalTs = riskTs.filter((t) => t.transition.risk!.approval);
    const approvals = { count: approvalTs.length, sampleTransitionIds: approvalTs.slice(0, 3).map((t) => t.transition.id) };

    // Failure clusters (categorical, deterministic). step_complete failures dedupe
    // to FINAL attempts — a recovered veto is not an outstanding failure — while
    // other boundaries (tool_gate etc.) keep every occurrence.
    const finalCompleteIds = new Set(finalStepCompletes.map((t) => t.transition.id));
    const failedTs = ts.filter((t) =>
      FAILED_OUTCOME.has(t.transition.telemetry?.outcome.status ?? "") &&
      (t.transition.boundary !== "step_complete" || finalCompleteIds.has(t.transition.id)));
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

    // Readable taxonomy: categorical failures (mapped to plain labels) + verification weaknesses.
    const verifWeaknesses: { label: string; count: number }[] = [];
    if (falseAccept > 0) verifWeaknesses.push({ label: "Approved something the independent check overturned", count: falseAccept });
    const rawModes = [
      ...failureClusters.map((c) => ({ label: labelForFailure(c.failureCode), count: c.count })),
      ...verifWeaknesses,
    ].filter((m) => m.count > 0);
    const modeTotal = rawModes.reduce((n, m) => n + m.count, 0) || 1;
    const failureModes = rawModes
      .map((m) => ({ label: m.label, count: m.count, pct: m.count / modeTotal }))
      .sort((a, b) => b.count - a.count);

    // The independent reviewer's own words for the most recent overturned claims —
    // the WHY behind falseAcceptanceRate, surfaced to humans and mined by diagnosis.
    const recentRefuteReasons = [...finalStepCompletes]
      .filter((t) => t.transition.refute?.verdict === "refuted" && t.transition.refute.reason)
      .sort((x, y) => y.transition.createdAt.localeCompare(x.transition.createdAt))
      .slice(0, 3)
      .map((t) => t.transition.refute!.reason!);

    const reconciliation = conclusive.length === 0 ? null : {
      claimedComplete: true, verifiedTierLabel: TIER_LABEL[stepTier], refuted: falseAccept > 0,
      refuteReason: recentRefuteReasons[0] ?? null,
    };

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

    // Substrate failures, aggregated. Deliberately NOT merged into failureModes:
    // a step that crashed out never got to be judged, so counting it as a quality
    // failure reports the daemon while naming the workflow. Without this a step
    // could score in the teens off blocked finals while its failure list sat empty,
    // because that list is built only from evidence/refute facets — which, on a
    // crashed-then-retried step, all say "passed".
    const infraCounts = new Map<string, number>();
    for (const r of stepRuns) {
      const label = classifyInfraReason(r.blockedReason);
      if (label !== null) infraCounts.set(label, (infraCounts.get(label) ?? 0) + 1);
    }
    const infrastructureFailures = [...infraCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    // Inspectable breakdown of the composed score over the conclusive completions
    // (same population scoreOver/scoredSampleSize weight by) — lets the UI/falsifier
    // see WHICH verifiers drove the score, not just the final number. Fail-edge
    // completions (composedScore's zero(), base===0) are excluded here: they aren't
    // "coverage-capped" or "self-reported", they're failures, and including them would
    // mislabel a failed step as weakly-verified. Unknown (self-report-only) completions
    // are already excluded upstream by `established` (Task 1/2), so among these
    // conclusive rows base===0 marks only a refuted/evidence-failed zero() fail-edge.
    const concScores = conclusive.map((t) => scoreByCompletion.get(t)!).filter((s) => s.base !== 0);
    const scoredCount = concScores.length;
    const executableCount = concScores.filter((s) => s.verifiers.executable).length;
    // Ceiling-relative: a step that can't be executed is judged at its best-available
    // verifier (grounding/review), not against an execution bar it could never meet.
    const ceilingCount = requiresExec
      ? executableCount
      : concScores.filter((s) => s.verifiers.grounding || s.verifiers.independentReview).length;
    const bandLevel: "strong" | "weak" | "needs_evidence" =
      scoreValue == null ? "needs_evidence"
      : ceilingCount > scoredCount / 2 ? "strong"
      : "weak";
    const BAND_LABEL = {
      strong: requiresExec ? "Run & tested" : "Reviewed",
      weak: requiresExec ? "Not tested" : "Only self-reported",
      needs_evidence: "Not checked yet",
    } as const;
    // Uncertainty readout: per-source assumed-vs-measured + sample size, straight from
    // computeCalibration — lets a human audit WHY the score moved (paper §5.2.2: expose
    // scope and uncertainty). Template-wide (not step-scoped); omitted when no calibration
    // was supplied, same as vindication below.
    const calibrationMix = input.calibration && Object.fromEntries(
      input.calibration.map((c) => [c.source, { assumed: c.assumed, measured: c.measured, sampleSize: c.sampleSize, state: c.state }])
    );
    const scoreBreakdown = {
      meanBase: mean(concScores.map((s) => s.base)),
      meanCoverage: mean(concScores.map((s) => s.coverage)),
      coverageLimited: concScores.filter((s) => s.coverage < 1).length,
      verifierMix: {
        executable: concScores.filter((s) => s.verifiers.executable).length,
        grounding: concScores.filter((s) => s.verifiers.grounding).length,
        independentReview: concScores.filter((s) => s.verifiers.independentReview).length,
        selfReportOnly: concScores.filter((s) => !s.verifiers.executable && !s.verifiers.grounding && !s.verifiers.independentReview).length,
      },
      calibrationMix: calibrationMix || undefined,
    };

    const vindTally = { vindicated: 0, bounced: 0, pending: 0 };
    for (const t of finalStepCompletes) {
      const o = input.vindicationByCompletion?.(t);
      if (o === "excluded") continue; // version-mismatched completion — counts toward no bucket
      if (o === "vindicated") vindTally.vindicated++;
      else if (o === "bounced") vindTally.bounced++;
      else vindTally.pending++;
    }

    const confidenceReason = deriveConfidenceReason({
      bandLevel,
      verifierMix: scoreBreakdown.verifierMix,
      verifiedSampleSize: verifiedCompletes.length,
      vindication: input.vindicationByCompletion ? vindTally : undefined,
      hasFailureClusters: failureClusters.length > 0,
      verifyingGateName: input.verifyingGateNameByStep?.get(stepTemplateId),
    });

    const step: StepMetrics = {
      stepTemplateId, name: meta.name, ordinal: meta.ordinal,
      description: meta.description, completionPolicy: meta.completionPolicy,
      score: scoreValue == null ? null : Math.round(scoreValue * 100), sampleSize, confidence: sampleSize < SAMPLE_MIN ? "low" : "ok",
      runs: finals.length, passedFirstTry, recovered, failed,
      quality: {
        verdictPassRate, verifiedSampleSize: verifiedCompletes.length, sensorPassRate, oracleSufficientRate,
        scoredSampleSize,
        untestedRegions: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.untestedRegions)),
        residualRisk: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.residualRisk)),
        oracleGaps: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
        limitingDimension: null,
        scoreBreakdown,
      },
      cost: { p50LatencyMs: p50(latencies), meanTokens: mean(tokens), meanUsd: mean(usds), meanRetries },
      risk: { riskClassDist, gateDecisionDist, hardConstraintViolations, approvals },
      failureClusters,
      verification: {
        // null score collapses to 0 here — UI gates on score==null first; widen if a consumer ever needs the distinction.
        tier: stepTier, tierLabel: TIER_LABEL[stepTier], confidence: scoreValue ?? 0, falseAcceptanceRate,
        artifacts: buildArtifacts({
          hasEvidence: evidenceCompletes.length > 0, anySensors: allSensors.length > 0,
          oracleSufficientRate: oracleSufficientRate ?? 0, oracleGaps: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
          hasRefute: finalStepCompletes.some((t) => t.transition.refute != null), falseAccept,
          hasGrounding: groundingCompletes.length > 0,
          groundingFailed: groundingCompletes.some((t) => t.transition.evidence!.grounding!.verdict === "failed"),
        }),
        recentRefuteReasons,
        band: { level: bandLevel, label: BAND_LABEL[bandLevel] },
      },
      failureModes,
      reconciliation,
      trend, versionBoundaries, versionScoreDelta, versionScoreDeltaVersions,
      versionInvalidOutputRateDelta, insights: [], recentReasons, infrastructureFailures,
      versionHistory: input.lineage?.get(stepTemplateId),
      vindication: input.vindicationByCompletion ? vindTally : undefined,
      confidenceReason: confidenceReason ?? undefined,
    };
    step.insights = deriveInsights(step, input.calibration);
    steps.push(step);
  }
  return steps.sort((a, b) => a.ordinal - b.ordinal);
}
