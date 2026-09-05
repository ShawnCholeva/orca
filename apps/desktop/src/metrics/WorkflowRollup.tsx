import { useEffect, useState } from "react";
import type { MetricPeriod, RunDetail, RunSummary, TemplateMetricsDetail } from "@orca/contracts";
import { getRunDetail, getRunSummaries, getTemplateMetricsDetail } from "../api";
import { formatDuration } from "./interval-bar";
import { PROMPT_KIND, modelName, terminatedRuns, tokens } from "./RunLedger";
import { WorkflowDropdown, type WorkflowChoice } from "./StepPerformance";
import {
  BarList, Big, CountRow, CoverageMatrix, Donut, Panel, Scatter, SectionHeading, StackedRows, gridStyle,
  type BarItem, type CoverageRow, type StackedRow,
} from "./dashboard-panels";

// The Workflows dashboard.
//
// Every figure here is a COUNT or a SUM — exact at n=1, exact at n=7, nothing
// estimated. That is not a limitation of the page, it is why it can be dense. The
// screen was called bare twice, and the answer was never to hedge harder: it was to
// render the nine-tenths of what we hold that had never reached a surface.
//
// What is deliberately absent, and why, because each will be asked for:
//   · no rate, mean or percentile   — claims about runs nobody has seen
//   · no trend line or arrow        — a line through 7 points asserts a trajectory
//   · no gauge with a threshold arc — an arc encodes a target and nobody has set one.
//                                     Not permanent: the day a budget or a tolerable
//                                     wait is chosen, the arc encodes THAT number and
//                                     becomes legitimate.
//
// Pauses ARE split by kind, with a caveat that was once a prohibition: the kind is
// read from the append-only event payload since 18ea6ef, and parks recorded before
// that carry a mutable row's value or none. Those land in a named "reason not kept"
// bucket rather than being guessed, so the split is honest about its own gaps.

const dur = (ms: number) => formatDuration(ms) ?? "not recorded";
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * A duration and its share of the whole it belongs to.
 *
 * The duration stays because it is the fact; the share is a ratio of a closed set, so
 * it is one too. Printing only the percentage would leave the reader unable to tell
 * 72% of an hour from 72% of a week.
 */
const share = (ms: number, total: number) =>
  total > 0 ? `${dur(ms)} · ${Math.round((ms / total) * 100)}%` : dur(ms);
const usd = (v: number) => `$${v.toFixed(2)}`;

const TONE = {
  working: "var(--run)",
  waiting: "var(--accent-2)",
  unseen: "var(--text-4)",
  // Orca stopping a run is not the workflow failing — the Runs list renders that
  // cause neutral for exactly that reason, and red here would contradict it. `stopped`
  // remains for a step that failed while Orca was working, which is the only failure
  // this screen can attribute to the workflow.
  byOrca: "var(--text-3)",
  // Absence is drawn as MATERIAL, not as another hue: hue already means whose time it
  // was, and a fourth colour would have to borrow a meaning that is taken. Red was the
  // first attempt and made Verify — a step that passed — render as a solid red bar,
  // which reads as failure. Hatching says "we did not measure this" without claiming
  // anything went wrong.
  unrecorded: "repeating-linear-gradient(45deg, var(--text-3) 0 2px, var(--panel) 2px 5px)",
  stopped: "var(--err)",
  live: "var(--accent)",
} as const;

export interface Loaded {
  runs: RunSummary[];
  details: RunDetail[];
  // Gate and splitter figures come from the TEMPLATE endpoint, not the run endpoints,
  // so this page now reads two sources. Nullable because losing the gate panels must
  // not lose the dashboard — every other panel is derived from runs.
  //
  // The seam that will break: `/templates/:id` is keyed to ONE template while this page
  // is cross-run by design. Every run in the window shares a template today, so the
  // question "which template" has one answer. The moment a second template has runs, a
  // template-keyed panel sitting on a cross-run page is answering a different question
  // from everything around it, and nothing here will say so.
  gates?: TemplateMetricsDetail | null;
  /**
   * The template endpoint scopes gate verdicts to "latest" or "all" versions and
   * nothing in between. When an older version is chosen the fetch widens to every
   * version, and the panel has to say so — a per-version page captioned with
   * all-version gate figures is the two-populations defect in a new place.
   */
  gatesCoverEveryVersion?: boolean;
  /** The period the gate-node lines were fetched for, so the caption can name it. */
  gatesPeriod?: MetricPeriod;
  /** The chosen window and step — what the time panels are drawn with. */
  window?: { fromMs: number; toMs: number };
  intervalMs?: number;
}
interface StepAgg {
  usd: number; elapsedMs: number; restarts: number; spans: number; runIds: Set<string>;
  // The wall-clock split, carried per step. `unmeasuredMs` is the fourth term and the
  // reason this is not three numbers: a span whose step never completed reports
  // `workingMs: null`, and folding that into "unaccounted" would say Orca sat idle
  // when the truth is nobody wrote the number down. Verify and Critique are unmeasured
  // in 2 of 2 attempts, so that is not a hypothetical — it is two rows that would have
  // read 100% idle. Parked survives in those spans (it is built from intervals, not
  // from completions), so only the remainder is unknown.
  workingMs: number; parkedMs: number; unaccountedMs: number; unmeasuredMs: number;
  unmeasuredSpans: number;

  // Which checks fired, counted over spans that COMPLETED — a span with no completion
  // carries no verifier record at all, so including it in the denominator would report
  // a check as missing when it was never given the chance to run.
  //
  // `executable` and `grounding` turn out all-or-nothing per template on live data
  // (Execution 2/2, Triage 7/7, Clarify 0/2) — those are wiring. `independentReview`
  // fires on some completions and not others of the SAME template (Triage 6/7), so it
  // is conduct, not configuration. The fractions are rendered rather than collapsed
  // precisely so the reader can tell the two apart without being told which is which.
  completed: number; execChecks: number; groundChecks: number; reviewChecks: number;
  // Gates ran and passed while emitting no transitions at all, so they hold zero
  // completions for a reason unrelated to coverage: an instrumentation gap, not a
  // missing sensor. They must not share a row treatment with a step that completed and
  // fired nothing, or the panel tells the reader to wire a sensor onto a working gate.
  gateSpans: number; gatesUnrecorded: number; lastGateAt: string | null;
}

export function aggregate({
  runs, details, gates = null, gatesCoverEveryVersion = false, gatesPeriod = "30d",
  window = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, intervalMs = HOUR,
}: Loaded) {
  // Sums are computed over runs that ENDED. A live run's elapsed and parked clocks are
  // still accruing, so including it makes a total that changes on reload with no work
  // having happened — and one open run currently carries 62 of the window's 113 hours,
  // which is enough to set the headline on its own. `Runs by state` keeps every run,
  // because a run's STATE is a fact whether or not it has finished.
  //
  // Shared with the ledger rather than re-expressed: two predicates for "ended" would
  // drift, and the drift would be invisible because both would keep returning runs.
  const ended = terminatedRuns(runs);
  const endedIds = new Set(ended.map((r) => r.runId));
  const sum = (f: (r: RunSummary) => number) => ended.reduce((a, r) => a + f(r), 0);
  const spans = details.filter((d) => endedIds.has(d.run.runId)).flatMap((d) => d.spans);

  // Spend by the model that produced it, summed over COMPLETIONS rather than spans.
  // A span's cost is one figure across every attempt, and Triage, Research and
  // Execution each ran haiku and then opus in the revise loop on the live data —
  // by span that figure could only be named as mixed; by completion each dollar
  // goes to the model that spent it. A completion with no recorded model is named
  // as that, never folded into a model or dropped as if free.
  const byModel = new Map<string, { usd: number; attempts: number; failed: number; replaced: number }>();
  for (const c of spans.flatMap((s) => s.completionLog)) {
    if (c.usd === null) continue;
    const key = c.model ?? "model not recorded";
    const m = byModel.get(key) ?? { usd: 0, attempts: 0, failed: 0, replaced: 0 };
    m.usd += c.usd;
    m.attempts += 1;
    if (c.outcome === "failed") m.failed += 1;
    else if (c.superseded) m.replaced += 1;
    byModel.set(key, m);
  }
  // The pauses by kind, over ended runs. Counts and sums of park LENGTHS — never a
  // share of wall clock, because parks overlap and the run's own split owns that.
  //
  // Only pauses that ENDED are summed. A park still open on a dead run is
  // abandoned, and its `durationMs` is the card's age — unclamped and growing —
  // not time anyone spent waiting. Summing those produced "312h in all" against
  // 49h of wall clock on the live data: the 424h-against-100h defect the parked
  // total was built to avoid, back one panel over. They are counted, not summed.
  const parksByKind = new Map<string, { count: number; totalMs: number; longestMs: number; abandoned: number }>();
  for (const iv of details.filter((x) => endedIds.has(x.run.runId)).flatMap((x) => x.interventions)) {
    const e = parksByKind.get(iv.sourceKind) ?? { count: 0, totalMs: 0, longestMs: 0, abandoned: 0 };
    e.count += 1;
    if (iv.exitedAt === null) {
      e.abandoned += 1;
    } else {
      e.totalMs += iv.durationMs;
      e.longestMs = Math.max(e.longestMs, iv.durationMs);
    }
    parksByKind.set(iv.sourceKind, e);
  }
  // Token traffic, with cache as its own term. The price map does not price cache,
  // so cache reads — the largest term by two orders of magnitude on a cache-heavy
  // run — are the part of the cost story a dollar figure cannot carry.
  const tokenSums = { fresh: 0, output: 0, cacheRead: 0, cacheWrite: 0, attempts: 0, spansWithoutCache: 0 };
  for (const s of spans) {
    if (s.cost === null || s.cost.usd === null) continue;
    tokenSums.attempts += 1;
    tokenSums.fresh += s.cost.tokensIn ?? 0;
    tokenSums.output += s.cost.tokensOut ?? 0;
    if (s.cost.cacheReadTokens === null) tokenSums.spansWithoutCache += 1;
    tokenSums.cacheRead += s.cost.cacheReadTokens ?? 0;
    tokenSums.cacheWrite += s.cost.cacheCreationTokens ?? 0;
  }

  // Harness revisions are the comparison this page exists for. One row per template
  // version, newest first; state counts over every run of that version, sums over
  // the ones that ended — the same rule as the headline, applied per row.
  const byVersion = [...new Set(runs.map((r) => r.templateVersion))]
    .sort((a, b) => b - a)
    .map((version) => {
      const all = runs.filter((r) => r.templateVersion === version);
      const done = all.filter((r) => endedIds.has(r.runId));
      const vsum = (f: (r: RunSummary) => number) => done.reduce((a, r) => a + f(r), 0);
      return {
        version,
        runs: all.length,
        ended: done.length,
        completed: all.filter((r) => r.terminationCause === "completed").length,
        killed: all.filter((r) => r.terminationCause === "infrastructure_killed").length,
        workflowFailed: all.filter((r) => r.terminationCause === "workflow_failed").length,
        stoppedUnknown: all.filter((r) => r.terminationCause === "unknown").length,
        running: all.filter((r) => r.terminationCause === "running").length,
        delivered: vsum((r) => r.stepsDelivered),
        blocked: vsum((r) => r.stepsBlocked),
        relaunches: vsum((r) => r.spanRelaunches),
        usd: vsum((r) => r.cost.usd),
        elapsedMs: vsum((r) => r.durations.elapsedMs),
        parkedMs: vsum((r) => r.durations.parkedMs),
        workingMs: vsum((r) => r.durations.workingMs),
      };
    });

  // What the completion gate decided, from the same rows as the matrix. The mapping
  // is the daemon's own (metrics/gate-metrics.ts, buildCompletionGateMetrics),
  // copied rather than imported because the desktop cannot depend on the daemon:
  // a reviewer veto is refute_veto; an evidence veto is escalated when the outcome
  // says so and evidence_veto otherwise; anything else the gate judged is upheld.
  // Gate spans and completions the gate never saw are not verdicts.
  //
  // This replaced the template endpoint's figure, which was scoped by period and
  // by "latest or all versions" and so never matched the runs on this page — the
  // two panels agreed on 17 once, from different sets. Derived here, per version
  // and per workflow, the verdicts and the matrix are one population by
  // construction.
  const verdicts = { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 };
  for (const s of spans) {
    if (s.kind === "gate") continue;
    for (const c of s.completionLog) {
      if (!c.gated) continue;
      if (c.failureCode === "refute_veto") verdicts.refute_veto += 1;
      else if (c.failureCode === "evidence_veto") {
        if (c.outcome === "escalated") verdicts.escalated += 1; else verdicts.evidence_veto += 1;
      } else verdicts.upheld += 1;
    }
  }

  // When the harness failed, inside the window. Events are ROWS, not sums, so a
  // live run's events count — a relaunch at 04:10 is a fact whether or not the run
  // has ended — and only the window decides what is drawn.
  const harnessErrors = details
    .flatMap((d) => d.harnessErrors.map((e) => ({ ...e, goalTitle: d.run.goalTitle })))
    .filter((e) => { const t = Date.parse(e.at); return t >= window.fromMs && t <= window.toMs; })
    .sort((a, b) => a.at.localeCompare(b.at));

  // What the policy stopped, by the reason it gave. A decision can carry several
  // reasons and each is counted; allows are not stops and are not here.
  const stopsByReason = new Map<string, { denied: number; approvals: number }>();
  // The decision counts come from the SAME rows as the reasons beneath them. The
  // first draft took the counts from the template endpoint's 30-day period and the
  // reasons from the run list, and the panel read "sent to you to approve: 0" above
  // "7 sent to you" — the two-populations defect, inside one panel, one commit after
  // it was fixed next door.
  const stops = { denied: 0, approvals: 0, allowed: 0 };
  for (const d of details.filter((x) => endedIds.has(x.run.runId)).flatMap((x) => x.toolDecisions)) {
    if (d.decision === "allow") { stops.allowed += 1; continue; }
    if (d.decision === "deny") stops.denied += 1; else stops.approvals += 1;
    for (const reason of d.reasons) {
      const e = stopsByReason.get(reason) ?? { denied: 0, approvals: 0 };
      if (d.decision === "deny") e.denied += 1; else e.approvals += 1;
      stopsByReason.set(reason, e);
    }
  }

  const byStep = new Map<string, StepAgg>();
  for (const s of spans) {
    const e = byStep.get(s.name) ?? {
      usd: 0, elapsedMs: 0, restarts: 0, spans: 0, runIds: new Set<string>(),
      workingMs: 0, parkedMs: 0, unaccountedMs: 0, unmeasuredMs: 0, unmeasuredSpans: 0,
      completed: 0, execChecks: 0, groundChecks: 0, reviewChecks: 0,
      gateSpans: 0, gatesUnrecorded: 0, lastGateAt: null,
    };
    e.spans += 1;
    e.runIds.add(s.workflowRunId);
    e.usd += s.cost?.usd ?? 0;
    e.elapsedMs += s.elapsedMs ?? 0;
    e.restarts += s.restarts;

    const elapsed = s.elapsedMs ?? 0;
    const parked = Math.min(s.parkedMs ?? 0, elapsed);
    e.parkedMs += parked;
    if (s.workingMs === null) {
      e.unmeasuredSpans += 1;
      e.unmeasuredMs += Math.max(0, elapsed - parked);
    } else {
      const working = Math.min(s.workingMs, Math.max(0, elapsed - parked));
      e.workingMs += working;
      // Clamped, because two live spans already report working + parked ABOVE their
      // own elapsed. A negative remainder would render as a bar segment growing
      // backwards; the terms are held addable instead, which is the property the
      // whole duration vocabulary rests on.
      e.unaccountedMs += Math.max(0, elapsed - parked - working);
    }
    if (s.kind === "gate") {
      e.gateSpans += 1;
      if (s.completions === 0) {
        e.gatesUnrecorded += 1;
        if (e.lastGateAt === null || (s.startedAt ?? "") > e.lastGateAt) e.lastGateAt = s.startedAt;
      }
    }
    if (s.verifiers !== null) {
      e.completed += 1;
      if (s.verifiers.executable) e.execChecks += 1;
      if (s.verifiers.grounding) e.groundChecks += 1;
      if (s.verifiers.independentReview) e.reviewChecks += 1;
    }
    byStep.set(s.name, e);
  }

  return {
    runs, ended, details, byStep, byModel, parksByKind, tokens: tokenSums, byVersion, verdicts, stops, stopsByReason, gates, gatesCoverEveryVersion, gatesPeriod,
    harnessErrors, window, intervalMs,
    usd: sum((r) => r.cost.usd),
    failedUsd: sum((r) => r.cost.failedUsd),
    supersededUsd: sum((r) => r.cost.supersededUsd),
    elapsedMs: sum((r) => r.durations.elapsedMs),
    workingMs: sum((r) => r.durations.workingMs),
    // Parked time comes from each RUN's own decomposition, never from summing
    // intervention durations. Parks overlap and an open one grows without bound, so
    // that sum reaches 424h against 100h of wall clock — two ways of counting the
    // same thing, only one of which can be added to the terms beside it.
    parkedMs: sum((r) => r.durations.parkedMs),
    unaccountedMs: sum((r) => r.durations.unaccountedMs),
    delivered: sum((r) => r.stepsDelivered),
    blocked: sum((r) => r.stepsBlocked),
    relaunches: sum((r) => r.spanRelaunches),
    completed: runs.filter((r) => r.terminationCause === "completed").length,
    running: runs.filter((r) => r.terminationCause === "running").length,
    // Split rather than one "stopped" bucket. That bucket was defined as "not
    // completed and not running", which admits three causes, and it was labelled with
    // only one of them — true today by luck, since every stopped run happens to be an
    // infrastructure kill. A `workflow_failed` run would be called "stopped by harness"
    // here and "the workflow stopped it" in the Runs tab, and an `unknown` run would be
    // blamed on the harness when the point of that cause is that nobody recorded who
    // stopped it. The partition stays exhaustive: completed + running + these three = n.
    killed: runs.filter((r) => r.terminationCause === "infrastructure_killed").length,
    workflowFailed: runs.filter((r) => r.terminationCause === "workflow_failed").length,
    stoppedUnknown: runs.filter((r) => r.terminationCause === "unknown").length,
  };
}

export type Agg = ReturnType<typeof aggregate>;

/**
 * The run holding most of the window's failed spend, when one does.
 *
 * Only named when a single run carries the majority — otherwise the spend really is
 * spread and pointing at one run would misdescribe it.
 */
function worstRun(agg: Agg) {
  const top = [...agg.ended].sort((a, b) => b.cost.failedUsd - a.cost.failedUsd)[0];
  if (!top || top.cost.failedUsd <= 0 || top.cost.usd <= 0) return null;
  const total = agg.ended.reduce((a, r) => a + r.cost.failedUsd, 0);
  return top.cost.failedUsd / total > 0.5 ? top : null;
}

/**
 * Which checks are wired, per step template.
 *
 * Gates are excluded from the matrix and reported beneath it. A gate holds zero
 * completions because it emitted no transitions, NOT because no sensor is attached —
 * rendering it as `0/0` beside Clarify's `0/2` would tell the reader to wire a sensor
 * onto something already working.
 */
function coverage(agg: Agg) {
  const steps = [...agg.byStep.entries()].filter(([, v]) => v.gateSpans === 0 && v.completed > 0);
  const gates = [...agg.byStep.entries()].filter(([, v]) => v.gatesUnrecorded > 0);
  const rows: CoverageRow[] = steps
    .sort((a, b) => b[1].completed - a[1].completed)
    .map(([name, v]) => ({
      key: name,
      label: name,
      cells: [
        { fired: v.execChecks, of: v.completed },
        { fired: v.groundChecks, of: v.completed },
        { fired: v.reviewChecks, of: v.completed },
      ],
    }));
  // Both denominators, because they are the same fact at two granularities and only
  // the pair carries the finding: "2 of 23" reads as patchy sampling, "1 of 8" reads
  // as structure, and seeing them together is how the patchiness turns out to BE the
  // structure. Templates, not spans, is the number he can act on — a template can be
  // rewired and a span cannot.
  const templates = steps.length;
  const wiredTemplates = steps.filter(([, v]) => v.execChecks > 0).length;
  const attempts = steps.reduce((a, [, v]) => a + v.completed, 0);
  const execAttempts = steps.reduce((a, [, v]) => a + v.execChecks, 0);
  return { rows, gates, templates, wiredTemplates, attempts, execAttempts };
}

/**
 * The wall clock inside each step, ordered by how much of it there was.
 *
 * Ordered by elapsed rather than alphabetically because the row worth reading first is
 * the one holding the most time — on this data that is Clarify, at 98% unaccounted
 * across 24 hours, which is a fact about the product that no ranking of totals shows.
 */
function stepClock(agg: Agg): StackedRow[] {
  return [...agg.byStep.entries()]
    .filter(([, v]) => v.elapsedMs > 0)
    .sort((a, b) => b[1].elapsedMs - a[1].elapsedMs)
    .map(([name, v]) => ({
      key: name,
      label: name,
      // The step's own total, and the count of attempts that never reported working
      // time — said on the row rather than in a footnote, because it is the caveat
      // that changes how the bar beside it should be read.
      display: v.unmeasuredSpans > 0
        ? `${dur(v.elapsedMs)} · ${v.unmeasuredSpans} of ${v.spans} not recorded`
        : dur(v.elapsedMs),
      parts: [
        { label: "active work", value: v.workingMs, display: dur(v.workingMs), tone: TONE.working },
        { label: "waiting on you", value: v.parkedMs, display: dur(v.parkedMs), tone: TONE.waiting },
        { label: "unaccounted", value: v.unaccountedMs, display: dur(v.unaccountedMs), tone: TONE.unseen },
        { label: "not recorded", value: v.unmeasuredMs, display: dur(v.unmeasuredMs), tone: TONE.unrecorded },
      ],
    }));
}

/**
 * Per-step totals, each carrying the number of runs it was summed over.
 *
 * Without that denominator a two-run total is drawn against a seven-run total on one
 * axis, and the longest bar reads as the slowest step when it may just be the one
 * that ran in the runs that lasted longest. The totals row already carries the
 * "dominated by the longest run" caveat for the same reason; the bars need it per bar
 * because each has a different denominator.
 */
function stepBars(
  agg: Agg,
  pick: (v: StepAgg) => number,
  fmt: (n: number) => string,
  tone?: string,
): BarItem[] {
  return [...agg.byStep.entries()]
    .map(([label, v]) => ({
      key: label, label, value: pick(v),
      // `spans` counts ATTEMPTS, not runs: Triage retried, so nine span rows sit
      // across seven runs. Labelling that "9 runs" against a seven-run total is the
      // population defect this denominator was added to fix, reappearing inside the
      // fix — and it looked right on every other step only because those never
      // retried. Both numbers are stated when they differ, since the gap between them
      // is the retry count and that is the interesting part.
      display: v.spans === v.runIds.size
        ? `${fmt(pick(v))} · ${v.spans} ${v.spans === 1 ? "run" : "runs"}`
        : `${fmt(pick(v))} · ${v.spans} attempts across ${v.runIds.size} runs`,
      tone,
    }))
    .filter((b) => b.value > 0)
    .sort((a, b) => b.value - a.value);
}

type VersionRow = Agg["byVersion"][number];

/**
 * Counts and sums per template version, newest first. A plain grid rather than a
 * chart: the reader is comparing rows, and the numbers are the comparison.
 */
function VersionTable({ rows }: { rows: VersionRow[] }) {
  const head = ["version", "runs", "completed", "stopped by the harness", "still running", "delivered", "blocked", "relaunches", "spent", "wall clock", "waiting on you"];
  const cell = (v: string, i: number, bold = false) => (
    <span key={i} className="mono" style={{ fontSize: "var(--fs-2)", color: bold ? "var(--text)" : "var(--text-2)", fontWeight: bold ? 600 : 400, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>
      {v}
    </span>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: `auto repeat(${head.length - 1}, minmax(0, auto))`, columnGap: "var(--sp-4)", rowGap: "var(--sp-2)", alignItems: "baseline" }}>
        {head.map((h, i) => (
          <span key={h} className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.6, textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>
            {h}
          </span>
        ))}
        {rows.map((r) => [
          cell(`v${r.version}`, 0, true),
          cell(String(r.runs), 1),
          cell(String(r.completed), 2),
          cell(String(r.killed), 3),
          cell(String(r.running), 4),
          cell(String(r.delivered), 5),
          cell(String(r.blocked), 6),
          cell(String(r.relaunches), 7),
          cell(usd(r.usd), 8),
          cell(dur(r.elapsedMs), 9),
          // The share is a ratio of a closed set — this version's own ended runs.
          cell(r.elapsedMs > 0 ? `${Math.round((r.parkedMs / r.elapsedMs) * 100)}%` : "—", 10),
        ])}
      </div>
      {rows.some((r) => r.running > 0) && (
        <p style={{ margin: "var(--sp-2) 0 0", fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
          Sums are over the runs of that version that ended; a run still running is counted but not summed.
        </p>
      )}
    </div>
  );
}

export function Dashboard({ agg }: { agg: Agg }) {
  const n = agg.runs.length;
  const live = n - agg.ended.length;
  const parkedShare = agg.elapsedMs > 0 ? Math.round((agg.parkedMs / agg.elapsedMs) * 100) : 0;
  const rework = agg.failedUsd + agg.supersededUsd;

  return (
    <div style={{ display: "grid", gap: "var(--sp-5)", alignContent: "start" }}>
      {/* Exactly one type size above the grid. If any panel reaches it the headline
          stops being a headline — and the contrast between wall clock and working is
          the thing that lands before a single label is read. */}
      <div style={{ display: "flex", gap: "var(--sp-6)", flexWrap: "wrap", padding: "0 var(--sp-1)" }}>
        {/* The label names the population AND what it leaves out. Excluding live runs
            silently would be the worse half of the change: the figure would be stable
            and the reader would have no way to know a 62-hour run was missing from it. */}
        <Big
          value={usd(agg.usd)}
          label={live > 0
            ? `spent across ${agg.ended.length} runs that ended · ${live} still running, not counted`
            : `spent across ${agg.ended.length} runs`}
        />
        <Big value={dur(agg.elapsedMs)} label="wall clock" />
        <Big value={dur(agg.workingMs)} label="active work" tone={TONE.working} />
        <Big value={`${parkedShare}%`} label="waiting on you" tone={TONE.waiting} />
      </div>

      <div style={gridStyle}>
        <SectionHeading>What happened</SectionHeading>

        <Panel title="Runs by state" span={6}>
          {/* Not "how they ended". A run still in flight has not ended, and placing it
              in a termination partition asserts a terminal outcome about something
              unfinished — so the partition is over STATE, which every run has. */}
          <Donut
            caption={n === 1 ? "run" : "runs"}
            parts={[
              { label: "completed", value: agg.completed, display: String(agg.completed), tone: TONE.working },
              { label: "stopped by the harness", value: agg.killed, display: String(agg.killed), tone: TONE.byOrca },
              { label: "the workflow stopped it", value: agg.workflowFailed, display: String(agg.workflowFailed), tone: TONE.stopped },
              { label: "stopped, reason not recorded", value: agg.stoppedUnknown, display: String(agg.stoppedUnknown), tone: TONE.unseen },
              { label: "still running", value: agg.running, display: String(agg.running), tone: TONE.live },
            ]}
          />
        </Panel>

        <Panel title="Steps across all runs" span={6}>
          {/* Delivered and blocked partition the steps that REACHED an outcome, so
              they can close a ring. Relaunches cannot join them: `spanRelaunches`
              counts crash-relaunch EVENTS, not steps, and a step that crashed twice
              and then delivered contributes 1 here and 2 there. As a third slice it
              would double-count that step and make the centre total a number that
              describes nothing — so it sits below the ring, in its own unit. */}
          <Donut
            caption="steps"
            parts={[
              { label: "delivered", value: agg.delivered, display: String(agg.delivered), tone: TONE.working },
              { label: "blocked", value: agg.blocked, display: String(agg.blocked), tone: TONE.waiting },
            ]}
          />
          <div style={{ marginTop: "var(--sp-3)", paddingTop: "var(--sp-2)", borderTop: "1px solid var(--hairline)" }}>
            <CountRow items={[{ label: "relaunches after a crash — events, not steps", value: String(agg.relaunches) }]} />
          </div>
        </Panel>

        <Panel title="Harness errors" span={12}>
          {/* WHEN the harness failed, on the chosen window at the chosen step. Three
              kinds, one row each: a worker crashing and being relaunched, a completion
              failing with a code that names the substrate, and the run being killed.
              A workflow veto is not here — that is the workflow deciding. */}
          <Scatter
            fromMs={agg.window.fromMs}
            toMs={agg.window.toMs}
            intervalMs={agg.intervalMs}
            rows={[
              { key: "crash_relaunch", label: "worker crashed, relaunched" },
              { key: "infra_failure", label: "failed inside the harness" },
              { key: "run_killed", label: "run stopped by the harness" },
            ]}
            points={agg.harnessErrors.map((e) => ({
              rowKey: e.kind,
              atMs: Date.parse(e.at),
              title: `${new Date(e.at).toLocaleString()} · ${e.goalTitle}${e.stepName ? ` · ${e.stepName}` : ""}${e.detail ? ` · ${e.detail}` : ""}`,
            }))}
          />
          {agg.harnessErrors.length > 0 && (
            <CountRow items={[
              { label: "relaunches after a crash", value: String(agg.harnessErrors.filter((e) => e.kind === "crash_relaunch").length) },
              { label: "failures inside the harness", value: String(agg.harnessErrors.filter((e) => e.kind === "infra_failure").length) },
              { label: "runs stopped by the harness", value: String(agg.harnessErrors.filter((e) => e.kind === "run_killed").length) },
            ]} />
          )}
        </Panel>

        {/* One row per harness revision. Pooling v13 with v16 hides the one
            comparison the page exists to support — whether the revision changed
            anything — and it is only shown when there is more than one version to
            compare, because a one-row table restates the headline. Every cell is a
            count over that version's runs or a sum over the ones that ended. */}
        {agg.byVersion.length > 1 && (
          <Panel title="By template version" span={12}>
            <VersionTable rows={agg.byVersion} />
          </Panel>
        )}

        <SectionHeading>How well we know it worked</SectionHeading>

        {(() => {
          const c = coverage(agg);
          return (
            <>
              <Panel title="What the gates decided" span={4}>
                {/* From the runs on this page — the same rows as the matrix beside it,
                    per workflow and per version, so the two panels are one population
                    by construction and no caption has to apologise for a window. */}
                <Donut
                  caption="completions"
                  parts={[
                    { label: "upheld", value: agg.verdicts.upheld, display: String(agg.verdicts.upheld), tone: TONE.working },
                    { label: "sent back — no evidence", value: agg.verdicts.evidence_veto, display: String(agg.verdicts.evidence_veto), tone: TONE.stopped },
                    { label: "sent back — reviewer", value: agg.verdicts.refute_veto, display: String(agg.verdicts.refute_veto), tone: "var(--warn)" },
                    { label: "escalated", value: agg.verdicts.escalated, display: String(agg.verdicts.escalated), tone: TONE.live },
                  ]}
                />
                <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                  Every judged completion of these runs, one verdict each. A step that was sent back and
                  then passed appears twice — once per completion — where the matrix counts it once.
                </p>
                {agg.gates !== null && (agg.gates.gates.length > 0 || agg.gates.splitters.length > 0) && (
                  <div style={{ paddingTop: "var(--sp-2)", borderTop: "1px solid var(--hairline)", display: "grid", gap: "var(--sp-1)" }}>
                    {/* The gate NODES and the splitter still come from the template's
                        own records, which are scoped by period and by latest-or-all
                        versions — so these two lines say what they cover. A gate node's
                        performance is the one thing this window cannot show (they recorded
                        nothing), and a deterministic splitter has no choice to score. */}
                    {agg.gates.gates.length > 0 && (
                      <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                        {agg.gates.gates.map((g) => g.name).join(" and ")} decided{" "}
                        {agg.gates.gates.reduce((a, g) => a + g.sampleSize, 0)} times between them and recorded none of it.
                      </p>
                    )}
                    {agg.gates.splitters.map((sp) => (
                      <p key={sp.nodeId} style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                        {sp.name} routes {sp.deterministic ? "from an upstream field, so there is no choice to score" : "by model, unscored"} ·{" "}
                        {sp.decisions} {sp.decisions === 1 ? "decision" : "decisions"}
                      </p>
                    ))}
                    <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                      Those two lines are from the workflow&apos;s own records over the {PERIOD_WORDS[agg.gatesPeriod]}
                      {agg.gatesCoverEveryVersion ? " and across every version" : ""}, not from the runs above.
                    </p>
                  </div>
                )}
              </Panel>

              <Panel title="Which checks are wired, by step type" span={5}>
                {/* The two headline figures moved here when the summary panel was
                    replaced. They belong with the rows anyway — they are the matrix's
                    own totals, and read as a caption on someone else's panel. */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-5)", alignItems: "baseline" }}>
                  <Big value={`${c.wiredTemplates} of ${c.templates}`} size="var(--fs-4)" label="step types run a check on the work" />
                  <Big value={`${c.execAttempts} of ${c.attempts}`} size="var(--fs-4)" label="completed steps checked by running something" />
                </div>
                {/* Named from the reader's side. "Executed / grounded / model-reviewed"
                    were the contract's own field names, which describe how the daemon
                    CLASSIFIES a check rather than what the founder learns from it. The
                    order is strongest to weakest and the caption says so, so the ranking
                    lives in position and words rather than in a colour that would have
                    to assert a threshold nobody has defined. */}
                <CoverageMatrix
                  columns={[
                    { label: "ran a check", hint: "Tests or a typecheck actually ran against the work and covered enough of the step to count. A stub that exits without doing anything is recorded as skipped and does not count here. This is the only column that can tell you the work is CORRECT." },
                    { label: "did what it said", hint: "The engine checked the step's own claims against the workspace — files it said it created exist, paths it said it changed appear in the diff. It proves the step did what it claimed. It cannot tell whether the work is any good." },
                    { label: "a model agreed", hint: "Another model read the result and judged it correct. An opinion about quality, with no mechanism behind it — the only column here that is not a measurement." },
                  ]}
                  rows={c.rows}
                />
                <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                  {/* The order is the daemon's own calibration (executable 1.0, grounding
                      0.7, independent review 0.55), not a preference. Grounding outranks
                      review because the two differ on TWO axes: a deterministic check is
                      narrow but certain, a model's judgement is broad but unreliable, and
                      a narrow certainty beats a broad guess. An earlier draft said
                      grounding proved "only" that the claims were true, which read as the
                      weakest of the three and inverted the ranking in the reader's head. */}
                  Strongest proof on the left. <em>Ran a check</em> tests whether the work is right.{" "}
                  <em>Did what it said</em> is narrow but certain — it proves the step really did what it
                  claimed. <em>A model agreed</em> is broader but is an opinion, so it can be wrong about anything.
                </p>
              </Panel>

              <Panel title="Blocked by the safety floor" span={3}>
                {/* Bars rather than a ring: the zeros are the finding, and a ring
                    drops a zero slice entirely. An empty track says "never happened"
                    where a missing arc says nothing at all.

                    Counted from the runs on this page, not from the template
                    endpoint: the reasons beneath are read from the same rows, so
                    the counts and the reasons are one population by construction. */}
                <BarList
                  tone={TONE.stopped}
                  scaleTo={agg.stops.denied + agg.stops.approvals + agg.stops.allowed}
                  items={[
                    { label: "denied outright", value: agg.stops.denied, display: String(agg.stops.denied) },
                    { label: "sent to you to approve", value: agg.stops.approvals, display: String(agg.stops.approvals) },
                    { label: "allowed", value: agg.stops.allowed, display: String(agg.stops.allowed) },
                  ]}
                />
                {/* `decideGate` returns "deny" ONLY when a hard constraint is
                    violated — a critical risk class on its own returns
                    require_approval. So a denial is not "the policy was strict", it
                    is an agent reaching for a credential file, a protected system
                    path, or a recursive delete, and being stopped. */}
                <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                  Each denial is a hard safety constraint — a credential file, a protected path, a
                  recursive delete. Nothing was denied for being merely risky.
                </p>
                <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                  Counts only tool calls that needed a permission decision, so it measures the policy
                  rather than the agent.
                </p>
                {/* The reasons themselves. The counts above say the floor held; these
                    say what it held against, which is the only record of what the
                    agent reached for. */}
                {agg.stopsByReason.size > 0 && (
                  <div style={{ paddingTop: "var(--sp-2)", borderTop: "1px solid var(--hairline)", display: "grid", gap: "var(--sp-1)" }}>
                    {[...agg.stopsByReason.entries()].map(([reason, c]) => (
                      <div key={reason} style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", fontSize: "var(--fs-1)" }}>
                        <span style={{ color: "var(--text-2)", minWidth: 0, flex: 1 }}>{reason}</span>
                        <span className="mono" style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>
                          {c.denied > 0 && `${c.denied} denied`}
                          {c.denied > 0 && c.approvals > 0 && " · "}
                          {c.approvals > 0 && `${c.approvals} sent to you`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          );
        })()}

        <SectionHeading>Where the time went</SectionHeading>

        <Panel title="Share of the wall clock" span={3}>
          {/* The total moved out of the title: it was already the headline figure two
              inches above, and spelling it into a heading made the heading change
              every time the window did. The share is what this panel is FOR, and it
              stays true whatever the total is.

              Rows keep their semantic order rather than sorting by size, because these
              three are a fixed vocabulary the reader learns once — re-ordering them
              per window would cost more than the ranking buys. They still sum to the
              whole, which is the property worth being able to check by adding. */}
          <BarList
            scaleTo={agg.elapsedMs}
            items={[
              { label: "active work", value: agg.workingMs, display: share(agg.workingMs, agg.elapsedMs), tone: TONE.working },
              { label: "waiting on you", value: agg.parkedMs, display: share(agg.parkedMs, agg.elapsedMs), tone: TONE.waiting },
              { label: "unaccounted", value: agg.unaccountedMs, display: share(agg.unaccountedMs, agg.elapsedMs), tone: TONE.unseen },
            ]}
          />
        </Panel>

        <Panel title="Where each step's time went" span={5}>
          {/* Each bar is that STEP's own whole, not a share of the window: the question
              is what happened inside Clarify, and `Time by step` two panels along
              already ranks them against each other.

              Four terms, not three. A step whose attempts never completed reports no
              working time at all, and calling that "unaccounted" would state that Orca
              sat idle — Verify and Critique are unmeasured in every attempt, so those
              two rows would have read 100% idle rather than 100% unrecorded. */}
          <StackedRows
            legend={[
              { label: "active work", value: 0, display: "", tone: TONE.working },
              { label: "waiting on you", value: 0, display: "", tone: TONE.waiting },
              { label: "unaccounted", value: 0, display: "", tone: TONE.unseen },
              { label: "not recorded", value: 0, display: "", tone: TONE.unrecorded },
            ]}
            rows={stepClock(agg)}
          />
        </Panel>

        <Panel title="Time by step, this window" span={4}>
          <BarList items={stepBars(agg, (v) => v.elapsedMs, dur, TONE.waiting)} />
        </Panel>

        <Panel title="Where you were needed" span={12}>
          {/* Counts and sums of park lengths, by what the pause was for. Scaled to
              the largest total rather than to wall clock: parks overlap, so their
              lengths do not partition anything and must not be drawn as if they did.
              The "reason not kept" row is the honest remainder — parks recorded
              before the kind rode the event carry nothing recoverable. */}
          <BarList
            tone={TONE.waiting}
            items={[...agg.parksByKind.entries()]
              .sort((a, b) => b[1].totalMs - a[1].totalMs)
              .map(([kind, p]) => ({
                key: kind,
                label: kind === "unknown" ? "reason not kept" : PROMPT_KIND[kind as keyof typeof PROMPT_KIND] ?? kind,
                value: p.totalMs,
                display: `${p.count} ${p.count === 1 ? "pause" : "pauses"}`
                  + (p.count - p.abandoned > 0 ? ` · ${dur(p.totalMs)} in all · longest ${dur(p.longestMs)}` : "")
                  + (p.abandoned > 0 ? ` · ${p.abandoned} left unanswered when the run stopped` : ""),
              }))}
          />
          {agg.parksByKind.has("unknown") && (
            <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
              Pauses recorded before the reason was kept on the event have no recoverable kind and are
              counted on their own row rather than guessed.
            </p>
          )}
        </Panel>

        <SectionHeading>Where the money went</SectionHeading>

        <Panel title="Spend by outcome" span={5}>
          {/* A true partition: failed + replaced + kept is every dollar in the window,
              which is what lets it close a ring at all. The labels drop the "on ..."
              phrasing the bar needed — a legend row reads as a category, not as a
              sentence continuing from the title. */}
          <Donut
            caption="spent"
            total={usd(agg.usd)}
            parts={[
              { label: "attempts that failed", value: agg.failedUsd, display: usd(agg.failedUsd), tone: TONE.stopped },
              { label: "work replaced", value: agg.supersededUsd, display: usd(agg.supersededUsd), tone: "var(--warn)" },
              { label: "work kept", value: Math.max(0, agg.usd - rework), display: usd(Math.max(0, agg.usd - rework)), tone: TONE.working },
            ]}
          />
          {/* The window figure averages one expensive run with six cheap ones, and the
              average is the less useful of the two: "68% of spend failed" reads as a
              reliability problem across the workflow, where the truth is an efficiency
              problem inside a single run that SUCCEEDED. Named rather than aggregated,
              because he can open a run and cannot open a percentage. */}
          {worstRun(agg) && (
            <div style={{ marginTop: "var(--sp-3)", paddingTop: "var(--sp-2)", borderTop: "1px solid var(--hairline)" }}>
              <p style={{ margin: 0, fontSize: "var(--fs-2)", color: "var(--text-2)" }}>
                Most of it is one run: <strong>{worstRun(agg)!.goalTitle}</strong> spent{" "}
                {usd(worstRun(agg)!.cost.failedUsd)} of {usd(worstRun(agg)!.cost.usd)} on attempts that failed —{" "}
                {Math.round((worstRun(agg)!.cost.failedUsd / worstRun(agg)!.cost.usd) * 100)}% of that run, and it{" "}
                {worstRun(agg)!.terminationCause === "completed" ? "still completed" : "did not complete"}.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Spend by step, this window" span={7}>
          <BarList items={stepBars(agg, (v) => v.usd, usd)} />
        </Panel>

        <Panel title="Spend by model" span={6}>
          {/* The harness's own choice, and the one axis on this page that describes
              the harness rather than the workflow. A step that ran under two models
              in its revise loop is one bar named as mixed: its cost is one figure
              across both attempts and assigning it to either would be a guess that
              looks like a measurement. */}
          <BarList
            items={[...agg.byModel.entries()]
              .sort((a, b) => b[1].usd - a[1].usd)
              .map(([key, m]) => ({
                key,
                label: key === "model not recorded" ? key : modelName(key),
                value: m.usd,
                display: `${usd(m.usd)} · ${m.attempts} ${m.attempts === 1 ? "attempt" : "attempts"}`
                  + (m.failed > 0 ? ` · ${m.failed} failed` : "")
                  + (m.replaced > 0 ? ` · ${m.replaced} replaced` : ""),
              }))}
          />
          <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            Each completion is counted under the model that produced it, so a step that ran again
            under a second model splits exactly. <em>Replaced</em> is a completion that passed and was
            later superseded by another attempt.
          </p>
        </Panel>

        <Panel title="Tokens, this window" span={6}>
          {/* Cache as its own term. Dollars alone cannot say whether a run was
              expensive because it produced a lot or because it re-read a lot, and
              the price map does not price cache at all. Bars are scaled to the
              largest term, which on a cache-heavy run is the point. */}
          <BarList
            items={[
              { label: "fresh input", value: agg.tokens.fresh, display: tokens(agg.tokens.fresh) },
              { label: "output", value: agg.tokens.output, display: tokens(agg.tokens.output) },
              { label: "read from cache", value: agg.tokens.cacheRead, display: tokens(agg.tokens.cacheRead), tone: TONE.waiting },
              { label: "written to cache", value: agg.tokens.cacheWrite, display: tokens(agg.tokens.cacheWrite), tone: TONE.waiting },
            ]}
          />
          {agg.tokens.spansWithoutCache > 0 && (
            <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
              {agg.tokens.spansWithoutCache} of {agg.tokens.attempts} attempts
              recorded no cache figure, so the two cache terms are lower than the truth.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * The workflows that have runs, most recently run first, each with its run count.
 * The dashboard describes ONE workflow at a time: the gate panel is keyed to a
 * template, and every other panel pools runs that are only comparable within one.
 * There is deliberately no "all workflows" choice for that reason.
 */
export function workflowsOf(runs: RunSummary[]): WorkflowChoice[] {
  const byTemplate = new Map<string, { name: string; runs: number; latest: string }>();
  for (const r of runs) {
    const e = byTemplate.get(r.templateId) ?? { name: r.templateName, runs: 0, latest: "" };
    e.runs += 1;
    if (r.startedAt > e.latest) { e.latest = r.startedAt; e.name = r.templateName; }
    byTemplate.set(r.templateId, e);
  }
  return [...byTemplate.entries()]
    .sort((a, b) => b[1].latest.localeCompare(a[1].latest))
    .map(([templateId, e]) => ({ templateId, name: e.name, runs: e.runs }));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The windows the reader can choose. A run is inside a window when it was ACTIVE
 * during it: still running, or ended at or after the window opened. The first
 * rule was "started inside it", which hid a run that had been waiting on the
 * reader for the whole of the last 24 hours because it began the day before —
 * and the founder's first look at the page was "no data". A stuck run does then
 * appear in every window, which is not a defect: it is stuck in every window.
 */
export const RANGES = [
  { key: "1h", label: "Last 1 hour", ms: HOUR },
  { key: "8h", label: "Last 8 hours", ms: 8 * HOUR },
  { key: "12h", label: "Last 12 hours", ms: 12 * HOUR },
  { key: "24h", label: "Last 24 hours", ms: DAY },
  { key: "3d", label: "Last 3 days", ms: 3 * DAY },
  { key: "7d", label: "Last 7 days", ms: 7 * DAY },
  { key: "14d", label: "Last 14 days", ms: 14 * DAY },
  { key: "1mo", label: "Last 1 month", ms: 30 * DAY },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];
const DEFAULT_RANGE: RangeKey = "24h";

const MINUTE = 60_000;

/**
 * The steps a window can be divided into. One rule rather than a list per range:
 * every step from a minute to a week that divides the window EVENLY into between
 * 2 and 168 points. It reproduces the founder's two examples exactly — an hour in
 * 1, 5, 10, 15 or 30 minutes; a week in 1, 2, 4, 8 or 12 hours or a day — and
 * gives every other window the same shape without a table to keep in step.
 *
 * Chosen for the time panels to come; nothing on this page reads it yet.
 */
const STEPS = [
  { key: "1m", label: "1 minute", ms: MINUTE },
  { key: "5m", label: "5 minutes", ms: 5 * MINUTE },
  { key: "10m", label: "10 minutes", ms: 10 * MINUTE },
  { key: "15m", label: "15 minutes", ms: 15 * MINUTE },
  { key: "30m", label: "30 minutes", ms: 30 * MINUTE },
  { key: "1h", label: "1 hour", ms: HOUR },
  { key: "2h", label: "2 hours", ms: 2 * HOUR },
  { key: "4h", label: "4 hours", ms: 4 * HOUR },
  { key: "8h", label: "8 hours", ms: 8 * HOUR },
  { key: "12h", label: "12 hours", ms: 12 * HOUR },
  { key: "1d", label: "1 day", ms: DAY },
  { key: "2d", label: "2 days", ms: 2 * DAY },
  { key: "7d", label: "7 days", ms: 7 * DAY },
] as const;
const MIN_POINTS = 2;
const MAX_POINTS = 168;

export function intervalsFor(rangeKey: string): { key: string; label: string; ms: number; points: number }[] {
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[3];
  return STEPS
    .filter((s) => range.ms % s.ms === 0)
    .map((s) => ({ key: s.key, label: s.label, ms: s.ms, points: range.ms / s.ms }))
    .filter((s) => s.points >= MIN_POINTS && s.points <= MAX_POINTS);
}

/** The step closest to 24 points — a chart that is neither a wall nor a stub. Ties go to the coarser step. */
export function defaultIntervalFor(rangeKey: string): string {
  const options = intervalsFor(rangeKey);
  let best = options[0]!;
  for (const o of options) {
    const d = Math.abs(o.points - 24), bd = Math.abs(best.points - 24);
    if (d < bd || (d === bd && o.ms > best.ms)) best = o;
  }
  return best.key;
}

export function withinWindow(runs: RunSummary[], key: string, nowMs: number): RunSummary[] {
  const range = RANGES.find((r) => r.key === key) ?? RANGES[3];
  const from = nowMs - range.ms;
  // The run's terminal moment is its start plus its elapsed — `finishedAt` is null
  // on a run the substrate killed, and elapsed is defined as start → terminal.
  return runs.filter((r) => r.terminationCause === "running" || Date.parse(r.startedAt) + r.durations.elapsedMs >= from);
}

/**
 * The template endpoint knows three periods. The smallest that CONTAINS the
 * chosen window keeps the gate-node lines from describing less than the page;
 * the caption names the period it actually got.
 */
export function gatePeriodFor(key: string): MetricPeriod {
  const ms = (RANGES.find((r) => r.key === key) ?? RANGES[3]).ms;
  return ms <= DAY ? "24h" : ms <= 7 * DAY ? "7d" : "30d";
}

const PERIOD_WORDS: Record<MetricPeriod, string> = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };

/** The versions of one workflow that have runs, newest version first, with run counts. */
export function versionsOf(runs: RunSummary[]): { version: number; runs: number }[] {
  const counts = new Map<number, number>();
  for (const r of runs) counts.set(r.templateVersion, (counts.get(r.templateVersion) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([version, n]) => ({ version, runs: n }));
}

/** The version of the most recent run — what the version chooser opens on. */
function latestRunVersion(runs: RunSummary[]): number | null {
  return runs.reduce<RunSummary | null>((best, r) => (best === null || r.startedAt > best.startedAt ? r : best), null)?.templateVersion ?? null;
}

const ALL_VERSIONS = "all";

export function WorkflowRollup() {
  const [loaded, setLoaded] = useState<{ runs: RunSummary[]; details: RunDetail[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  // A version number as a string, or "all". Null until the runs arrive, and reset
  // to the chosen workflow's most recent run whenever the workflow changes.
  const [version, setVersion] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  // Null means "the default for this window". A chosen step survives a range change
  // while it still divides the new window; otherwise the default takes over.
  const [interval, setInterval] = useState<string | null>(null);
  const [gates, setGates] = useState<TemplateMetricsDetail | null>(null);

  useEffect(() => {
    let live = true;
    getRunSummaries()
      .then(async (runs) => {
        const details = await Promise.all(runs.map((r) => getRunDetail(r.runId).catch(() => null)));
        if (!live) return;
        setLoaded({ runs, details: details.filter((d): d is RunDetail => d !== null) });
        setTemplateId((cur) => cur ?? workflowsOf(runs)[0]?.templateId ?? null);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  // The choosers list EVERY workflow and version that has runs, and count the
  // runs inside the window. They were first built from the windowed runs alone,
  // and an empty window then took the workflow and version choosers with it — the
  // founder's screen showed a range picker and nothing to say what it filtered.
  // The choosers stay put across window changes; only their counts move.
  const windowed = loaded === null ? [] : withinWindow(loaded.runs, range, Date.now());
  const windowedIds = new Set(windowed.map((r) => r.runId));
  const choices = (loaded === null ? [] : workflowsOf(loaded.runs))
    .map((c) => ({ ...c, runs: windowed.filter((r) => r.templateId === c.templateId).length }));
  const chosen = choices.find((c) => c.templateId === templateId) ?? choices[0] ?? null;
  const workflowRunsAllTime = chosen === null || loaded === null ? [] : loaded.runs.filter((r) => r.templateId === chosen.templateId);
  const workflowRuns = workflowRunsAllTime.filter((r) => windowedIds.has(r.runId));
  const versions = versionsOf(workflowRunsAllTime)
    .map((v) => ({ ...v, runs: workflowRuns.filter((r) => r.templateVersion === v.version).length }));
  const newest = versions[0]?.version ?? null;
  const defaultVersion = latestRunVersion(workflowRunsAllTime);
  const chosenVersion = version !== null && (version === ALL_VERSIONS || versions.some((v) => String(v.version) === version))
    ? version
    : defaultVersion === null ? ALL_VERSIONS : String(defaultVersion);
  // The endpoint knows "latest" and "all". A chosen version that IS the latest gets
  // the exact scope; anything else widens to every version and is captioned so.
  const gateScope = chosenVersion !== ALL_VERSIONS && Number(chosenVersion) === newest ? "latest" : "all";
  const gatesCoverEveryVersion = chosenVersion !== ALL_VERSIONS && gateScope === "all";
  const gatesPeriod = gatePeriodFor(range);

  // Gate figures are fetched for the CHOSEN template — never the first of several,
  // which would caption one workflow's page with another's gate verdicts.
  const gateTemplate = chosen?.templateId ?? null;
  useEffect(() => {
    setGates(null);
    if (gateTemplate === null) return;
    let live = true;
    getTemplateMetricsDetail(gateTemplate, gatesPeriod, gateScope)
      .then((g) => { if (live) setGates(g); })
      .catch(() => { if (live) setGates(null); });
    return () => { live = false; };
  }, [gateTemplate, gateScope, gatesPeriod]);

  if (failed) return <p style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load runs.</p>;
  if (loaded === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
  if (loaded.runs.length === 0 || chosen === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>No workflow has run yet.</p>;

  // Each range shows how many runs it would hold, so the reader can see where the
  // runs are before choosing — and an empty window is never a surprise.
  const rangeChoices: WorkflowChoice[] = RANGES.map((r) => ({
    templateId: r.key, name: r.label, runs: withinWindow(loaded.runs, r.key, Date.now()).length,
  }));
  const intervals = intervalsFor(range);
  const chosenInterval = interval !== null && intervals.some((i) => i.key === interval) ? interval : defaultIntervalFor(range);
  const intervalChoices: WorkflowChoice[] = intervals.map((i) => ({ templateId: i.key, name: i.label, runs: i.points }));
  const rangeDropdown = (
    <div style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-3)", alignItems: "center" }}>
      <WorkflowDropdown summaries={rangeChoices} value={range} onChange={(k) => setRange(k as RangeKey)} />
      <WorkflowDropdown summaries={intervalChoices} value={chosenInterval} onChange={setInterval} unit={{ one: "point", many: "points" }} />
    </div>
  );

  const runs = chosenVersion === ALL_VERSIONS ? workflowRuns : workflowRuns.filter((r) => String(r.templateVersion) === chosenVersion);
  const runIds = new Set(runs.map((r) => r.runId));
  const details = loaded.details.filter((d) => runIds.has(d.run.runId));
  const versionChoices: WorkflowChoice[] = [
    ...versions.map((v) => ({ templateId: String(v.version), name: `v${v.version}`, runs: v.runs })),
    { templateId: ALL_VERSIONS, name: "All versions", runs: workflowRuns.length },
  ];
  const windowWords = RANGES.find((r) => r.key === range)!.label.replace(/^Last /, "last ");

  return (
    <div style={{ display: "grid", gap: "var(--sp-4)", alignContent: "start" }}>
      <div style={{ display: "flex", gap: "var(--sp-3)", alignItems: "center", flexWrap: "wrap" }}>
        <WorkflowDropdown summaries={choices} value={chosen.templateId}
          onChange={(id) => { setTemplateId(id); setVersion(null); }} />
        <WorkflowDropdown summaries={versionChoices} value={chosenVersion} onChange={setVersion} />
        {rangeDropdown}
      </div>
      {/* Empty window: say exactly what is empty and keep every chooser, so the
          reader can widen the window or change the workflow. Hiding the controls
          that caused the emptiness would leave them with no way out. */}
      {runs.length === 0 ? (
        <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>
          No {chosen.name}{chosenVersion === ALL_VERSIONS ? "" : ` v${chosenVersion}`} runs were active in the {windowWords}.
        </p>
      ) : (
        <Dashboard agg={aggregate({
          runs, details, gates, gatesCoverEveryVersion, gatesPeriod,
          window: { fromMs: Date.now() - RANGES.find((r) => r.key === range)!.ms, toMs: Date.now() },
          intervalMs: intervals.find((i) => i.key === chosenInterval)!.ms,
        })} />
      )}
    </div>
  );
}
