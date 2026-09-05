import { useEffect, useState } from "react";
import type { RunDetail, RunSummary, TemplateMetricsDetail } from "@orca/contracts";
import { getRunDetail, getRunSummaries, getTemplateMetricsDetail } from "../api";
import { formatDuration } from "./interval-bar";
import { terminatedRuns } from "./RunLedger";
import {
  BarList, Big, CountRow, CoverageMatrix, Donut, Panel, SectionHeading, StackedRows, gridStyle,
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
//   · no breakdown of pauses by kind — `source_kind` is read from a row overwritten as
//                                     the activity advances, so a categorical split is
//                                     confident about a field we know is corrupted

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

export function aggregate({ runs, details, gates = null }: Loaded) {
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
    runs, ended, details, byStep, gates,
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

        <SectionHeading>How well we know it worked</SectionHeading>

        {(() => {
          const c = coverage(agg);
          return (
            <>
              <Panel title="What the gates decided" span={4}>
                {agg.gates === null
                  ? <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Gate figures aren&apos;t available for this window.</span>
                  : (
                    <>
                      <Donut
                        caption="completions"
                        parts={[
                          { label: "upheld", value: agg.gates.completionGate.verdictDist.upheld, display: String(agg.gates.completionGate.verdictDist.upheld), tone: TONE.working },
                          { label: "sent back — no evidence", value: agg.gates.completionGate.verdictDist.evidence_veto, display: String(agg.gates.completionGate.verdictDist.evidence_veto), tone: TONE.stopped },
                          { label: "sent back — reviewer", value: agg.gates.completionGate.verdictDist.refute_veto, display: String(agg.gates.completionGate.verdictDist.refute_veto), tone: "var(--warn)" },
                          { label: "escalated", value: agg.gates.completionGate.verdictDist.escalated, display: String(agg.gates.completionGate.verdictDist.escalated), tone: TONE.live },
                        ]}
                      />
                      {/* These panels are adjacent and nearly describe the same
                          population — but not quite, and the totals agreeing is a
                          coincidence rather than a check. The matrix counts every
                          completed span in the window the run list returns; this panel
                          counts verdicts from the template endpoint's own 30-day period.
                          Three completed spans fall outside that period, so the two 17s
                          are different sets with the same size. The first draft of this
                          line claimed they were the same completions — a caption written
                          to prevent a false inference, which was itself the false one,
                          and undetectable precisely because the numbers matched. */}
                      <p style={{ margin: 0, fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
                        Every step completion is judged here. Counted over the last 30 days, so this is a
                        different window from the matrix beside it — the two totals are not the same set.
                      </p>
                      <div style={{ paddingTop: "var(--sp-2)", borderTop: "1px solid var(--hairline)", display: "grid", gap: "var(--sp-1)" }}>
                        {/* The gate NODES and the splitter, as lines rather than panels.
                            A gate node's performance is the one thing this window cannot
                            show — they recorded nothing — so a performance panel for them
                            would be a panel about our own blind spot. And a deterministic
                            splitter forwards an upstream field: there is no routing choice
                            to score, which is an absence of a decision rather than a gap
                            in measurement. */}
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
                      </div>
                    </>
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
                {agg.gates === null
                  ? <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Not available for this window.</span>
                  : (
                    <>
                      {/* Bars rather than a ring: the zeros are the finding, and a ring
                          drops a zero slice entirely. An empty track says "never happened"
                          where a missing arc says nothing at all. */}
                      <BarList
                        tone={TONE.stopped}
                        scaleTo={Object.values(agg.gates.policyGateway.decisionDist).reduce((a, b) => a + b, 0)}
                        items={[
                          { label: "denied outright", value: agg.gates.policyGateway.decisionDist.deny, display: String(agg.gates.policyGateway.decisionDist.deny) },
                          { label: "sent to you to approve", value: agg.gates.policyGateway.decisionDist.require_approval, display: String(agg.gates.policyGateway.decisionDist.require_approval) },
                          { label: "allowed", value: agg.gates.policyGateway.decisionDist.allow, display: String(agg.gates.policyGateway.decisionDist.allow) },
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
                    </>
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
        // One call per DISTINCT template, and only when the window holds exactly one —
        // see the note on `Loaded.gates`. Fetching the first of several would silently
        // caption a cross-run page with one template's gate figures.
        const templates = [...new Set(runs.map((r) => r.templateId))];
        const gates = templates.length === 1
          ? await getTemplateMetricsDetail(templates[0]!, "30d", "all").catch(() => null)
          : null;
        if (live) setData({ runs, details: details.filter((d): d is RunDetail => d !== null), gates });
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed) return <p style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load runs.</p>;
  if (data === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
  if (data.runs.length === 0) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>No workflow has run yet.</p>;

  return <Dashboard agg={aggregate(data)} />;
}
