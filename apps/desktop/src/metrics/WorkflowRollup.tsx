import { useEffect, useState } from "react";
import type { RunDetail, RunSummary } from "@orca/contracts";
import { getRunDetail, getRunSummaries } from "../api";
import { formatDuration } from "./interval-bar";
import {
  BarList, Big, CountRow, CumulativeLine, Matrix, Panel, Scatter, SectionHeading, SplitBar, gridStyle,
  type BarItem, type MatrixCell,
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
//   · no breakdown of pauses by kind — `source_kind` is read from a row overwritten as
//                                     the activity advances, so a categorical split is
//                                     confident about a field we know is corrupted
//
// The cumulative spend line is the single exception to "no lines below n=12": each of
// its points is itself a running total, so joining them is what cumulative MEANS
// rather than a trend claim. Its x-axis is run index and must never become a date —
// as a date axis the slope becomes a rate over irregular sampling.

const dur = (ms: number) => formatDuration(ms) ?? "not recorded";
const usd = (v: number) => `$${v.toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const TONE = {
  working: "var(--run)",
  waiting: "var(--accent-2)",
  unseen: "var(--text-4)",
  // Orca stopping a run is not the workflow failing — the Runs list renders that
  // cause neutral for exactly that reason, and red here would contradict it. `stopped`
  // remains for a step that failed while Orca was working, which is the only failure
  // this screen can attribute to the workflow.
  byOrca: "var(--text-3)",
  stopped: "var(--err)",
  live: "var(--accent)",
} as const;

export interface Loaded { runs: RunSummary[]; details: RunDetail[] }
interface StepAgg { usd: number; elapsedMs: number; restarts: number; spans: number }

export function aggregate({ runs, details }: Loaded) {
  const sum = (f: (r: RunSummary) => number) => runs.reduce((a, r) => a + f(r), 0);
  const spans = details.flatMap((d) => d.spans);

  const byStep = new Map<string, StepAgg>();
  for (const s of spans) {
    const e = byStep.get(s.name) ?? { usd: 0, elapsedMs: 0, restarts: 0, spans: 0 };
    e.spans += 1;
    e.usd += s.cost?.usd ?? 0;
    e.elapsedMs += s.elapsedMs ?? 0;
    e.restarts += s.restarts;
    byStep.set(s.name, e);
  }

  const interventions = details.flatMap((d) => d.interventions);
  return {
    runs, details, byStep,
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
    completionsBeyondFirst: sum((r) => r.retriedCompletions),
    completed: runs.filter((r) => r.terminationCause === "completed").length,
    running: runs.filter((r) => r.terminationCause === "running").length,
    stopped: runs.filter((r) => r.terminationCause !== "completed" && r.terminationCause !== "running").length,
    parks: interventions.length,
    parksWithoutReason: interventions.filter((i) => i.sourceKind === "unknown").length,
    silentNodes: sum((r) => r.cost.coverage.silent),
    reportedNodes: sum((r) => r.cost.coverage.reported),
    totalNodes: sum((r) => r.cost.coverage.total),
    awaiting: sum((r) => r.awaitingYou.count),
    longestWaitMs: Math.max(0, ...runs.map((r) => r.awaitingYou.sinceMs ?? 0)),
  };
}

export type Agg = ReturnType<typeof aggregate>;

/**
 * Three tones, not two — because the data distinguishes three things and the app
 * already tells the reader so on another screen.
 *
 * A blocked span on a run the substrate killed is NOT a step that failed on its
 * merits. The Runs list renders that cause in neutral, deliberately: it is a known
 * Orca bug, attributed away from the reader, and red there would be telling him to
 * act on something no action reaches. Rendering the same event red here would give
 * one event two tones on two surfaces two clicks apart — and the surface he sees
 * second would silently overrule the one that got it right.
 *
 * So red is reserved for a step that failed while Orca was working, which is the only
 * kind of failure this screen can attribute to the workflow.
 */
function spanTone(status: string, killedBySubstrate: boolean): string {
  if (status === "passed") return "var(--run)";
  if (status === "running") return "var(--accent)";
  if (status === "blocked" || status === "failed") {
    return killedBySubstrate ? "var(--text-3)" : "var(--err)";
  }
  return "var(--text-4)";
}

/**
 * Runs down, steps across — the densest honest panel available.
 *
 * Seven runs by eight steps is fifty-six cells, every one an observed outcome. It
 * also makes "every run stopped at Triage" visible as a SHAPE rather than as the same
 * sentence repeated down a list, which is the difference between a reader noticing a
 * pattern and a reader being told one.
 */
function RunStepMatrix({ agg }: { agg: Agg }) {
  const columns: string[] = [];
  for (const d of agg.details) for (const s of d.spans) if (!columns.includes(s.name)) columns.push(s.name);
  const rows = agg.details.map((d) => ({
    key: d.run.runId,
    label: d.run.goalTitle,
    sub: `v${d.run.templateVersion} · ${day(d.run.startedAt)}`,
    cells: columns.map((c): MatrixCell | null => {
      const s = d.spans.find((x) => x.name === c);
      if (!s) return null;
      const killed = d.run.terminationCause === "infrastructure_killed";
      return {
        key: s.workflowStepRunId,
        tone: spanTone(s.status, killed),
        title:
          `${c} — ${killed && (s.status === "blocked" || s.status === "failed") ? "stopped by Orca" : s.status}` +
          `, attempt ${s.attempt}${s.elapsedMs ? `, ${dur(s.elapsedMs)}` : ""}`,
      };
    }),
  }));
  if (columns.length === 0) return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>No steps recorded.</span>;
  return <Matrix columns={columns} rows={rows} />;
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
      display: `${fmt(pick(v))} · ${v.spans} ${v.spans === 1 ? "run" : "runs"}`,
      tone,
    }))
    .filter((b) => b.value > 0)
    .sort((a, b) => b.value - a.value);
}

export function Dashboard({ agg }: { agg: Agg }) {
  const n = agg.runs.length;
  const parkedShare = agg.elapsedMs > 0 ? Math.round((agg.parkedMs / agg.elapsedMs) * 100) : 0;
  const rework = agg.failedUsd + agg.supersededUsd;
  const cumulative = [...agg.runs].reverse().reduce<number[]>((acc, r) => {
    acc.push((acc[acc.length - 1] ?? 0) + r.cost.usd);
    return acc;
  }, []);

  return (
    <div style={{ display: "grid", gap: "var(--sp-5)", alignContent: "start" }}>
      {/* A strip, not a section. Open cards deserve the top of the page; a region
          named after the reader's obligations reads as a to-do list. */}
      {agg.awaiting > 0 && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)", flexWrap: "wrap", padding: "var(--sp-2) var(--sp-4)", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 8 }}>
          <span style={{ fontSize: "var(--fs-3)", fontWeight: 600 }}>
            {agg.awaiting} {agg.awaiting === 1 ? "prompt is" : "prompts are"} waiting on you
          </span>
          <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>
            — the oldest for {dur(agg.longestWaitMs)}
          </span>
        </div>
      )}

      {/* Exactly one type size above the grid. If any panel reaches it the headline
          stops being a headline — and the contrast between wall clock and working is
          the thing that lands before a single label is read. */}
      <div style={{ display: "flex", gap: "var(--sp-6)", flexWrap: "wrap", padding: "0 var(--sp-1)" }}>
        <Big value={usd(agg.usd)} label={`spent across ${n} runs`} />
        <Big value={dur(agg.elapsedMs)} label="wall clock" />
        <Big value={dur(agg.workingMs)} label="Orca working" tone={TONE.working} />
        <Big value={`${parkedShare}%`} label="waiting on you" tone={TONE.waiting} />
      </div>

      <div style={gridStyle}>
        <SectionHeading>What happened</SectionHeading>

        <Panel title="Runs by state" span={4}>
          {/* Not "how they ended". A run still in flight has not ended, and placing it
              in a termination partition asserts a terminal outcome about something
              unfinished — so the partition is over STATE, which every run has. */}
          <SplitBar
            total={n}
            parts={[
              { label: "completed", value: agg.completed, display: String(agg.completed), tone: TONE.working },
              { label: "stopped by Orca", value: agg.stopped, display: String(agg.stopped), tone: TONE.byOrca },
              { label: "still running", value: agg.running, display: String(agg.running), tone: TONE.live },
            ].filter((p) => p.value > 0)}
          />
        </Panel>

        <Panel title="Steps across all runs" span={4}>
          <CountRow
            items={[
              { label: "delivered", value: String(agg.delivered) },
              { label: "blocked", value: String(agg.blocked) },
              { label: "relaunched after a crash", value: String(agg.relaunches) },
            ]}
          />
        </Panel>

        <Panel title="Completions beyond the first" span={4}>
          {/* Not "retries". This counts step_complete emissions past the first, and a
              veto-then-pass step emits two of them for ONE attempt — the same noun
              that had a row claiming "attempt 1" and "redone 1x" simultaneously. */}
          <CountRow items={[{ label: "across all runs", value: String(agg.completionsBeyondFirst) }]} />
        </Panel>

        <Panel title="Every run, every step" span={12}>
          <RunStepMatrix agg={agg} />
        </Panel>

        <SectionHeading>Where the time went</SectionHeading>

        <Panel title={`How ${dur(agg.elapsedMs)} of wall clock divides`} span={3}>
          <SplitBar
            total={agg.elapsedMs}
            parts={[
              { label: "Orca working", value: agg.workingMs, display: dur(agg.workingMs), tone: TONE.working },
              { label: "waiting on you", value: agg.parkedMs, display: dur(agg.parkedMs), tone: TONE.waiting },
              { label: "unaccounted", value: agg.unaccountedMs, display: dur(agg.unaccountedMs), tone: TONE.unseen },
            ]}
          />
        </Panel>

        <Panel title="How long each run took, by when it started" span={5}>
          {/* A real over-time chart: both axes are observed. `startedAt` is a
              timestamp and the duration is a measured span, so nothing is derived.
              Unconnected on purpose — seven points joined is the trend claim refused
              everywhere else — and date-spaced rather than index-spaced because the
              clustering is real information: three runs in one evening and then a
              five-day gap is a fact about how this gets used. */}
          <Scatter
            points={agg.runs.map((r) => ({
              at: new Date(r.startedAt).getTime(),
              value: r.durations.elapsedMs,
              open: r.durations.accruing,
              title: `${r.goalTitle} · ${day(r.startedAt)} · ${dur(r.durations.elapsedMs)}${r.durations.accruing ? " and counting" : ""}`,
            }))}
          />
          <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            {day(agg.runs[agg.runs.length - 1]!.startedAt)} — {day(agg.runs[0]!.startedAt)} · a hollow dot is still running, so its height is not final
          </span>
        </Panel>

        <Panel title="Time by step, this window" span={4}>
          <BarList items={stepBars(agg, (v) => v.elapsedMs, dur, TONE.waiting)} />
        </Panel>

        <SectionHeading>Where the money went</SectionHeading>

        <Panel title="Spend by step, this window" span={5}>
          <BarList items={stepBars(agg, (v) => v.usd, usd)} />
        </Panel>

        <Panel title="Spend per run, newest first" span={4}>
          {/* Keyed and labelled by run, not by goal: two runs share the title
              "Enable AI", which collided as a React key AND showed the reader one name
              with two different figures. The Runs list already solves this with a date. */}
          <BarList
            items={agg.runs.map((r) => ({
              key: r.runId,
              label: `${r.goalTitle} · ${day(r.startedAt)}`,
              value: r.cost.usd,
              display: usd(r.cost.usd),
            }))}
          />
        </Panel>

        <Panel title="Cumulative spend, runs in order" span={3}>
          <CumulativeLine values={cumulative} />
          <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            {n} runs · {usd(agg.usd)} total
          </span>
        </Panel>

        <Panel title="Spend that produced nothing kept" span={12}>
          <SplitBar
            total={agg.usd}
            parts={[
              { label: "on attempts that failed", value: agg.failedUsd, display: usd(agg.failedUsd), tone: TONE.stopped },
              { label: "on work that was replaced", value: agg.supersededUsd, display: usd(agg.supersededUsd), tone: "var(--warn)" },
              { label: "on work that was kept", value: Math.max(0, agg.usd - rework), display: usd(Math.max(0, agg.usd - rework)), tone: TONE.working },
            ]}
          />
        </Panel>

        <SectionHeading>What we couldn&apos;t see</SectionHeading>

        <Panel title="Cost coverage" span={4}>
          {/* Two populations, and they are not the same one. `silent` spans emit no
              completion at all, so they are absent from `reported`/`total` rather than
              counted as unreported — which made "23 of 25" sit beside "6" and read as
              29 of 25. The whole they belong to is stated so both can be placed. */}
          <CountRow
            items={[
              { label: "of the nodes that can report, did", value: `${agg.reportedNodes} of ${agg.totalNodes}` },
              { label: "more reported nothing at all", value: String(agg.silentNodes), tone: agg.silentNodes > 0 ? TONE.stopped : undefined },
            ]}
          />
          <span style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            {agg.totalNodes + agg.silentNodes} nodes ran in total.
          </span>
        </Panel>

        <Panel title="Time we cannot account for" span={4}>
          <Big value={dur(agg.unaccountedMs)} size="var(--fs-5)" label={`of ${dur(agg.elapsedMs)} wall clock`} tone={TONE.unseen} />
        </Panel>

        <Panel title="Pauses" span={4}>
          {/* Two numbers rather than a breakdown by cause. `source_kind` is read from a
              row overwritten as the activity advances, so a categorical split would be
              confident about a corrupted field — and the corrupted rows are the ones
              that look fine, showing another pause kind instead of falling through to
              "unknown". */}
          <CountRow
            items={[
              { label: "pauses recorded", value: String(agg.parks) },
              { label: "with no reliable reason", value: String(agg.parksWithoutReason) },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}

export function WorkflowRollup() {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getRunSummaries()
      .then(async (runs) => {
        const details = await Promise.all(runs.map((r) => getRunDetail(r.runId).catch(() => null)));
        if (live) setData({ runs, details: details.filter((d): d is RunDetail => d !== null) });
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed) return <p style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load runs.</p>;
  if (data === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
  if (data.runs.length === 0) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>No workflow has run yet.</p>;

  return <Dashboard agg={aggregate(data)} />;
}
