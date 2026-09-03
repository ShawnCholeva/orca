import type {
  Intervention, InterventionSourceKind, ParkState, RunCost, RunDetail,
  RunDurations, RunSummary, RunTraceSpan, SpanCost, VerificationTier,
} from "@orca/contracts";
import { classifyTier } from "./verification.js";
import { sourcesPassed } from "./source-signals.js";
import type { ActivityEvent, RunRow, RunStepRunRow, RunTransition } from "./runs-fetch.js";

// The run-trace projection. Pure functions over already-fetched rows; see
// docs/superpowers/specs/2026-09-02-run-trace-contract.md for the evidence contract.

/** Run statuses where the run is genuinely still going. Everything else is terminal. */
const LIVE_RUN_STATUSES = new Set(["active", "paused", "delegating"]);

const PARK_STATUS = "paused_for_input";

const KNOWN_SOURCE_KINDS = new Set<string>([
  "question_pending", "step_confirmation_pending", "gate_decision_pending",
  "mark_done_pending", "permission_pending", "provider_recovery_pending",
]);

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export type Interval = { start: number; end: number };

/**
 * Union of overlapping intervals. `parkedMs` MUST use this rather than a sum: the
 * unique index guarantees one live activity per STEP RUN, not per run, so two step
 * runs — including two attempts of the same step — can be parked at once. Summing
 * exceeds wall-clock and drives `unaccountedMs` negative, firing the integrity flag
 * on healthy data. Operates on the flat interval set; never group by step first.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

export function totalMs(intervals: Interval[]): number {
  return intervals.reduce((acc, i) => acc + (i.end - i.start), 0);
}

/** Clamps each interval into [lo, hi], dropping any that fall entirely outside. */
export function clampIntervals(intervals: Interval[], lo: number, hi: number): Interval[] {
  return intervals
    .map((i) => ({ start: Math.max(i.start, lo), end: Math.min(i.end, hi) }))
    .filter((i) => i.end > i.start);
}

/**
 * The run's terminal moment: when it stopped mattering. A live run accrues to `now`;
 * a terminal one is frozen. Deliberately NOT extended by a still-open park — a run
 * that died after 17 minutes lasted 17 minutes, however long its abandoned
 * confirmation card has been sitting there. Duration is a property of the run; a
 * card's age is a property of the card.
 */
export function runTerminalMs(run: RunRow, spans: RunStepRunRow[], nowMs: number): number {
  if (LIVE_RUN_STATUSES.has(run.status)) return nowMs;
  const finished = ms(run.finishedAt);
  if (finished !== null) return finished;
  const lastSpanEnd = spans
    .map((s) => ms(s.finishedAt))
    .filter((t): t is number => t !== null)
    .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
  if (Number.isFinite(lastSpanEnd)) return lastSpanEnd;
  return ms(run.startedAt) ?? nowMs;
}

/**
 * Parks for one run, from the append-only `activity.changed` stream. A park opens on
 * the event whose status is `paused_for_input` and closes on the next event for the
 * same activity with a different status; an activity that never closes is STILL
 * PARKED and is reported with a live duration, never dropped.
 */
export function buildInterventions(input: {
  events: ActivityEvent[];
  sourceKinds: Map<string, string>;
  run: RunRow;
  nowMs: number;
}): Intervention[] {
  const { events, sourceKinds, run, nowMs } = input;
  const runLive = LIVE_RUN_STATUSES.has(run.status);
  const forRun = events.filter((e) => e.workflowRunId === run.runId);

  const out: Intervention[] = [];
  for (let i = 0; i < forRun.length; i++) {
    const e = forRun[i];
    if (e.status !== PARK_STATUS) continue;
    // Close on the next event for THIS activity with a different status.
    let exitedAt: string | null = null;
    for (let j = i + 1; j < forRun.length; j++) {
      const n = forRun[j];
      if (n.activityId !== e.activityId) continue;
      if (n.status === PARK_STATUS) continue;
      exitedAt = n.createdAt;
      break;
    }
    const enteredMs = ms(e.createdAt);
    if (enteredMs === null) continue;
    const open = exitedAt === null;
    const endMs = open ? nowMs : ms(exitedAt) ?? nowMs;
    const raw = sourceKinds.get(e.activityId);
    const sourceKind: InterventionSourceKind =
      raw !== undefined && KNOWN_SOURCE_KINDS.has(raw)
        ? (raw as InterventionSourceKind)
        : "unknown";
    // A park's meaning inverts with its run's liveness: on a live run the reader is
    // the bottleneck; on a dead one the card is debris and answering it achieves
    // nothing. Decided here so the UI cannot render the wrong one.
    const parkState: ParkState = !open ? "resolved" : runLive ? "awaiting_you" : "abandoned";
    out.push({
      activityId: e.activityId,
      goalId: run.goalId,
      workflowRunId: run.runId,
      workflowStepRunId: e.stepRunId,
      sourceKind,
      enteredAt: e.createdAt,
      exitedAt,
      // ACTUAL age — unclamped, live while open. Distinct from the clamped
      // contribution this park makes to `parkedMs`.
      durationMs: Math.max(0, endMs - enteredMs),
      open,
      parkState,
    });
  }
  return out;
}

function parkIntervals(interventions: Intervention[], nowMs: number): Interval[] {
  return interventions
    .map((iv) => {
      const start = ms(iv.enteredAt);
      if (start === null) return null;
      const end = iv.exitedAt === null ? nowMs : ms(iv.exitedAt) ?? nowMs;
      return { start, end };
    })
    .filter((i): i is Interval => i !== null);
}

export function computeDurations(input: {
  run: RunRow;
  stepRuns: RunStepRunRow[];
  transitions: RunTransition[];
  interventions: Intervention[];
  nowMs: number;
}): RunDurations {
  const { run, stepRuns, transitions, interventions, nowMs } = input;
  const startMs = ms(run.startedAt) ?? nowMs;
  const endMs = Math.max(startMs, runTerminalMs(run, stepRuns, nowMs));
  const elapsedMs = endMs - startMs;

  const workingMs = transitions
    .filter((t) => t.transition.boundary === "step_complete")
    .reduce((acc, t) => acc + (t.transition.telemetry?.latency_ms ?? 0), 0);

  // Merged union, clamped to the run's own window — a park that outlives the run
  // contributes only the part that overlapped it.
  const parkedMs = totalMs(
    clampIntervals(mergeIntervals(parkIntervals(interventions, nowMs)), startMs, endMs)
  );

  const spanActiveMs = stepRuns.reduce((acc, s) => {
    const a = ms(s.startedAt), b = ms(s.finishedAt);
    return acc + (a !== null && b !== null && b > a ? b - a : 0);
  }, 0);

  const residual = elapsedMs - workingMs - parkedMs;
  // working and parked are disjoint by construction (a parked agent is not
  // computing), so a negative residual means one of the three inputs is wrong.
  // Floor it and SAY SO — a silently clamped number is the failure this screen exists
  // to fix.
  const integrityFlag =
    residual < 0
      ? `durations do not reconcile: elapsed ${elapsedMs}ms < working ${workingMs}ms + parked ${parkedMs}ms`
      : null;

  return {
    elapsedMs,
    workingMs,
    parkedMs,
    unaccountedMs: Math.max(0, residual),
    spanActiveMs,
    accruing: LIVE_RUN_STATUSES.has(run.status),
    integrityFlag,
  };
}

const CENT = 0.005;

export function computeCost(transitions: RunTransition[]): RunCost {
  const completes = transitions.filter((t) => t.transition.boundary === "step_complete");
  const usd = completes.reduce((acc, t) => acc + (t.transition.telemetry?.cost?.usd ?? 0), 0);
  const reported = completes.filter((t) => t.transition.telemetry?.cost != null).length;

  // Superseded: any completion that is not the LAST one for its (step template) in
  // this run — an earlier attempt whose result was replaced. Union with the
  // self-declared failures; a completion can be both, so this is a Set, not a sum.
  const lastByStep = new Map<string, string>();
  for (const t of completes) {
    const key = t.stepTemplateId ?? t.transition.workflowStepRunId ?? t.transition.id;
    const prev = lastByStep.get(key);
    if (prev === undefined || t.transition.createdAt > prev) lastByStep.set(key, t.transition.createdAt);
  }
  // Split rather than blended. A completion that FAILED and was also superseded is
  // counted once, as failed — failure is the stronger claim. The two buckets answer
  // different questions ("what did I spend on attempts that failed" vs "what did I
  // spend that produced nothing the run kept"), reasonable readers pick different
  // ones, and blending them into a single "waste" figure repeats the disease this
  // projection exists to fix.
  let failedUsd = 0;
  let supersededUsd = 0;
  for (const t of completes) {
    const key = t.stepTemplateId ?? t.transition.workflowStepRunId ?? t.transition.id;
    const cost = t.transition.telemetry?.cost?.usd ?? 0;
    if (t.transition.telemetry?.outcome.status === "failed") failedUsd += cost;
    else if (lastByStep.get(key) !== t.transition.createdAt) supersededUsd += cost;
  }

  // `mark_done` carries a cumulative roll-up equal to the sum of every
  // step_complete. It is a CHECKSUM, never an addend — summing all boundaries
  // double-counts the run. Divergence means a completion escaped the roll-up.
  const rollup = transitions.find(
    (t) => t.transition.boundary === "mark_done" && t.transition.telemetry?.cost != null
  )?.transition.telemetry?.cost?.usd;
  const rollupCheck: RunCost["rollupCheck"] =
    rollup === undefined ? "not_applicable" : Math.abs(rollup - usd) < CENT ? "matches" : "diverged";

  return {
    usd,
    wastedUsd: failedUsd + supersededUsd,
    failedUsd,
    supersededUsd,
    coverage: { reported, total: completes.length },
    rollupCheck,
  };
}

/**
 * Cost provenance. Today the daemon collapses provider-authoritative and price-map
 * estimates into one `usd` (`buildTelemetry`), so `measured` vs `estimated` is not
 * recoverable — `reported` is the honest interim and splits once `cost.source`
 * lands. Absent cost is `unknown`, NOT `unreported`: distinguishing "no channel
 * exists" from "the channel sent nothing" requires the adapter's declared
 * hookContract, and inferring it from a missing row would reclassify defects as
 * limits. Absence is never zero.
 */
function spanCost(completes: RunTransition[]): SpanCost | null {
  if (completes.length === 0) return null;
  const withCost = completes.filter((t) => t.transition.telemetry?.cost != null);
  if (withCost.length === 0) return { usd: null, tokensIn: null, tokensOut: null, state: "unknown" };
  const sum = (pick: (c: NonNullable<NonNullable<RunTransition["transition"]["telemetry"]>["cost"]>) => number) =>
    withCost.reduce((acc, t) => acc + pick(t.transition.telemetry!.cost!), 0);
  return {
    usd: sum((c) => c.usd),
    tokensIn: sum((c) => c.tokens_in),
    tokensOut: sum((c) => c.tokens_out),
    state: "reported",
  };
}

export function buildSpans(input: {
  run: RunRow;
  stepRuns: RunStepRunRow[];
  transitions: RunTransition[];
  stepNames: Map<string, string>;
}): RunTraceSpan[] {
  const { run, stepRuns, transitions, stepNames } = input;
  const byStepRun = new Map<string, RunTransition[]>();
  for (const t of transitions) {
    const id = t.transition.workflowStepRunId;
    if (id == null) continue;
    (byStepRun.get(id) ?? byStepRun.set(id, []).get(id)!).push(t);
  }

  return stepRuns.map((s) => {
    const own = byStepRun.get(s.stepRunId) ?? [];
    const completes = own.filter((t) => t.transition.boundary === "step_complete");
    const launches = own.filter((t) => t.transition.boundary === "step_launch").length;
    const final = completes[completes.length - 1];
    const ev = final?.transition.evidence ?? null;
    const rf = final?.transition.refute ?? null;
    const sp = final ? sourcesPassed(ev, rf) : null;

    const startedMs = ms(s.startedAt), finishedMs = ms(s.finishedAt);
    const tier: VerificationTier | null = final
      ? classifyTier({ transition: final.transition, templateVersion: run.templateVersion, stepTemplateId: s.stepTemplateId })
      : null;

    return {
      workflowRunId: run.runId,
      workflowStepRunId: s.stepRunId,
      goalId: s.goalId,
      stepTemplateId: s.stepTemplateId,
      name: stepNames.get(s.stepTemplateId) ?? s.stepTemplateId,
      ordinal: s.ordinal,
      attempt: s.attempt,
      kind: s.stepTemplateId.startsWith("__gate__:") ? "gate" : "step",
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      elapsedMs: startedMs !== null && finishedMs !== null && finishedMs > startedMs ? finishedMs - startedMs : null,
      workingMs: completes.length === 0
        ? null
        : completes.reduce((acc, t) => acc + (t.transition.telemetry?.latency_ms ?? 0), 0),
      status: s.status,
      blockedReason: s.blockedReason,
      // A span launched more than once was restarted; the launch/complete pairing is
      // NOT 1:1, so this counts launches rather than pairing them.
      restarts: Math.max(0, launches - 1),
      completions: completes.length,
      stallRescues: s.stallRescues,
      cost: spanCost(completes),
      tier,
      verifiers: sp === null ? null : {
        executable: sp.executable,
        grounding: sp.grounding,
        independentReview: sp.independentReview,
      },
      refuteVerdict: rf?.verdict ?? null,
      conflicts: (final?.transition.stateDeps?.conflicts ?? []).map((c) => c.kind),
      outcomeStatus: final?.transition.telemetry?.outcome.status ?? null,
      failureCode: final?.transition.telemetry?.outcome.failure_code ?? null,
    };
  });
}

const DELIVERED = new Set(["passed"]);
const BLOCKED = new Set(["failed", "blocked"]);

/** Failure codes that name the substrate failing, not the workflow deciding. */
const INFRA_FAILURE_CODES = new Set([
  "provider_error", "daemon_restart", "session_not_terminal", "timeout",
  "internal_error", "output_unavailable", "source_truncated",
]);
/** Free-text blocked_reason markers the daemon writes for substrate failures. */
const INFRA_REASON_MARKERS = ["worker_exited_no_signal", "worker_stalled", "crashed", "no progress after"];

/**
 * Why the run stopped — and specifically whether the WORKFLOW stopped it or the
 * SUBSTRATE did. Load-bearing for the denominator: 4 of the founder's 5 runs died to
 * the daemon's own spawn-window reap, so pooling them into workflow-quality metrics
 * would report the daemon while naming the workflow.
 *
 * The classification is a documented heuristic, not ground truth — there is no
 * `terminationCause` on the spine — so it emits the literal signal it read as
 * `terminationEvidence`, and a terminal run with no recorded reason is `unknown`
 * rather than being assigned to either side.
 */
export function deriveTermination(
  run: RunRow,
  stepRuns: RunStepRunRow[],
  transitions: RunTransition[]
): { cause: RunSummary["terminationCause"]; evidence: string | null } {
  if (LIVE_RUN_STATUSES.has(run.status)) return { cause: "running", evidence: null };
  if (run.status === "completed") return { cause: "completed", evidence: null };

  const reasons = [run.blockedReason, ...stepRuns.map((s) => s.blockedReason)].filter(
    (r): r is string => r != null && r.length > 0
  );
  const infraReason = reasons.find((r) =>
    INFRA_REASON_MARKERS.some((m) => r.toLowerCase().includes(m))
  );
  if (infraReason !== undefined) return { cause: "infrastructure_killed", evidence: infraReason };

  const codes: string[] = [];
  for (const t of transitions) {
    const code = t.transition.telemetry?.outcome.failure_code;
    if (code != null) codes.push(code);
  }
  const infraCode = codes.find((c) => INFRA_FAILURE_CODES.has(c));
  if (infraCode !== undefined) return { cause: "infrastructure_killed", evidence: infraCode };
  if (codes.length > 0) return { cause: "workflow_failed", evidence: codes[0] };
  if (reasons.length > 0) return { cause: "workflow_failed", evidence: reasons[0] };
  return { cause: "unknown", evidence: null };
}

export function buildRunSummary(input: {
  run: RunRow;
  stepRuns: RunStepRunRow[];
  transitions: RunTransition[];
  interventions: Intervention[];
  spans: RunTraceSpan[];
  nowMs: number;
}): RunSummary {
  const { run, stepRuns, transitions, interventions, spans, nowMs } = input;
  const termination = deriveTermination(run, stepRuns, transitions);
  return {
    runId: run.runId,
    goalId: run.goalId,
    templateId: run.templateId,
    templateName: run.templateName,
    templateVersion: run.templateVersion,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    blockedReason: run.blockedReason,
    terminationCause: termination.cause,
    terminationEvidence: termination.evidence,
    durations: computeDurations({ run, stepRuns, transitions, interventions, nowMs }),
    cost: computeCost(transitions),
    stepsDelivered: stepRuns.filter((s) => DELIVERED.has(s.status)).length,
    stepsBlocked: stepRuns.filter((s) => BLOCKED.has(s.status)).length,
    spanRelaunches: spans.reduce((acc, s) => acc + s.restarts, 0),
    retriedCompletions: spans.reduce((acc, s) => acc + Math.max(0, s.completions - 1), 0),
    openInterventions: interventions.filter((iv) => iv.open).length,
  };
}

export function buildRunDetail(input: {
  run: RunRow;
  stepRuns: RunStepRunRow[];
  transitions: RunTransition[];
  events: ActivityEvent[];
  sourceKinds: Map<string, string>;
  stepNames: Map<string, string>;
  nowMs: number;
}): RunDetail {
  const { run, stepRuns, transitions, events, sourceKinds, stepNames, nowMs } = input;
  const interventions = buildInterventions({ events, sourceKinds, run, nowMs });
  const spans = buildSpans({ run, stepRuns, transitions, stepNames });
  return {
    run: buildRunSummary({ run, stepRuns, transitions, interventions, spans, nowMs }),
    spans,
    interventions,
  };
}
